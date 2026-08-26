#!/usr/bin/env node
/**
 * One command, whole carousel: render -> convert -> stage -> deploy -> publish.
 *
 *   node scripts/post.mjs briefs/my-brief.json                 the lot
 *   node scripts/post.mjs briefs/my-brief.json --dry-run       prompts only, costs nothing
 *   node scripts/post.mjs briefs/my-brief.json --no-publish    everything except posting
 *   node scripts/post.mjs briefs/my-brief.json --skip-render   reuse slides already rendered
 *
 * Uploading needs two lines in .env. Without them the run stops after staging and
 * tells you to drag the folder by hand:
 *   NETLIFY_AUTH_TOKEN=...
 *   NETLIFY_SITE_ID=...
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { projectDir, fromEnv } from './ig-api.mjs';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const skipRender = argv.includes('--skip-render');
const noPublish = argv.includes('--no-publish');
const briefPath = argv.find((a) => !a.startsWith('--'));

if (!briefPath) {
  console.error('Usage: node scripts/post.mjs <brief.json> [--dry-run] [--no-publish] [--skip-render]');
  process.exit(1);
}

const brief = JSON.parse(fs.readFileSync(path.resolve(projectDir, briefPath), 'utf8').replace(/^\uFEFF/, ''));
const slug = brief.slug;
const postDir = `ig-posts/${slug}`;
const SKILL = 'C:/Users/dan/.claude/skills/ig-carousel/scripts/generate.js';

let step = 0;
const banner = (msg) => {
  const bar = '='.repeat(64);
  console.log(`\n${bar}\n  STEP ${++step}: ${msg}\n${bar}`);
};

/** Run a command, streaming its output. Stops everything if it fails. */
function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { cwd: projectDir, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`\n${label} failed. Stopping so nothing half-finished gets published.`);
    process.exit(1);
  }
}

// 1. Render the slides as images.
if (!skipRender) {
  banner(dryRun ? 'Writing prompts (no images, no cost)' : 'Rendering slides with gpt-image-2');
  run('node', [SKILL, briefPath, ...(dryRun ? ['--dry-run'] : [])], 'Rendering');
} else {
  banner('Skipping render, reusing existing slides');
}

if (dryRun) {
  console.log('\nDry run finished. Prompts written, nothing rendered, nothing published.');
  process.exit(0);
}

// Validate before spending anything further. A brief that fails the checks
// should not reach the logo step, let alone the feed.
banner('Validating the brief');
run('node', ['engine/validate.mjs', briefPath], 'Validation');

// 2. Stamp the real logo on. The model is forbidden from drawing one, so this is
// the only place it can come from.
banner('Adding the ScaileAI logo');
run('powershell', ['-ExecutionPolicy', 'Bypass', '-File', 'scripts/add-logo.ps1', '-PostDir', postDir], 'Logo');

// 3. Instagram rejects PNG, so convert.
banner('Converting to JPEG for the Instagram API');
run('powershell', ['-ExecutionPolicy', 'Bypass', '-File', 'scripts/to-jpeg.ps1', '-PostDir', postDir], 'Conversion');

// 3. Collect into the folder that gets published to the web.
banner('Staging files for the web');
run('node', ['scripts/stage-for-netlify.mjs', postDir], 'Staging');

// 4. Put them on the internet, because the API fetches images by URL.
const NETLIFY_TOKEN = fromEnv('NETLIFY_AUTH_TOKEN');
const NETLIFY_SITE = fromEnv('NETLIFY_SITE_ID');
const base = `${(fromEnv('IG_BASE_URL') || '').replace(/\/+$/, '')}/${slug}`;

if (NETLIFY_TOKEN && NETLIFY_SITE) {
  banner('Deploying to Netlify');
  run(
    'npx',
    ['-y', 'netlify-cli', 'deploy', '--prod', '--dir', 'netlify-public', '--site', NETLIFY_SITE, '--auth', NETLIFY_TOKEN],
    'Netlify deploy',
  );
} else {
  banner('Deploy step SKIPPED');
  console.log('NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID are not set in .env, so this run');
  console.log('cannot upload for you. Drag netlify-public onto your site, then run:');
  console.log(`  node scripts/publish-instagram.mjs ${postDir} --base-url ${base}`);
  process.exit(0);
}

// 5. Never publish a post whose images are not actually reachable.
banner('Checking the images are live');

const slides = fs.readdirSync(path.join(projectDir, postDir, 'jpeg')).filter((f) => f.endsWith('.jpg')).sort();
let live = 0;
for (const f of slides) {
  const res = await fetch(`${base}/${f}`, { method: 'HEAD' }).catch(() => null);
  const ok = Boolean(res?.ok) && (res.headers.get('content-type') || '').includes('image');
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${f}`);
  if (ok) live++;
}
if (live !== slides.length) {
  console.error(`\nOnly ${live}/${slides.length} images are reachable. Not publishing a broken post.`);
  process.exit(1);
}

if (noPublish) {
  console.log('\n--no-publish set. Every step worked, nothing was posted.');
  console.log('The images are live and verified. To publish, run:');
  console.log(`  node scripts/publish-instagram.mjs ${postDir} --base-url ${base}`);
  process.exit(0);
}

banner('Publishing to Instagram');
run('node', ['scripts/publish-instagram.mjs', postDir, '--base-url', base], 'Publishing');
