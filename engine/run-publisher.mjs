#!/usr/bin/env node
/**
 * The scheduled publisher. Runs hourly in GitHub Actions.
 *
 *   node engine/run-publisher.mjs            publish anything now due
 *   node engine/run-publisher.mjs --dry-run  report what it would do, publish nothing
 *
 * It reads engine/queue.json, works out the current local time in the queue's
 * timezone, and publishes any post whose slot has arrived. It does not render
 * images, write captions or call any paid service: everything it publishes was
 * made and checked in advance and is already hosted. That is what makes running
 * it unattended defensible.
 *
 * Runs hourly rather than at the two posting times because cron is UTC and
 * Mountain shifts with daylight saving. Comparing local time here means the
 * schedule never drifts and nobody has to remember to change it twice a year.
 *
 * Needs IG_ACCESS_TOKEN and IG_BASE_URL in the environment. In Actions those come
 * from repository secrets.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const engineDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(engineDir, '..');
const QUEUE = path.join(engineDir, 'queue.json');

const dryRun = process.argv.includes('--dry-run');

const IG_GRAPH = 'https://graph.instagram.com/v25.0';
const FB_GRAPH = 'https://graph.facebook.com/v25.0';

// How late a post may still go out. If Actions was delayed or down we would
// rather skip a stale slot than publish a "good morning" post in the afternoon.
// Three hours: a 06:50 slot can still publish up to 09:50.
const GRACE_MINUTES = 180;

// ── helpers ───────────────────────────────────────────────────────────────────

const log = (...a) => console.log(...a);

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exitCode = 1;
}

/** Current wall-clock time in a named timezone, as {date:'YYYY-MM-DD', minutes}. */
function localNow(timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    label: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`,
  };
}

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

async function detectHost(token) {
  for (const host of [IG_GRAPH, FB_GRAPH]) {
    try {
      const r = await fetch(`${host}/me?fields=id&access_token=${token}`);
      if (r.ok) return host;
    } catch { /* try the other */ }
  }
  throw new Error('Instagram token rejected by both API hosts. It may have expired.');
}

async function apiPost(host, endpoint, params, token) {
  const res = await fetch(`${host}/${endpoint}`, {
    method: 'POST',
    body: new URLSearchParams({ ...params, access_token: token }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${json.error?.message || 'unknown API error'}`);
  return json;
}

async function apiGet(host, endpoint) {
  const res = await fetch(`${host}/${endpoint}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
  return json;
}

async function waitForContainer(host, token, id, label, tries) {
  for (let i = 0; i < tries; i++) {
    const j = await apiGet(host, `${id}?fields=status_code,status&access_token=${token}`).catch(() => ({}));
    if (j.status_code === 'FINISHED') return;
    if (j.status_code === 'ERROR' || j.status_code === 'EXPIRED') {
      throw new Error(`${label} container ${j.status_code}: ${j.status || 'no detail'}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`${label} container did not finish in time`);
}

/** Confirm every asset is actually reachable before anything is published. */
async function verifyMedia(urls) {
  const bad = [];
  for (const u of urls) {
    const res = await fetch(u, { method: 'HEAD' }).catch(() => null);
    const type = res?.headers.get('content-type') || '';
    if (!res?.ok || !/^(image|video)\//.test(type)) bad.push(`${u} (${res?.status || 'no response'} ${type})`);
  }
  return bad;
}

// ── the queue ─────────────────────────────────────────────────────────────────

if (!fs.existsSync(QUEUE)) {
  fail(`No queue at ${QUEUE}`);
  process.exit(1);
}

const queue = JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
const tz = queue.timezone || 'America/Denver';
const now = localNow(tz);

log(`local time in ${tz}: ${now.label}`);

const due = (queue.posts || []).filter((p) => {
  if (p.status !== 'queued') return false;
  const [d, t] = String(p.publishAt).split('T');
  if (d !== now.date) return false;
  const mins = toMinutes(t);
  return now.minutes >= mins && now.minutes - mins <= GRACE_MINUTES;
});

if (due.length === 0) {
  const next = (queue.posts || []).filter((p) => p.status === 'queued').sort((a, b) => String(a.publishAt).localeCompare(String(b.publishAt)))[0];
  log(`nothing due. next queued: ${next ? `${next.publishAt} ${next.slug}` : 'none — the queue is empty'}`);

  // A quiet hour is the only safe moment to test the credentials, and the worst
  // possible time to discover they are broken is the minute a post is due. So
  // every idle run proves the token still works and warns before it expires.
  await healthCheck(next);
  process.exit(process.exitCode || 0);
}

/** Verify the token still authenticates, and warn while there is time to act. */
async function healthCheck(next) {
  const token = process.env.IG_ACCESS_TOKEN;
  if (!token) {
    fail('IG_ACCESS_TOKEN is not set. Nothing can publish until it is.');
    return;
  }
  if (!process.env.IG_BASE_URL) {
    fail('IG_BASE_URL is not set. Nothing can publish until it is.');
    return;
  }

  try {
    const h = await detectHost(token);
    const me = await apiGet(h, `me?fields=id,username&access_token=${token}`);
    log(`token ok: @${me.username}`);
  } catch (err) {
    fail(`TOKEN CHECK FAILED: ${err.message}`);
    return;
  }

  // Instagram tokens last about 60 days. debug_token does not answer for the
  // Instagram Login route, so the remaining life is calculated from the recorded
  // issue date in token.json instead of asked for. The weekly refresh workflow
  // keeps that date current.
  const metaPath = path.join(engineDir, 'token.json');
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (meta.issuedAt) {
      const issued = new Date(`${meta.issuedAt}T00:00:00Z`).getTime();
      const days = Math.round((issued + (meta.lifetimeDays || 60) * 86400000 - Date.now()) / 86400000);
      log(`token has about ${days} day(s) left`);
      if (days <= 5) fail(`Instagram token expires in ${days} day(s). Refresh it now or posting stops.`);
      else if (days <= 14) log(`::warning::Token expires in ${days} day(s). The weekly refresh should handle it, but check it ran.`);
    }
  } else {
    log('::warning::engine/token.json is missing, so token expiry cannot be tracked.');
  }

  // A queue running dry is the other way this stops silently.
  const queued = (queue.posts || []).filter((p) => p.status === 'queued').length;
  log(`${queued} post(s) still queued`);
  if (queued === 0) fail('The queue is empty. Nothing will publish until it is refilled.');
  else if (queued <= 3) log(`::warning::Only ${queued} post(s) left in the queue. Time to restock.`);

  if (next) {
    const media = `${(process.env.IG_BASE_URL || '').replace(/\/+$/, '')}/${next.slug}`;
    const probe = next.type === 'reel' ? `${media}/reel.mp4` : `${media}/slide-01.jpg`;
    const bad = await verifyMedia([probe]);
    if (bad.length) fail(`Next post's media is not reachable: ${bad[0]}`);
    else log(`next post's media is reachable`);
  }
}

