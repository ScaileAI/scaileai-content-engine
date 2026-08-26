#!/usr/bin/env node
/**
 * Stage rendered JPEGs into one folder that can be dragged onto Netlify, and build
 * an index page so the site has something to show at its root.
 *
 *   node scripts/stage-for-netlify.mjs ig-posts/voice-agents-for-contractors
 *
 * Produces netlify-public/<slug>/slide-NN.jpg so several carousels share one site
 * without colliding, plus netlify-public/index.html listing every carousel staged
 * so far. Re-run it per post, the index rebuilds from whatever is on disk.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const postDir = process.argv[2];

if (!postDir) {
  console.error('Usage: node scripts/stage-for-netlify.mjs <post-dir>');
  process.exit(1);
}

const src = path.resolve(projectDir, postDir);
const slug = path.basename(src);
const jpegDir = path.join(src, 'jpeg');

if (!fs.existsSync(jpegDir)) {
  console.error(`No jpeg/ folder in ${src}.`);
  console.error(`Run: powershell -ExecutionPolicy Bypass -File scripts/to-jpeg.ps1 -PostDir "${postDir}"`);
  process.exit(1);
}

const root = path.join(projectDir, 'netlify-public');
const dest = path.join(root, slug);
fs.mkdirSync(dest, { recursive: true });

const files = fs.readdirSync(jpegDir).filter((f) => f.toLowerCase().endsWith('.jpg')).sort();
for (const f of files) fs.copyFileSync(path.join(jpegDir, f), path.join(dest, f));

// Carry the caption across so the whole post can be reviewed in one place.
const captionSrc = path.join(src, 'caption.txt');
if (fs.existsSync(captionSrc)) fs.copyFileSync(captionSrc, path.join(dest, 'caption.txt'));

// A reel needs its mp4 published at the same public path as the slides, because
// the API fetches the video by URL exactly as it fetches images.
const reelSrc = path.join(src, 'reel.mp4');
if (fs.existsSync(reelSrc)) {
  fs.copyFileSync(reelSrc, path.join(dest, 'reel.mp4'));
  console.log(`staged reel.mp4 (${(fs.statSync(reelSrc).size / 1048576).toFixed(1)} MB)`);
}

console.log(`staged ${files.length} file(s) -> netlify-public/${slug}/`);

// ── index ─────────────────────────────────────────────────────────────────────

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const carousels = fs
  .readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => ({
    slug: d.name,
    slides: fs.readdirSync(path.join(root, d.name)).filter((f) => f.toLowerCase().endsWith('.jpg')).sort(),
  }))
  .filter((c) => c.slides.length);

const sections = carousels
  .map(
    (c) => `  <section>
    <h2>${esc(c.slug)}</h2>
    <p class="meta">${c.slides.length} slides</p>
    <div class="grid">
${c.slides.map((f, i) => `      <figure><img src="${esc(c.slug)}/${esc(f)}" alt="slide ${i + 1}" loading="lazy"><figcaption>${String(i + 1).padStart(2, '0')}</figcaption></figure>`).join('\n')}
    </div>
  </section>`,
  )
  .join('\n\n');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Carousel assets</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --ink:#111; --muted:#666; --line:#e5e5e5; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111; --ink:#f5f5f5; --muted:#999; --line:#333; } }
  body { margin:0; padding:2.5rem 1.5rem; background:var(--bg); color:var(--ink);
         font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }
  .wrap { max-width:1100px; margin:0 auto; }
  h1 { font-size:1.35rem; margin:0 0 .25rem; }
  .lede { color:var(--muted); margin:0 0 2.5rem; }
  h2 { font-size:1.05rem; margin:0 0 .2rem; }
  .meta { color:var(--muted); margin:0 0 1rem; font-size:.9rem; }
  section { border-top:1px solid var(--line); padding-top:1.5rem; margin-top:2.5rem; }
  section:first-of-type { border-top:0; margin-top:0; padding-top:0; }
  .grid { display:grid; gap:1rem; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); }
  figure { margin:0; }
  img { width:100%; height:auto; display:block; border:1px solid var(--line); border-radius:3px; }
  figcaption { color:var(--muted); font-size:.8rem; margin-top:.35rem; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Carousel assets</h1>
  <p class="lede">Image host for API publishing. Not a public page.</p>

${sections}
</div>
</body>
</html>
`;

fs.writeFileSync(path.join(root, 'index.html'), html);
console.log(`index.html rebuilt with ${carousels.length} carousel(s)`);
console.log('\nNext: drag the netlify-public folder CONTENTS onto https://app.netlify.com/drop');
console.log(`Then your base url is  https://<site-name>.netlify.app/${slug}`);
