#!/usr/bin/env node
/**
 * Publish a rendered carousel to Instagram via the Content Publishing API.
 *
 *   node scripts/publish-instagram.mjs <post-dir> --base-url https://host/path [--dry-run]
 *
 * Expects <post-dir>/jpeg/slide-NN.jpg to exist and to be served publicly at
 * <base-url>/slide-NN.jpg. The API fetches those URLs itself, so they must be
 * reachable from the internet, not just from this machine.
 *
 * Credentials come from .env, never the command line, so tokens stay out of
 * shell history:
 *   IG_USER_ID=...
 *   IG_ACCESS_TOKEN=...
 *   IG_API_HOST=instagram   (optional: skips host auto-detection)
 *
 * Node 18+. No dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { projectDir, IG_GRAPH, fromEnv, detectHost, apiGet, apiPost } from './ig-api.mjs';

// ── args ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const postDir = argv.find((a) => !a.startsWith('--'));
const baseIdx = argv.indexOf('--base-url');
const baseUrl = (baseIdx !== -1 ? argv[baseIdx + 1] || '' : '').replace(/\/+$/, '');

if (!postDir || !baseUrl) {
  console.error('Usage: node scripts/publish-instagram.mjs <post-dir> --base-url <url> [--dry-run]');
  process.exit(1);
}

// ── inputs ────────────────────────────────────────────────────────────────────

const dir = path.resolve(projectDir, postDir);
const jpegDir = path.join(dir, 'jpeg');

if (!fs.existsSync(jpegDir)) {
  console.error(`No jpeg/ folder in ${dir}.`);
  console.error(`Run: powershell -ExecutionPolicy Bypass -File scripts/to-jpeg.ps1 -PostDir "${postDir}"`);
  process.exit(1);
}

const slides = fs.readdirSync(jpegDir).filter((f) => /^slide-\d+\.jpg$/i.test(f)).sort();

// A reel is a single reel.mp4 in the post folder. It takes priority: when one
// exists this post is a reel, and any slides are only the frames it was built from.
const reelFile = fs.existsSync(path.join(dir, 'reel.mp4')) ? 'reel.mp4' : null;

if (slides.length === 0 && !reelFile) {
  console.error(`No slide-NN.jpg files in ${jpegDir}, and no reel.mp4 in ${dir}.`);
  process.exit(1);
}
if (slides.length > 10) {
  console.error(`A carousel takes at most 10 items, found ${slides.length}.`);
  process.exit(1);
}

const captionFile = path.join(dir, 'caption.txt');
const caption = fs.existsSync(captionFile) ? fs.readFileSync(captionFile, 'utf8').trim() : '';

const urls = slides.map((f) => `${baseUrl}/${f}`);

console.log(`${path.basename(dir)}: ${reelFile ? 'reel' : `${slides.length} slides`}`);
console.log(`base url: ${baseUrl}\n`);

if (dryRun) {
  console.log('DRY RUN, nothing published.\n');
  if (reelFile) console.log(`  REEL  ${baseUrl}/${reelFile}`);
  else urls.forEach((u, i) => console.log(`  ${String(i + 1).padStart(2, '0')}  ${u}`));
  console.log(`\ncaption: ${caption ? `${caption.split('\n')[0].slice(0, 60)}...` : 'NONE'}`);
  console.log('\nCheck every URL above loads in a browser before publishing for real.');
  process.exit(0);
}

// ── auth ──────────────────────────────────────────────────────────────────────

const TOKEN = fromEnv('IG_ACCESS_TOKEN');

if (!TOKEN) {
  console.error(`Missing IG_ACCESS_TOKEN in ${path.join(projectDir, '.env')}`);
  process.exit(1);
}

const host = await detectHost(TOKEN);

// An Instagram Login token already identifies its own account, so "me" stands in for
// the id. A Facebook Login token can see several accounts, so there it must be explicit.
const IG_USER_ID = fromEnv('IG_USER_ID') || (host === IG_GRAPH ? 'me' : null);

if (!IG_USER_ID) {
  console.error('This is a Facebook Login token, which can see multiple accounts.');
  console.error('Set IG_USER_ID in .env. Run: node scripts/ig-whoami.mjs');
  process.exit(1);
}
console.log(`api host: ${host}${host === IG_GRAPH ? '  (Instagram Login)' : '  (Facebook Login)'}\n`);

/** Containers process asynchronously. Publishing before FINISHED fails. */
async function waitForContainer(id, label, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const json = await apiGet(host, `${id}?fields=status_code,status&access_token=${TOKEN}`).catch(() => ({}));
    if (json.status_code === 'FINISHED') return;
    if (json.status_code === 'ERROR' || json.status_code === 'EXPIRED') {
      throw new Error(`${label} container ${json.status_code}: ${json.status || 'no detail'}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${label} container did not finish within 60s`);
}

// ── run ───────────────────────────────────────────────────────────────────────

// Reels are a third media type. Video containers take much longer to process than
// images, so this waits considerably longer before giving up.
if (reelFile) {
  const videoUrl = `${baseUrl}/${reelFile}`;
  console.log(`  reel -> ${videoUrl}`);
  const { id } = await apiPost(
    host,
    `${IG_USER_ID}/media`,
    { media_type: 'REELS', video_url: videoUrl, ...(caption ? { caption } : {}) },
    TOKEN,
  );
  await waitForContainer(id, 'reel', 90);
  const { id: reelId } = await apiPost(host, `${IG_USER_ID}/media_publish`, { creation_id: id }, TOKEN);
  console.log(`\npublished: ${reelId}`);
  try {
    const m = await apiGet(host, `${reelId}?fields=permalink&access_token=${TOKEN}`);
    if (m.permalink) console.log(`permalink: ${m.permalink}`);
  } catch { /* the reel is live regardless */ }
  process.exit(0);
}

// A single image is not a carousel: one container, published directly. Wrapping one
// image in a CAROUSEL container is rejected by the API.
if (urls.length === 1) {
  const { id } = await apiPost(host, `${IG_USER_ID}/media`, { image_url: urls[0], ...(caption ? { caption } : {}) }, TOKEN);
  await waitForContainer(id, 'image');
  console.log(`  single image -> container ${id}`);
  const { id: singleId } = await apiPost(host, `${IG_USER_ID}/media_publish`, { creation_id: id }, TOKEN);
  console.log(`
published: ${singleId}`);
  try {
    const m = await apiGet(host, `${singleId}?fields=permalink&access_token=${TOKEN}`);
    if (m.permalink) console.log(`permalink: ${m.permalink}`);
  } catch { /* the post is live regardless */ }
  process.exit(0);
}

// Step 1. One container per image.
const children = [];
for (const [i, url] of urls.entries()) {
  const { id } = await apiPost(host, `${IG_USER_ID}/media`, { image_url: url, is_carousel_item: 'true' }, TOKEN);
  await waitForContainer(id, `slide ${i + 1}`);
  children.push(id);
  console.log(`  slide ${String(i + 1).padStart(2, '0')} -> container ${id}`);
}

// Step 2. Group them, in order, into the carousel.
const { id: carouselId } = await apiPost(
  host,
  `${IG_USER_ID}/media`,
  { media_type: 'CAROUSEL', children: children.join(','), ...(caption ? { caption } : {}) },
  TOKEN,
);
await waitForContainer(carouselId, 'carousel');
console.log(`\n  carousel container ${carouselId}`);

// Step 3. Publish.
const { id: postId } = await apiPost(host, `${IG_USER_ID}/media_publish`, { creation_id: carouselId }, TOKEN);
console.log(`\npublished: ${postId}`);

// Surface the live URL so the result can be checked immediately.
try {
  const media = await apiGet(host, `${postId}?fields=permalink&access_token=${TOKEN}`);
  if (media.permalink) console.log(`permalink: ${media.permalink}`);
} catch { /* the post is live regardless */ }
