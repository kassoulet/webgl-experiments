#!/usr/bin/env node
// Writes the PNG icons the manifest asks for, with no image library: a PNG is a
// few chunks and a deflate stream, and node ships zlib. Deterministic, so
// regenerating produces the same bytes.
//
//   npm run icons

import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng } from './png.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url))).replace(/\/tools-dist$/, '');
const OUT = join(ROOT, 'public', 'icons');

// --- the picture -------------------------------------------------------------

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2f) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

const quantise = (value: number): number => Math.max(0, Math.min(255, Math.round(value / 3) * 3));

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = smooth(x - xi);
  const yf = smooth(y - yi);
  const a = hash(xi, yi, seed);
  const b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed);
  const d = hash(xi + 1, yi + 1, seed);
  return (a + (b - a) * xf) * (1 - yf) + (c + (d - c) * xf) * yf;
}

function fbm(x: number, y: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < 4; o++) {
    sum += amp * valueNoise(x, y, seed + o * 17);
    norm += amp;
    amp *= 0.5;
    x *= 2.03;
    y *= 2.03;
  }
  return sum / norm;
}

/** A singularity: a warm halo, a bright core, a faint dust ring and stars.
 *  `inset` keeps the subject inside the maskable safe zone. */
export function renderIcon(size: number, { inset = 1 }: { inset?: number } = {}): Buffer {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size * 0.47;
  const scale = size * 0.5 * inset;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - cx) / scale;
      const dy = (y + 0.5 - cy) / scale;
      const r = Math.hypot(dx, dy);

      // Sky: deep blue at the centre, black at the edges.
      const sky = Math.max(0, 1 - r * 1.25);
      let red = 6 + 20 * sky * sky;
      let green = 8 + 26 * sky * sky;
      let blue = 12 + 52 * sky * sky;

      // Nebula dust, warped so it reads as gas.
      const warp = fbm(dx * 2.6 + 3.1, dy * 2.6 - 1.7, 11);
      const dust = Math.max(0, fbm(dx * 3.4 + warp * 1.6, dy * 3.4 + warp * 1.6, 5) - 0.42) * 2.4 * inset;
      red += dust * 150;
      green += dust * 44;
      blue += dust * 58;

      // The halo and the core.
      const halo = Math.exp(-Math.pow((r - 0.52) / 0.2, 2)) * 0.55 * inset;
      red += halo * 168;
      green += halo * 62;
      blue += halo * 52;
      const core = Math.exp(-Math.pow(r / 0.17, 2));
      red += core * 150;
      green += core * 196;
      blue += core * 235;

      // Stars, thinning away from the centre.
      if (inset > 0.9) {
        const cell = 26;
        const gx = Math.floor(x / cell);
        const gy = Math.floor(y / cell);
        const sx = hash(gx, gy, 91);
        if (sx > 0.86) {
          const px = (gx + 0.2 + hash(gx, gy, 7) * 0.6) * cell;
          const py = (gy + 0.2 + hash(gx, gy, 13) * 0.6) * cell;
          const d = Math.hypot(x - px, y - py);
          const star = Math.exp(-Math.pow(d / 1.35, 2)) * (0.45 + 0.55 * hash(gx, gy, 29));
          const warm = hash(gx, gy, 41);
          red += star * (170 + 60 * warm);
          green += star * 190;
          blue += star * (200 + 55 * warm);
        }
      }

      // A soft vignette, then clip. Channels are quantised by 3: a smooth
      // gradient costs bytes the piece cannot spend on an icon, and no eye can
      // see three levels in a 512px starfield.
      const vig = 1 - 0.45 * Math.max(0, Math.hypot(dx, dy) - 0.7);
      const i = (y * size + x) * 4;
      rgba[i] = quantise(red * vig);
      rgba[i + 1] = quantise(green * vig);
      rgba[i + 2] = quantise(blue * vig);
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const jobs = [
    { name: 'icon-192.png', size: 192, inset: 1 },
    { name: 'icon-512.png', size: 512, inset: 1 },
    // Maskable icons are cropped to a circle by the platform: keep the subject
    // inside the safe zone.
    { name: 'icon-maskable-512.png', size: 512, inset: 0.72 },
  ];
  for (const job of jobs) {
    const pixels = renderIcon(job.size, { inset: job.inset });
    const png = encodePng(job.size, job.size, pixels);
    await fs.writeFile(join(OUT, job.name), png);
    console.log(`wrote icons/${job.name} (${job.size}×${job.size}, ${png.length} bytes)`);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