log(`${due.length} post(s) due\n`);

// ── credentials ───────────────────────────────────────────────────────────────

const TOKEN = process.env.IG_ACCESS_TOKEN;
const BASE = (process.env.IG_BASE_URL || '').replace(/\/+$/, '');

if (!dryRun && (!TOKEN || !BASE)) {
  fail('IG_ACCESS_TOKEN or IG_BASE_URL missing from the environment.');
  process.exit(1);
}

const host = dryRun ? IG_GRAPH : await detectHost(TOKEN);
const IG_USER = process.env.IG_USER_ID || (host === IG_GRAPH ? 'me' : null);

// ── publish ───────────────────────────────────────────────────────────────────

let changed = false;

for (const post of due) {
  const { slug, type } = post;
  log(`── ${post.publishAt}  ${slug}  [${type}]`);

  const captionFile = path.join(engineDir, 'posts', slug, 'caption.txt');
  if (!fs.existsSync(captionFile)) {
    fail(`${slug}: no caption at engine/posts/${slug}/caption.txt — skipping`);
    post.status = 'skipped';
    post.error = 'missing caption';
    changed = true;
    continue;
  }
  const caption = fs.readFileSync(captionFile, 'utf8').trim();

  const base = `${BASE}/${slug}`;
  const urls =
    type === 'reel'
      ? [`${base}/reel.mp4`]
      : (post.slides || 1) === 1
        ? [`${base}/slide-01.jpg`]
        : Array.from({ length: post.slides }, (_, i) => `${base}/slide-${String(i + 1).padStart(2, '0')}.jpg`);

  if (dryRun) {
    log(`  would publish ${urls.length} asset(s):`);
    urls.forEach((u) => log(`    ${u}`));
    log(`  caption: ${caption.split('\n')[0].slice(0, 60)}...`);
    continue;
  }

  const bad = await verifyMedia(urls);
  if (bad.length) {
    fail(`${slug}: media not reachable, nothing published:\n  ${bad.join('\n  ')}`);
    post.status = 'skipped';
    post.error = 'media unreachable';
    changed = true;
    continue;
  }

  try {
    let mediaId;

    if (type === 'reel') {
      const { id } = await apiPost(host, `${IG_USER}/media`, { media_type: 'REELS', video_url: urls[0], caption }, TOKEN);
      await waitForContainer(host, TOKEN, id, 'reel', 90);
      ({ id: mediaId } = await apiPost(host, `${IG_USER}/media_publish`, { creation_id: id }, TOKEN));
    } else if (urls.length === 1) {
      const { id } = await apiPost(host, `${IG_USER}/media`, { image_url: urls[0], caption }, TOKEN);
      await waitForContainer(host, TOKEN, id, 'image', 30);
      ({ id: mediaId } = await apiPost(host, `${IG_USER}/media_publish`, { creation_id: id }, TOKEN));
    } else {
      const children = [];
      for (const [i, u] of urls.entries()) {
        const { id } = await apiPost(host, `${IG_USER}/media`, { image_url: u, is_carousel_item: 'true' }, TOKEN);
        await waitForContainer(host, TOKEN, id, `slide ${i + 1}`, 30);
        children.push(id);
      }
      const { id: carousel } = await apiPost(host, `${IG_USER}/media`, {
        media_type: 'CAROUSEL', children: children.join(','), caption,
      }, TOKEN);
      await waitForContainer(host, TOKEN, carousel, 'carousel', 30);
      ({ id: mediaId } = await apiPost(host, `${IG_USER}/media_publish`, { creation_id: carousel }, TOKEN));
    }

    let permalink = '';
    try {
      const m = await apiGet(host, `${mediaId}?fields=permalink&access_token=${TOKEN}`);
      permalink = m.permalink || '';
    } catch { /* live regardless */ }

    post.status = 'posted';
    post.mediaId = mediaId;
    post.permalink = permalink;
    post.postedAt = new Date().toISOString();
    changed = true;

    log(`  published: ${permalink || mediaId}`);
  } catch (err) {
    // A failed post stays queued so a later run can retry within the grace window.
    fail(`${slug}: ${err.message}`);
    post.lastError = err.message;
    changed = true;
  }
}

// Write the queue back so a post can never go out twice.
if (changed && !dryRun) {
  fs.writeFileSync(QUEUE, JSON.stringify(queue, null, 2) + '\n');
  log('\nqueue updated');
}
