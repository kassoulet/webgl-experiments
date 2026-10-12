#!/usr/bin/env node
// Show a captured frame in a terminal. Rendering cannot be verified from logs,
// and there is often no display to look at, so this prints the frame as colour
// blocks plus a few numbers: enough to see whether the picture is black, whether
// it has structure, and where the colour is.
//
//   npm run preview [-- --cols 100] [--ascii] [, or any .png path]

import { promises as fs } from 'node:fs';
import { decodePng, analyse, regionMean } from './png.ts';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--')) ?? '.smoke/drop.png';
const cols = Number(args[args.indexOf('--cols') + 1]) || 96;
const ascii = args.includes('--ascii');

const image = decodePng(await fs.readFile(file));
const { width, height } = image;
const rows = Math.max(1, Math.round((cols * height) / width / 2));
const cellW = width / cols;
const cellH = height / rows;

const RAMP = ' .:-=+*#%@';
console.log(`${file}: ${width}×${height}`);

let out = '';
for (let cy = 0; cy < rows; cy++) {
  let line = '';
  for (let cx = 0; cx < cols; cx++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    const x1 = Math.floor((cx + 1) * cellW);
    const y1 = Math.floor((cy + 1) * cellH);
    for (let y = Math.floor(cy * cellH); y < y1; y += Math.max(1, Math.floor(cellH / 3))) {
      for (let x = Math.floor(cx * cellW); x < x1; x += Math.max(1, Math.floor(cellW / 3))) {
        const at = (y * width + x) * image.channels;
        r += image.data[at];
        g += image.data[at + 1];
        b += image.data[at + 2];
        n++;
      }
    }
    r = Math.round(r / n);
    g = Math.round(g / n);
    b = Math.round(b / n);
    if (ascii) {
      const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      line += RAMP[Math.min(RAMP.length - 1, Math.round(luma * (RAMP.length - 1)))];
    } else {
      // Two spaces per cell keeps the aspect ratio of a monospace cell roughly.
      line += `\x1b[38;2;${r};${g};${b}m██\x1b[0m`;
    }
  }
  out += `${line}\n`;
}
console.log(out);

const measured = analyse(image);
console.log(
  `mean ${measured.mean.toFixed(4)}  stdev ${measured.stdev.toFixed(4)}  max ${measured.max.toFixed(3)}  ` +
    `lit ${(measured.litFraction * 100).toFixed(1)}%  colour ${(measured.colourFraction * 100).toFixed(1)}%`,
);
console.log(
  `centre ${regionMean(image, 0.35, 0.35, 0.65, 0.65).toFixed(4)}  ` +
    `corners ${[
      regionMean(image, 0, 0, 0.15, 0.15),
      regionMean(image, 0.85, 0, 1, 0.15),
      regionMean(image, 0, 0.85, 0.15, 1),
      regionMean(image, 0.85, 0.85, 1, 1),
    ]
      .map((v) => v.toFixed(4))
      .join(' ')}`,
);

// A luminance histogram: for this app a healthy drop is a broad hump centred
// near 0.5, because the picture is meant to be bright and saturated. A mean that
// has crept towards the ceiling is exposure; a histogram collapsed into one low
// bin is a layer that stopped moving.
const bins = new Array(12).fill(0);
for (let i = 0; i < image.width * image.height; i++) {
  const at = i * image.channels;
  const luma = (0.2126 * image.data[at] + 0.7152 * image.data[at + 1] + 0.0722 * image.data[at + 2]) / 255;
  bins[Math.min(bins.length - 1, Math.floor(luma * bins.length))]++;
}
const total = image.width * image.height;
console.log(
  bins
    .map((count, i) => `${(i / bins.length).toFixed(2)}=${((count / total) * 100).toFixed(1)}%`)
    .join('  '),
);
