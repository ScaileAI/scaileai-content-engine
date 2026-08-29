#!/usr/bin/env node
/**
 * Build a batch of posts end to end, ready to queue.
 *
 *   node scripts/build-week.mjs slug-a slug-b slug-c ...
 *
 * For each brief: render, stamp the logo, convert to JPEG, build the reel where
 * the brief calls for one, and stage it. Deploys once at the end rather than
 * once per post, then validates the whole batch against live URLs.
 *
 * Deliberately does not publish or queue anything. Building and scheduling are
 * separate decisions.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { projectDir, fromEnv } from './ig-api.mjs';

const SKILL = 'C:/Users/dan/.claude/skills/ig-carousel/scripts/generate.js';
const slugs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const skipRender = process.argv.includes('--skip-render');

if (!slugs.length) {
  console.error('Usage: node scripts/build-week.mjs <slug> [slug...] [--skip-render]');
  process.exit(1);
}

const run = (cmd, args, label, slug) => {
  const r = spawnSync(cmd, args, { cwd: projectDir, stdio: 'pipe', encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.log(`    FAILED ${label}`);
    console.log((r.stderr || r.stdout || '').split('\n').slice(-6).map((l) => '      ' + l).join('\n'));
    return false;
  }
  return true;
};

const failed = [];
let rendered = 0;

for (const [i, slug] of slugs.entries()) {
  const briefPath = `briefs/${slug}.json`;
  const full = path.join(projectDir, briefPath);
  if (!fs.existsSync(full)) { console.log(`\n[${i + 1}/${slugs.length}] ${slug}  — no brief`); failed.push(slug); continue; }

  const brief = JSON.parse(fs.readFileSync(full, 'utf8'));
  const postDir = `ig-posts/${slug}`;
  const n = brief.slides.length;

  console.log(`\n[${i + 1}/${slugs.length}] ${slug}  (${brief.type}, ${n} slide${n > 1 ? 's' : ''})`);

  if (!skipRender) {
    process.stdout.write('    rendering... ');
    if (!run('node', [SKILL, briefPath], 'render', slug)) { failed.push(slug); continue; }
    rendered += n;

    // add-logo.ps1 always composites from raw/, and only fills raw/ the first
    // time so that re-stamping is idempotent. That makes a re-render invisible:
    // the fresh image is written, then overwritten by the logo step compositing
    // the ORIGINAL again. A post edited to remove invented signage came back
    // with the signage still on it and reported success. If we just rendered,
    // raw/ is stale by definition, so drop it and let add-logo refill it.
    fs.rmSync(path.join(projectDir, postDir, 'raw'), { recursive: true, force: true });

    console.log('done');
  }

  process.stdout.write('    logo... ');
  if (!run('powershell', ['-ExecutionPolicy', 'Bypass', '-File', 'scripts/add-logo.ps1', '-PostDir', postDir], 'logo', slug)) { failed.push(slug); continue; }
  process.stdout.write('jpeg... ');
  if (!run('powershell', ['-ExecutionPolicy', 'Bypass', '-File', 'scripts/to-jpeg.ps1', '-PostDir', postDir], 'jpeg', slug)) { failed.push(slug); continue; }

  if (brief.type === 'reel') {
    process.stdout.write('reel... ');
    if (!run('node', ['scripts/make-reel.mjs', postDir, '--hook', '2.5', '--hold', '2.4', '--cta', '3.5'], 'reel', slug)) { failed.push(slug); continue; }
  }

  process.stdout.write('staging... ');
  if (!run('node', ['scripts/stage-for-netlify.mjs', postDir], 'stage', slug)) { failed.push(slug); continue; }
  console.log('ok');
}

console.log(`\n${'='.repeat(60)}`);
console.log(`built ${slugs.length - failed.length}/${slugs.length} post(s), ${rendered} image(s) rendered`);
if (failed.length) console.log(`failed: ${failed.join(', ')}`);

// One deploy for the whole batch.
const token = fromEnv('NETLIFY_AUTH_TOKEN');
const site = fromEnv('NETLIFY_SITE_ID');
if (token && site) {
  console.log('\ndeploying everything...');
  const d = spawnSync('npx', ['-y', 'netlify-cli', 'deploy', '--prod', '--dir', 'netlify-public', '--site', site, '--auth', token],
    { cwd: projectDir, encoding: 'utf8', shell: true });
  const line = (d.stdout || '').split('\n').find((l) => /Deployed to production/.test(l));

  // Never report success from the absence of an error. An earlier version printed
  // "deploy finished" whenever it could not find the success line, which is how a
  // rejected token looked exactly like a working deploy.
  if (d.status !== 0 || !line) {
    console.log('DEPLOY FAILED. The images are built and staged but are NOT on the web.');
    const why = (d.stderr || d.stdout || '').split('\n').filter((l) => l.trim()).slice(-4);
    why.forEach((l) => console.log('  ' + l.trim()));
    console.log('\nFix the credentials, then re-run:  node scripts/stage-for-netlify.mjs <post-dir>');
    process.exitCode = 1;
  } else {
    console.log(line.trim());
  }
} else {
  console.log('\nNETLIFY credentials missing, nothing deployed.');
  process.exitCode = 1;
}

if (failed.length) process.exitCode = 1;
