#!/usr/bin/env node
/**
 * Gate a post before it can be queued.
 *
 *   node engine/validate.mjs briefs/office-hours.json
 *   node engine/validate.mjs --all            every brief with rendered output
 *
 * Removing the human review step means the checks have to be mechanical. Nothing
 * should enter the queue that has not passed all of these.
 *
 * The checks exist because each one has already gone wrong at least once:
 *
 *   structure   a malformed brief renders a broken slide
 *   banned      house-style words creeping into copy
 *   numbers     an unsourced statistic went out on the first carousel
 *   cta         a footer promising a guide that did not exist yet
 *   logo        the compositing step being skipped
 *   media       a post pointing at files that were never deployed
 *   duplicate   the same idea posted twice within a month
 *
 * Exits non-zero if anything fails, so it can gate a queue commit.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const engineDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(engineDir, '..');
const facts = JSON.parse(fs.readFileSync(path.join(engineDir, 'cleared-facts.json'), 'utf8'));

const argv = process.argv.slice(2);
const all = argv.includes('--all');
const target = argv.find((a) => !a.startsWith('--'));

if (!target && !all) {
  console.error('Usage: node engine/validate.mjs <brief.json> | --all');
  process.exit(1);
}

// ── reporting ─────────────────────────────────────────────────────────────────

let failures = 0;
let warnings = 0;

const pass = (check, detail = '') => console.log(`  PASS  ${check}${detail ? '  ' + detail : ''}`);
const fail = (check, detail) => { failures++; console.log(`  FAIL  ${check}  ${detail}`); };
const warn = (check, detail) => { warnings++; console.log(`  WARN  ${check}  ${detail}`); };

// ── the checks ────────────────────────────────────────────────────────────────

/** Everything a slide renders, as one searchable list of strings. */
function allText(brief) {
  const out = [];
  for (const s of brief.slides || []) {
    for (const h of s.headline || []) out.push(h.text);
    if (s.subtitle) out.push(s.subtitle);
    if (s.annotation) out.push(s.annotation);
    for (const b of s.bullets || []) out.push(b);
    if (s.ctaWord) out.push(s.ctaWord);
    if (s.ctaPromise) out.push(s.ctaPromise);
  }
  if (brief.caption) out.push(brief.caption);
  return out;
}

function checkStructure(brief) {
  const slides = brief.slides || [];
  if (!brief.slug) return fail('structure', 'no slug');
  if (slides.length === 0) return fail('structure', 'no slides');

  const problems = [];
  slides.forEach((s, i) => {
    const n = i + 1;
    const lines = s.headline || [];
    if (lines.length === 0) problems.push(`slide ${n}: no headline`);
    if (lines.length > 3) problems.push(`slide ${n}: ${lines.length} headline lines, max 3`);
    const accents = lines.filter((l) => l.accent).length;
    if (accents > 1) problems.push(`slide ${n}: ${accents} accent lines, exactly 1 expected`);
    const words = lines.reduce((t, l) => t + l.text.trim().split(/\s+/).length, 0);
    if (words > 9) problems.push(`slide ${n}: headline is ${words} words, max 9`);
    if (s.bullets && s.bullets.length !== 3) problems.push(`slide ${n}: ${s.bullets.length} bullets, 3 expected`);
    if (!s.scene) problems.push(`slide ${n}: no scene`);
  });

  if (problems.length) fail('structure', problems.join('; '));
  else pass('structure', `${slides.length} slide(s)`);
}

function checkBanned(brief) {
  const hits = [];
  const haystack = allText(brief).join('\n').toLowerCase();
  for (const phrase of facts.bannedPhrases) {
    if (haystack.includes(phrase.toLowerCase())) hits.push(phrase);
  }
  // House style: no exclamation marks, no em dashes.
  if (haystack.includes('!')) hits.push('exclamation mark');
  if (haystack.includes('—')) hits.push('em dash');

  if (hits.length) fail('banned', hits.join(', '));
  else pass('banned');
}

function checkNumbers(brief) {
  const cleared = facts.allowed.map((a) => a.pattern.toLowerCase());
  const suspect = [];

  for (const text of allText(brief)) {
    // Any run containing a digit, plus spelled-out quantities that read as claims.
    const candidates = text.match(/\$?\d[\d,.]*%?/g) || [];
    for (const c of candidates) {
      const lower = c.toLowerCase();
      const ok = cleared.some((p) => lower === p || lower.includes(p) || p.includes(lower));
      // A bare small number inside prose is usually list ordering, not a claim.
      const isListMarker = /^\d\.$/.test(c) || /^[1-9]$/.test(c);
      if (!ok && !isListMarker) suspect.push(`"${c}" in "${text.slice(0, 50)}${text.length > 50 ? '…' : ''}"`);
    }
  }

  if (suspect.length) {
    // A number is not automatically wrong; it is unproven. That is a stop, not a
    // crash, so it is a warning the author has to clear deliberately.
    warn('numbers', `${suspect.length} unsourced: ${suspect.slice(0, 3).join(' | ')}${suspect.length > 3 ? ' …' : ''}`);
  } else {
    pass('numbers', 'all figures traced to cleared facts');
  }
}

