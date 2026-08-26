#!/usr/bin/env node
/**
 * Find the IG_USER_ID that publish-instagram.mjs needs, and check the token works.
 *
 *   node scripts/ig-whoami.mjs
 *
 * Handles both Instagram Login and Facebook Login tokens. Prints ids and names
 * only, never the token itself.
 */

import { IG_GRAPH, FB_GRAPH, fromEnv, detectHost, apiGet } from './ig-api.mjs';
import path from 'node:path';
import { projectDir } from './ig-api.mjs';

const TOKEN = fromEnv('IG_ACCESS_TOKEN');
if (!TOKEN) {
  console.error(`No IG_ACCESS_TOKEN found in ${path.join(projectDir, '.env')}`);
  process.exit(1);
}

let host;
try {
  host = await detectHost(TOKEN);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const route = host === IG_GRAPH ? 'Instagram Login' : 'Facebook Login';
console.log(`token accepted by ${host}`);
console.log(`route: ${route}\n`);

if (host === IG_GRAPH) {
  // Instagram Login: the token already represents the IG account.
  const me = await apiGet(host, `me?fields=id,username,account_type&access_token=${TOKEN}`);
  console.log(`  Instagram @${me.username}  (${me.account_type || 'type unknown'})`);
  console.log(`  IG_USER_ID=${me.id}\n`);
  if (me.account_type && !/BUSINESS|CREATOR|MEDIA_CREATOR/i.test(me.account_type)) {
    console.log('  WARNING: publishing needs a Business or Creator account.');
  }
  console.log('Copy the IG_USER_ID line above into .env');
} else {
  // Facebook Login: walk the Pages to find the connected IG account.
  const pages = await apiGet(host, `me/accounts?fields=id,name,instagram_business_account{id,username}&access_token=${TOKEN}`);
  if (!pages.data?.length) {
    console.error('No Pages visible to this token. It needs pages_show_list, and you need a role on the Page.');
    process.exit(1);
  }
  let found = 0;
  for (const p of pages.data) {
    console.log(`  Page: ${p.name}  (id ${p.id})`);
    if (p.instagram_business_account) {
      found++;
      console.log(`    -> Instagram @${p.instagram_business_account.username}`);
      console.log(`    -> IG_USER_ID=${p.instagram_business_account.id}\n`);
    } else {
      console.log('    -> no Instagram business account connected\n');
    }
  }
  if (!found) {
    console.error('No Instagram business account connected to any visible Page.');
    process.exit(1);
  }
  console.log('Copy the IG_USER_ID line above into .env');
}

// Lifetime, so a 1-hour token is not mistaken for a durable one.
try {
  const dbg = await apiGet(FB_GRAPH, `debug_token?input_token=${TOKEN}&access_token=${TOKEN}`);
  const d = dbg.data || {};
  if (d.expires_at === 0) {
    console.log('\ntoken lifetime: does not expire');
  } else if (d.expires_at) {
    const days = Math.round((d.expires_at * 1000 - Date.now()) / 86400000);
    console.log(`\ntoken lifetime: expires ${new Date(d.expires_at * 1000).toISOString().slice(0, 10)} (about ${days} days)`);
    if (days < 7) console.log('That is short-lived. Extend it before relying on this pipeline.');
  }
} catch { /* optional */ }
