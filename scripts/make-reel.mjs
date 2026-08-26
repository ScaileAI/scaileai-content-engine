#!/usr/bin/env node
/**
 * Build a reel from slides already rendered for a post.
 *
 *   node scripts/make-reel.mjs ig-posts/missed-call-math
 *   node scripts/make-reel.mjs ig-posts/missed-call-math --hold 2.4 --hook 3 --cta 3.5
 *
 * Writes <post-dir>/reel.mp4, which publish-instagram.mjs then posts as a REEL
 * instead of a carousel. Costs nothing: it reuses art you have already paid to
 * render.
 *
 * The slides are 4:5. Reels are 9:16, so each slide is scaled to the full width
 * and padded top and bottom in the same near-white as the slide background, which
 * reads as one continuous card rather than a letterboxed image.
 *
 * A silent audio track is included. Some encoders and players behave badly with a
 * video stream and no audio stream at all.
 *
 * Node 18+. Needs ffmpeg.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './ig-api.mjs';

// ── locate ffmpeg ─────────────────────────────────────────────────────────────

/** Prefer PATH; fall back to the WinGet install location for a fresh install. */
function findFfmpeg() {
  const onPath = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', shell: true });
  if (onPath.status === 0) return 'ffmpeg';

  const wingetRoot = path.join(
    process.env.LOCALAPPDATA || '',
    'Microsoft', 'WinGet', 'Packages',
  );
  if (fs.existsSync(wingetRoot)) {
    for (const dir of fs.readdirSync(wingetRoot)) {
      if (!/ffmpeg/i.test(dir)) continue;
      const base = path.join(wingetRoot, dir);
      for (const build of fs.readdirSync(base)) {
        const exe = path.join(base, build, 'bin', 'ffmpeg.exe');
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  return null;
}

const FFMPEG = findFfmpeg();
if (!FFMPEG) {
  console.error('ffmpeg not found.\nInstall it with:  winget install --id Gyan.FFmpeg -e');
  process.exit(1);
}

// ── args ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const postDir = argv.find((a) => !a.startsWith('--'));
const num = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i === -1 ? dflt : Number(argv[i + 1]);
};

if (!postDir) {
  console.error('Usage: node scripts/make-reel.mjs <post-dir> [--hook 3] [--hold 2.4] [--cta 3.5]');
  process.exit(1);
}

// The first slide has to survive a thumb-stop, and the last has to be readable
// long enough to act on. The middle ones only carry one idea each.
const HOOK = num('--hook', 3.0);
const HOLD = num('--hold', 2.4);
const CTA = num('--cta', 3.5);

const W = 1080;
const H = 1920;
const FPS = 30;

// ── inputs ────────────────────────────────────────────────────────────────────

const dir = path.resolve(projectDir, postDir);
const jpegDir = path.join(dir, 'jpeg');

if (!fs.existsSync(jpegDir)) {
  console.error(`No jpeg/ folder in ${dir}.`);
  console.error(`Run: powershell -ExecutionPolicy Bypass -File scripts/to-jpeg.ps1 -PostDir "${postDir}"`);
  process.exit(1);
}

const slides = fs.readdirSync(jpegDir).filter((f) => /^slide-\d+\.jpg$/i.test(f)).sort();
if (slides.length === 0) {
  console.error(`No slides in ${jpegDir}.`);
  process.exit(1);
}

const durationFor = (i) => (i === 0 ? HOOK : i === slides.length - 1 ? CTA : HOLD);
const total = slides.reduce((s, _, i) => s + durationFor(i), 0);

console.log(`${path.basename(dir)}: ${slides.length} slides -> ${total.toFixed(1)}s reel\n`);
slides.forEach((f, i) => console.log(`  ${f}  ${durationFor(i).toFixed(1)}s`));

// ── build ─────────────────────────────────────────────────────────────────────

// The concat demuxer needs the final entry repeated, otherwise its duration is
// ignored and the last slide flashes past.
const listPath = path.join(dir, '_reel-list.txt');
const lines = [];
slides.forEach((f, i) => {
  lines.push(`file '${path.join(jpegDir, f).replace(/\\/g, '/')}'`);
  lines.push(`duration ${durationFor(i)}`);
});
lines.push(`file '${path.join(jpegDir, slides[slides.length - 1]).replace(/\\/g, '/')}'`);
fs.writeFileSync(listPath, lines.join('\n'));

const out = path.join(dir, 'reel.mp4');

const args = [
  '-y',
  '-f', 'concat', '-safe', '0', '-i', listPath,
  // A silent track, trimmed to the video, keeps every player happy.
  '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
  '-vf', [
    `scale=${W}:-2:flags=lanczos`,
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0xFCFCFC`,
    'format=yuv420p',
  ].join(','),
  '-r', String(FPS),
  '-c:v', 'libx264',
  '-preset', 'medium',
  '-crf', '20',
  '-profile:v', 'high',
  '-c:a', 'aac', '-b:a', '128k',
  '-shortest',
  '-movflags', '+faststart',
  out,
];

console.log('\nencoding...');
const run = spawnSync(FFMPEG, args, { encoding: 'utf8' });
fs.unlinkSync(listPath);

if (run.status !== 0) {
  console.error('ffmpeg failed:\n' + (run.stderr || '').split('\n').slice(-15).join('\n'));
  process.exit(1);
}

const mb = fs.statSync(out).size / 1048576;
console.log(`\nreel.mp4  ${W}x${H}  ${total.toFixed(1)}s  ${mb.toFixed(1)} MB`);
console.log(`\nPublish it with:\n  node scripts/post.mjs briefs/<brief>.json --skip-render`);
