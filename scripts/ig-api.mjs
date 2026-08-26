/**
 * Shared Instagram API plumbing.
 *
 * Meta has two front doors to the same publishing endpoints:
 *   Instagram Login  -> graph.instagram.com, scopes instagram_business_*
 *   Facebook Login   -> graph.facebook.com,  scopes instagram_basic + Page token
 *
 * The "Manage messaging & content on Instagram" use case gives the first kind.
 * Rather than make you care which you have, detectHost() tries the Instagram
 * host and falls back to the Facebook one.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const IG_GRAPH = 'https://graph.instagram.com/v25.0';
export const FB_GRAPH = 'https://graph.facebook.com/v25.0';

/** Read a key from the environment, falling back to a .env in the project root. */
export function fromEnv(name) {
  if (process.env[name]) return process.env[name];
  const envFile = path.join(projectDir, '.env');
  if (!fs.existsSync(envFile)) return null;
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(new RegExp(`^\s*(?:export\s+)?${name}\s*=\s*(.*)\s*$`));
    if (m) {
      const v = m[1].trim().replace(/^["']|["']$/g, '');
      if (v) return v;
    }
  }
  return null;
}

/**
 * Work out which host this token belongs to.
 * IG_API_HOST=instagram|facebook in .env skips the probe.
 */
export async function detectHost(token) {
  const forced = fromEnv('IG_API_HOST');
  if (forced === 'instagram') return IG_GRAPH;
  if (forced === 'facebook') return FB_GRAPH;

  for (const host of [IG_GRAPH, FB_GRAPH]) {
    try {
      const res = await fetch(`${host}/me?fields=id&access_token=${token}`);
      if (res.ok) return host;
    } catch { /* try the other host */ }
  }
  throw new Error('Token was rejected by both graph.instagram.com and graph.facebook.com. It may be expired or missing permissions.');
}

export async function apiGet(host, endpoint) {
  const res = await fetch(`${host}/${endpoint}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
  return json;
}

export async function apiPost(host, endpoint, params, token) {
  const body = new URLSearchParams({ ...params, access_token: token });
  const res = await fetch(`${host}/${endpoint}`, { method: 'POST', body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json.error || {};
    throw new Error(`${res.status} ${e.message || 'unknown error'}${e.error_user_msg ? ` (${e.error_user_msg})` : ''}`);
  }
  return json;
}
