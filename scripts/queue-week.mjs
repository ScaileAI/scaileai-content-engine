#!/usr/bin/env node
/**
 * Put built posts into the schedule.
 *
 *   node scripts/queue-week.mjs           add the plan below
 *   node scripts/queue-week.mjs --dry-run show what would be added
 *
 * Refuses to queue anything that has not passed validation, and refuses to
 * double-book a slot or re-queue a slug that is already scheduled. Queueing is a
 * deliberate step, separate from building, so nothing reaches the schedule just
 * because it happened to render.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './ig-api.mjs';

const QUEUE = path.join(projectDir, 'engine', 'queue.json');
const dryRun = process.argv.includes('--dry-run');

// The "Did you know" series. Thu 10 Sep to Mon 14 Sep, two a day.
//
// Every headline opens DID YOU KNOW in black with the payload beneath in the
// accent. The repetition is deliberate: it makes the run recognisable in the
// grid, which ten varied hooks would not.
//
// Topics were checked against all 25 posts published to date. An earlier set of
// ten scripts covered the same arguments as posts already out - four of them
// within the same week - so those are kept for video, where the audience is
// different, and these were written fresh instead.
//
// Only two COMMENT calls to action across the ten. Phase 6 is not built, so a
// comment keyword currently gets silence; there is no sense adding eight more
// posts that ask for one.
//
// Earlier weeks are not repeated here. queue.json is the record of what is
// scheduled; this list is only what is being added.
const PLAN = [
  ['2026-09-10', 'AM', 'nobody-leaves-a-voicemail'],
  ['2026-09-10', 'PM', 'you-look-like-spam'],
  ['2026-09-11', 'AM', 'they-would-rather-text'],
  ['2026-09-11', 'PM', 'nobody-chases-a-quote'],
  ['2026-09-12', 'AM', 'you-can-just-ask'],
  ['2026-09-12', 'PM', 'google-thinks-youre-closed'],
  ['2026-09-13', 'AM', 'how-much-roughly'],
  ['2026-09-13', 'PM', 'the-plan-beats-the-job'],
  ['2026-09-14', 'AM', 'callbacks-eat-the-job'],
  ['2026-09-14', 'PM', 'nobody-sees-your-work'],
];

const queue = JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
// Two posts a day, seven days a week. Weekends run later: nobody is reading a
// contractor's Instagram at 06:50 on a Sunday. The time is derived from the date
// rather than named in the plan, so a weekend entry cannot accidentally be given
// a weekday time.
function slotTime(date, half) {
  const dow = new Date(date + 'T12:00:00Z').getUTCDay();
  const weekend = dow === 0 || dow === 6;
  if (half === 'AM') return weekend ? queue.slots.weekendMorning : queue.slots.morning;
  if (half === 'PM') return weekend ? queue.slots.weekendAfternoon : queue.slots.afternoon;
  throw new Error('slot must be AM or PM, got ' + half);
}

const taken = new Set(queue.posts.map((p) => p.publishAt));
const already = new Set(queue.posts.map((p) => p.slug));

const added = [];
const skipped = [];

for (const [date, slot, slug] of PLAN) {
  const publishAt = `${date}T${slotTime(date, slot)}`;
  const briefPath = path.join(projectDir, 'briefs', `${slug}.json`);

  if (!fs.existsSync(briefPath)) { skipped.push(`${slug}: no brief`); continue; }
  if (already.has(slug)) { skipped.push(`${slug}: already in the queue`); continue; }
  if (taken.has(publishAt)) { skipped.push(`${slug}: ${publishAt} is already taken`); continue; }

  // Nothing enters the schedule unvalidated. This is the whole point of Phase 2.
  const v = spawnSync('node', ['engine/validate.mjs', `briefs/${slug}.json`],
    { cwd: projectDir, encoding: 'utf8', shell: process.platform === 'win32' });
  if (v.status !== 0) {
    const why = (v.stdout || '').split('\n').filter((l) => l.includes('FAIL')).map((l) => l.trim()).join('; ');
    skipped.push(`${slug}: failed validation — ${why || 'see validate output'}`);
    continue;
  }

  const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
  const entry = {
    id: `${date}-${slot.toLowerCase()}`,
    publishAt,
    slug,
    type: brief.type,
    ...(brief.type === 'carousel' ? { slides: brief.slides.length } : {}),
    status: 'queued',
  };

  added.push(entry);
  taken.add(publishAt);
  already.add(slug);

  // The publisher reads captions from the repo, not from the render output.
  const dest = path.join(projectDir, 'engine', 'posts', slug);
  const src = path.join(projectDir, 'ig-posts', slug, 'caption.txt');
  if (!dryRun && fs.existsSync(src)) {
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(src, path.join(dest, 'caption.txt'));
  }
}

console.log(`${added.length} post(s) ready to queue:\n`);
for (const e of added) console.log(`  ${e.publishAt}  ${e.type.padEnd(9)} ${e.slug}`);
if (skipped.length) {
  console.log(`\n${skipped.length} skipped:`);
  for (const s of skipped) console.log(`  ${s}`);
}

if (dryRun) { console.log('\nDry run. Nothing written.'); process.exit(0); }

queue.posts.push(...added);
queue.posts.sort((a, b) => String(a.publishAt).localeCompare(String(b.publishAt)));
fs.writeFileSync(QUEUE, JSON.stringify(queue, null, 2) + '\n');

console.log(`\nqueue.json now holds ${queue.posts.filter((p) => p.status === 'queued').length} queued post(s)`);