function checkCta(brief) {
  const footers = new Set([brief.footerCta, ...(brief.slides || []).map((s) => s.footerCta)].filter(Boolean));
  const problems = [];

  for (const f of footers) {
    if (!facts.footerCtas.includes(f)) problems.push(`"${f}" is not in the approved footer list`);
    // A footer naming a keyword must point at an asset that exists.
    const kw = (f.match(/\b(AI|QUOTE|DISPATCH|SPEED)\b/) || [])[1];
    if (kw && !facts.liveAssets[kw]) problems.push(`footer promises ${kw} but no live asset is registered for it`);
  }

  for (const s of brief.slides || []) {
    if (s.ctaWord && !facts.liveAssets[s.ctaWord.toUpperCase()]) {
      problems.push(`ctaWord ${s.ctaWord} has no live asset`);
    }
  }

  if (problems.length) fail('cta', problems.join('; '));
  else pass('cta', footers.size ? [...footers].join(', ') : 'default footer');
}

function checkLogo(brief) {
  const dir = path.join(repoDir, 'ig-posts', brief.slug);
  if (!fs.existsSync(dir)) return warn('logo', 'not rendered yet');

  const slides = fs.readdirSync(dir).filter((f) => /^slide-\d+\.png$/.test(f));
  if (!slides.length) return warn('logo', 'no rendered slides');

  // A post already on the feed cannot be changed. Reporting it as a failure
  // forever teaches people to ignore failures, which is worse than the miss.
  const historic = Boolean(brief.publishedAt);
  const report = historic
    ? (c, d) => warn(c, `${d} (published ${brief.publishedAt}, cannot be changed)`)
    : fail;

  const raw = path.join(dir, 'raw');
  if (!fs.existsSync(raw)) return report('logo', 'no raw/ folder, so the logo step never ran');

  const missing = slides.filter((f) => {
    const stamped = path.join(dir, f);
    const original = path.join(raw, f);
    if (!fs.existsSync(original)) return true;
    // Compositing changes bytes. Identical files mean the logo was not applied.
    return fs.statSync(stamped).size === fs.statSync(original).size;
  });

  if (missing.length) report('logo', `not stamped on: ${missing.join(', ')}`);
  else pass('logo', `${slides.length} slide(s) stamped`);
}

async function checkMedia(brief) {
  const base = (process.env.IG_BASE_URL || 'https://scaileaiinsta.netlify.app').replace(/\/+$/, '');
  const dir = path.join(repoDir, 'ig-posts', brief.slug);
  const isReel = brief.type ? brief.type === 'reel' : fs.existsSync(path.join(dir, 'reel.mp4'));
  const count = (brief.slides || []).length;

  const urls = isReel
    ? [`${base}/${brief.slug}/reel.mp4`]
    : Array.from({ length: count }, (_, i) => `${base}/${brief.slug}/slide-${String(i + 1).padStart(2, '0')}.jpg`);

  const bad = [];
  for (const u of urls) {
    const res = await fetch(u, { method: 'HEAD' }).catch(() => null);
    const type = res?.headers.get('content-type') || '';
    if (!res?.ok || !/^(image|video)\//.test(type)) bad.push(`${u.split('/').pop()} (${res?.status || 'no response'})`);
  }

  if (bad.length) fail('media', `not deployed: ${bad.join(', ')}`);
  else pass('media', `${urls.length} asset(s) live`);
}

function checkDuplicate(brief) {
  const postsDir = path.join(engineDir, 'posts');
  if (!fs.existsSync(postsDir)) return pass('duplicate', 'nothing to compare against');

  const words = (s) => new Set(String(s).toLowerCase().match(/[a-z]{5,}/g) || []);
  const mine = words(brief.caption);
  if (mine.size === 0) return pass('duplicate', 'no caption to compare');

  const close = [];
  for (const slug of fs.readdirSync(postsDir)) {
    if (slug === brief.slug) continue;
    const f = path.join(postsDir, slug, 'caption.txt');
    if (!fs.existsSync(f)) continue;
    const theirs = words(fs.readFileSync(f, 'utf8'));
    const shared = [...mine].filter((w) => theirs.has(w)).length;
    const overlap = shared / Math.min(mine.size, theirs.size);
    if (overlap > 0.55) close.push(`${slug} (${Math.round(overlap * 100)}% shared vocabulary)`);
  }

  if (close.length) warn('duplicate', `very similar to ${close.join(', ')}`);
  else pass('duplicate');
}

// ── run ───────────────────────────────────────────────────────────────────────

const briefs = all
  ? fs.readdirSync(path.join(repoDir, 'briefs')).filter((f) => f.endsWith('.json') && !f.startsWith('_')).map((f) => `briefs/${f}`)
  : [target];

for (const b of briefs) {
  const full = path.resolve(repoDir, b);
  if (!fs.existsSync(full)) { console.log(`\n${b}\n  FAIL  brief not found`); failures++; continue; }
  const brief = JSON.parse(fs.readFileSync(full, 'utf8').replace(/^﻿/, ''));

  console.log(`\n${brief.slug}`);
  checkStructure(brief);
  checkBanned(brief);
  checkNumbers(brief);
  checkCta(brief);
  checkLogo(brief);
  await checkMedia(brief);
  checkDuplicate(brief);
}

console.log(`\n${failures} failure(s), ${warnings} warning(s)`);
if (failures) {
  console.log('Do not queue a post with failures.');
  // exitCode rather than exit(): letting Node drain outstanding handles avoids a
  // shutdown crash on Windows that masks the real status and would break gating.
  process.exitCode = 1;
}
if (warnings) console.log('Warnings need a human decision, not an automatic pass.');
