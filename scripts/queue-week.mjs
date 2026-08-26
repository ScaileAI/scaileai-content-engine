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

// The week. Dates are local to the queue's timezone.
const PLAN = [
  ['2026-08-27', 'PM', 'quote-sitting-in-an-inbox'],
  ['2026-08-28', 'AM', 'database-is-not-dead'],
  ['2026-08-28', 'PM', 'answered-is-not-booked'],
  ['2026-08-29', 'SAT', 'what-a-dispatcher-actually-does'],
  ['2026-08-31', 'AM', 'you-dont-need-more-leads'],
  ['2026-08-31', 'PM', 'the-second-shift'],
  ['2026-09-01', 'AM', 'while-you-were-driving'],
  ['2026-09-01', 'PM', 'ads-without-follow-up'],
  ['2026-09-02', 'AM', 'stop-making-them-wait'],
  ['2026-09-02', 'PM', 'what-happens-in-ninety-seconds'],
  ['2026-09-05', 'SAT', 'you-are-not-the-bottleneck'],
];

const queue = JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
const TIMES = { AM: queue.slots.morning, PM: queue.slots.afternoon, SAT: queue.slots.saturday };

const taken = new Set(queue.posts.map((p) => p.publishAt));
const already = new Set(queue.posts.map((p) => p.slug));

const added = [];
const skipped = [];

for (const [date, slot, slug] of PLAN) {
  const publishAt = `${date}T${TIMES[slot]}`;
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
