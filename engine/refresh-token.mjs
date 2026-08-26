#!/usr/bin/env node
/**
 * Keep the Instagram token alive.
 *
 *   node engine/refresh-token.mjs --check    report days remaining, change nothing
 *   node engine/refresh-token.mjs            refresh, and write the new token back
 *
 * Instagram Login tokens last about 60 days. When one expires the engine stops
 * silently: the job runs, the API refuses, and nothing appears on the feed. This
 * is the piece that prevents that.
 *
 * Two things make it awkward, and both are handled here:
 *
 * 1. `debug_token` does not answer for Instagram Login tokens, so there is no way
 *    to ask the API when this token expires. Instead the issue date is recorded in
 *    engine/token.json and the remaining life is calculated from it.
 *
 * 2. Refreshing produces a NEW token string. Unless that new value replaces the
 *    repository secret, the refresh is worthless. Writing a GitHub secret means
 *    encrypting it for the repository's public key, which needs a token with
 *    permission to do so (GH_PAT). Without one this still refreshes and reports,
 *    but you have to paste the new value in yourself.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const engineDir = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_META = path.join(engineDir, 'token.json');

const checkOnly = process.argv.includes('--check');

const IG_GRAPH = 'https://graph.instagram.com';
const LIFETIME_DAYS = 60;

// Refresh with plenty of room. Instagram requires a token to be at least 24 hours
// old before it can be refreshed, and refusing to leave it until the last week
// means a failed refresh still has time to be noticed and fixed by hand.
const REFRESH_WHEN_DAYS_LEFT_BELOW = 20;

const log = (...a) => console.log(...a);
const warn = (m) => console.log(`::warning::${m}`);
const fail = (m) => { console.error(`::error::${m}`); process.exitCode = 1; };

// ── how long is left ──────────────────────────────────────────────────────────

function readMeta() {
  if (!fs.existsSync(TOKEN_META)) return null;
  return JSON.parse(fs.readFileSync(TOKEN_META, 'utf8'));
}

function daysLeft(meta) {
  if (!meta?.issuedAt) return null;
  const issued = new Date(`${meta.issuedAt}T00:00:00Z`).getTime();
  const life = (meta.lifetimeDays || LIFETIME_DAYS) * 86400000;
  return Math.round((issued + life - Date.now()) / 86400000);
}

const meta = readMeta();
const left = daysLeft(meta);

if (left === null) {
  warn(`No issue date recorded in engine/token.json, so remaining token life is unknown.`);
} else {
  log(`token issued ${meta.issuedAt}, about ${left} day(s) left`);
}

if (checkOnly) {
  if (left !== null) {
    if (left <= 7) fail(`Instagram token expires in ${left} day(s). Refresh it now.`);
    else if (left <= REFRESH_WHEN_DAYS_LEFT_BELOW) warn(`Token expires in ${left} day(s). A refresh is due.`);
    else log('no action needed');
  }
  process.exit(process.exitCode || 0);
}

// ── refresh ───────────────────────────────────────────────────────────────────

const TOKEN = process.env.IG_ACCESS_TOKEN;
if (!TOKEN) {
  fail('IG_ACCESS_TOKEN is not set.');
  process.exit(1);
}

if (left !== null && left > REFRESH_WHEN_DAYS_LEFT_BELOW && !process.argv.includes('--force')) {
  log(`nothing to do: ${left} days left, refreshing under ${REFRESH_WHEN_DAYS_LEFT_BELOW}`);
  process.exit(0);
}

log('requesting a refreshed token...');

const res = await fetch(`${IG_GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${TOKEN}`);
const body = await res.json().catch(() => ({}));

if (!res.ok || !body.access_token) {
  fail(`Refresh failed: ${body.error?.message || `HTTP ${res.status}`}`);
  fail('Regenerate the token by hand from the Meta app page and update the IG_ACCESS_TOKEN secret.');
  process.exit(1);
}

const newToken = body.access_token;
const expiresInDays = Math.round((body.expires_in || LIFETIME_DAYS * 86400) / 86400);
log(`new token received, valid about ${expiresInDays} day(s)`);

// Prove the new token actually works before anything depends on it.
const verify = await fetch(`${IG_GRAPH}/v25.0/me?fields=username&access_token=${newToken}`);
const who = await verify.json().catch(() => ({}));
if (!verify.ok || !who.username) {
  fail('The refreshed token did not authenticate. Keeping the existing one.');
  process.exit(1);
}
log(`new token verified: @${who.username}`);

// ── write it back ─────────────────────────────────────────────────────────────

const GH_PAT = process.env.GH_PAT;
const REPO = process.env.GITHUB_REPOSITORY;

if (!GH_PAT || !REPO) {
  log('');
  warn('GH_PAT is not set, so the repository secret was NOT updated.');
  warn('The refreshed token is valid but unused. Update IG_ACCESS_TOKEN by hand, or add a GH_PAT secret to automate this.');
  // Deliberately never printed. A token in a build log is a leaked token.
  log('(the new token value is withheld from this log on purpose)');
  process.exit(0);
}

const gh = async (url, init = {}) => {
  const r = await fetch(`https://api.github.com${url}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${GH_PAT}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${url}: ${r.status} ${j.message || ''}`);
  return j;
};

try {
  const { default: sodiumModule } = await import('libsodium-wrappers');
  const sodium = sodiumModule;
  await sodium.ready;

  const pk = await gh(`/repos/${REPO}/actions/secrets/public-key`);
  const encrypted = sodium.crypto_box_seal(
    sodium.from_string(newToken),
    sodium.from_base64(pk.key, sodium.base64_variants.ORIGINAL),
  );

  const put = await fetch(`https://api.github.com/repos/${REPO}/actions/secrets/IG_ACCESS_TOKEN`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GH_PAT}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      encrypted_value: sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL),
      key_id: pk.key_id,
    }),
  });

  if (!put.ok) throw new Error(`secret update returned ${put.status}`);
  log('repository secret IG_ACCESS_TOKEN updated');

  // Record the new issue date so the countdown restarts.
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(
    TOKEN_META,
    JSON.stringify({ ...(meta || {}), issuedAt: today, lifetimeDays: expiresInDays, lastRefresh: today }, null, 2) + '\n',
  );
  log(`token.json updated: issuedAt ${today}, ${expiresInDays} day lifetime`);
} catch (err) {
  fail(`Could not update the repository secret: ${err.message}`);
  fail('The refreshed token is valid but not saved anywhere. Update IG_ACCESS_TOKEN by hand.');
  process.exit(1);
}
