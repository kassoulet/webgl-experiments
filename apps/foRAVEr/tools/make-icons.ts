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

/** The kaleidoscope fold, the same shape the shader folds with. */
function fold(angle: number, segments: number): number {
  const wedge = (Math.PI * 2) / segments;
  const a = ((angle % wedge) + wedge) % wedge;
  return Math.abs(a - wedge / 2);
}

/** A six-fold kaleidoscope over a warped plasma field, in the set's acid
 *  palette. `inset` keeps the subject inside the maskable safe zone. */
export function renderIcon(size: number, { inset = 1, segments = 6 }: { inset?: number; segments?: number } = {}): Buffer {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const scale = size * 0.5 * inset;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - cx) / scale;
      const dy = (y + 0.5 - cy) / scale;
      const r = Math.hypot(dx, dy);
      const a = fold(Math.atan2(dy, dx), segments);

      // The background: a dark violet that goes black at the edge.
      const sky = Math.max(0, 1 - r * 0.9);
      let red = 7 + 22 * sky * sky;
      let green = 5 + 6 * sky * sky;
      let blue = 12 + 48 * sky * sky;

      // The folded field: a warp on the folded coordinates, so the petals bend.
      const fx = Math.cos(a) * r;
      const fy = Math.sin(a) * r;
      const warp = fbm(fx * 2.4 + 4.1, fy * 2.4 - 2.3, 11);
      const field = Math.max(0, fbm(fx * 3.6 + warp * 1.8, fy * 3.6 + warp * 1.8, 5) - 0.38) * 2.6 * inset;

      // A hard seam on the fold line, which is what makes it read as a
      // kaleidoscope rather than as a blob.
      const seam = Math.exp(-Math.pow((r - 0.62) / 0.05, 2)) * inset;

      const hot = field * (1 - 0.5 * r);
      red += hot * 200;
      green += hot * 255;
      blue += hot * 61;
      red += seam * 255;
      green += seam * 45;
      blue += seam * 149;

      // The core, and a soft vignette around it.
      const core = Math.exp(-Math.pow(r / 0.16, 2));
      red += core * 200;
      green += core * 255;
      blue += core * 208;
      const vig = 1 - 0.5 * Math.max(0, r - 0.8);
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
    { name: 'icon-maskable-512.png', size: 512, inset: 0.7 },
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
