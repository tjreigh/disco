// Generates the favicon / PWA icon set in icons/ from one geometric mark:
// concentric rings on the brand navy, in the accent blues. Rasterizes the SVG
// with Playwright's Chromium (no other image tooling needed).
//
// Run: node scripts/make-icons.mjs
// Replace icons/ with real artwork later, keeping the same filenames and sizes.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const ICONS_DIR = join(fileURLToPath(new URL('..', import.meta.url)), 'icons');

const NAVY = '#1a1a2e';

// Concentric rings centered in a 100x100 box, scaled by `s` (1 = full motif).
function rings(s) {
  const bands = [
    { r: 41 * s, fill: 'url(#disc)' },
    { r: 29 * s, fill: NAVY },
    { r: 18.5 * s, fill: 'url(#disc)' },
    { r: 7.5 * s, fill: NAVY },
  ];
  return bands.map(b => `<circle cx="50" cy="50" r="${b.r.toFixed(2)}" fill="${b.fill}"/>`).join('');
}

// `bg` is the background rect (square or rounded); `motifScale` shrinks the
// rings inside the maskable safe zone.
function svg({ rounded = false, motifScale = 1 } = {}) {
  const rx = rounded ? ' rx="13" ry="13"' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <radialGradient id="disc" cx="0.38" cy="0.32" r="0.75">
      <stop offset="0" stop-color="#9ed7ff"/>
      <stop offset="1" stop-color="#5aa9e6"/>
    </radialGradient>
  </defs>
  <rect width="100" height="100"${rx} fill="${NAVY}"/>
  ${rings(motifScale)}
</svg>`;
}

const SQUARE = svg();
const ROUNDED = svg({ rounded: true });
const MASKABLE = svg({ motifScale: 0.88 });

// file -> { svg, size }; favicon.svg is written straight from the source.
const PNGS = [
  { file: 'favicon-16.png', svg: ROUNDED, size: 16 },
  { file: 'favicon-32.png', svg: ROUNDED, size: 32 },
  { file: 'icon-192.png', svg: SQUARE, size: 192 },
  { file: 'icon-512.png', svg: SQUARE, size: 512 },
  { file: 'icon-maskable-192.png', svg: MASKABLE, size: 192 },
  { file: 'icon-maskable-512.png', svg: MASKABLE, size: 512 },
  { file: 'apple-touch-icon.png', svg: SQUARE, size: 180 },
];

async function main() {
  mkdirSync(ICONS_DIR, { recursive: true });
  writeFileSync(join(ICONS_DIR, 'favicon.svg'), `${ROUNDED}\n`);

  const browser = await chromium.launch();
  try {
    for (const { file, svg: markup, size } of PNGS) {
      const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
      await page.setContent(
        `<!doctype html><style>*{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${markup}`,
      );
      await page.locator('svg').screenshot({ path: join(ICONS_DIR, file) });
      await page.close();
      console.log(`make-icons: wrote icons/${file} (${size}x${size})`);
    }
  } finally {
    await browser.close();
  }
  console.log('make-icons: wrote icons/favicon.svg');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
