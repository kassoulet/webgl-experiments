#!/usr/bin/env node
// Writes the PNG icons the manifest asks for, with no image library: a PNG is a
// few chunks and a deflate stream, and node ships zlib. Deterministic, so
// regenerating produces the same bytes.
//
//   npm run icons

import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng } from './png.ts';

// The package root, whether this file is running from `tools/` (a node with
// TypeScript support) or from `tools-dist/tools/` (one without).
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

/** Aurora curtains: vertical bands of fbm, brightest where they fold. */
function curtain(x: number, y: number, seed: number): number {
  const band = fbm(x * 1.6, seed * 0.37, seed) * 2.2;
  const d = Math.abs((y % 1) - band % 1);
  const fold = Math.exp(-Math.pow(d / 0.09, 2));
  const height = Math.max(0, 1 - y * 0.75);
  return fold * height * (0.55 + 0.45 * fbm(x * 3, y * 1.2, seed + 5));
}

/**
 * The icon: green-teal curtains over a deep night sky with stars, and a violet
 * glow where the curtains are brightest. `inset` keeps the subject inside the
 * maskable safe zone.
 */
export function renderIcon(size: number, { inset = 1 }: { inset?: number } = {}): Buffer {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size - 0.5) * (2 / inset) + 0.5;
      const v = ((y + 0.5) / size - 0.5) * (2 / inset) + 0.5;

      // The night sky: near-black indigo, darker at the bottom.
      const sky = Math.max(0, 1 - v * 0.55);
      let red = 4 + 10 * sky * sky;
      let green = 6 + 12 * sky * sky;
      let blue = 16 + 34 * sky * sky;

      // Stars: sparse bright dots, only in the upper half.
      const starCell = hash(Math.floor(u * 28), Math.floor(v * 28), 91);
      if (starCell > 0.985 && v < 0.55) {
        red += 220;
        green += 225;
        blue += 255;
      }

      // The curtains, lit green-teal with a violet fringe.
      const c = curtain(u * 1.4 + 0.3, v * 1.1, 17) * inset;
      red += c * 40;
      green += c * 235;
      blue += c * 190;
      const fringe = Math.max(0, c - 0.55) * 2.2;
      red += fringe * 190;
      blue += fringe * 120;

      const vig = 1 - 0.35 * Math.max(0, Math.hypot(u - 0.5, v - 0.5) - 0.7);
      const i = (y * size + x) * 4;
      rgba[i] = quantise(red * vig);
      rgba[i + 1] = quantise(green * vig);
      rgba[i + 2] = quantise(blue * vig);
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

async function main(): Promise<void> {
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
    console.log(`wrote public/icons/${job.name} (${job.size}×${job.size}, ${png.length} bytes)`);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
