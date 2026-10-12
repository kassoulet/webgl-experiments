#!/usr/bin/env node
// Show a captured frame in a terminal. Rendering cannot be verified from logs,
// and there is often no display to look at, so this prints the frame as colour
// blocks plus the numbers that matter for *this* app: how dark the picture is
// against the reference's 64.9% black, where the light is row by row (the trace
// belongs in a band, the spectrum along the bottom, and the gap between them
// should be empty), and the shape of the histogram.
//
//   npm run preview [-- --cols 100] [--ascii] [, or any .png path]

import { promises as fs } from 'node:fs';
import { decodePng, analyse, regionMean } from './png.ts';

const args = process.argv.slice(2);
// The file is the argument that is not a flag *and* not a flag's value: without
// that, `preview --cols 60 frame.png` opens a file called `60`.
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i]?.startsWith('--')) {
    // A flag's value is the next argument, unless that is itself a flag: `--ascii`
    // takes none, and swallowing whatever follows it would eat the file name.
    if (!args[i + 1]?.startsWith('--')) i++;
    continue;
  }
  positional.push(args[i] as string);
}
const file = positional[0] ?? '.smoke/smoke.png';
const cols = Number(args[args.indexOf('--cols') + 1]) || 96;
const ascii = args.includes('--ascii');

/**
 * The same 0.12 luma threshold `tmp/jeffer/frames.py` counted the reference
 * with, because a comparison against a number taken with a different definition
 * is not a comparison in either direction.
 */
const DARK_LUMA = 0.12;

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

// The reference is 64.9% pure black, its frames sit between 0.00 and 0.13 mean
// luminance, and between 47% and 100% of every frame is below a 0.12 luma. This
// app's picture is measured against those numbers, not against its own history.
let dark = 0;
const pixels = width * height;
for (let i = 0; i < pixels; i++) {
  const at = i * image.channels;
  const luma = (0.2126 * image.data[at] + 0.7152 * image.data[at + 1] + 0.0722 * image.data[at + 2]) / 255;
  if (luma < DARK_LUMA) dark++;
}
console.log(
  `dark ${((dark / pixels) * 100).toFixed(1)}% below ${DARK_LUMA} luma ` +
    `(the reference: 47–100%, 64.9% of it pure black)`,
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

// A luminance histogram. For this app a healthy frame is a low, narrow hump
// with a long tail: most of the picture is black, and the trace is a small very
// bright thing inside it. A mean that has crept towards the ceiling is
// exposure; a histogram collapsed into one low bin is a trace that stopped
// being drawn.
const bins = new Array(12).fill(0);
for (let i = 0; i < pixels; i++) {
  const at = i * image.channels;
  const luma = (0.2126 * image.data[at] + 0.7152 * image.data[at + 1] + 0.0722 * image.data[at + 2]) / 255;
  bins[Math.min(bins.length - 1, Math.floor(luma * bins.length))]++;
}
console.log(
  bins
    .map((count, i) => `${(i / bins.length).toFixed(2)}=${((count / pixels) * 100).toFixed(1)}%`)
    .join('  '),
);

// Where the light is, row by row: the mean luminance of each of forty bands, as
// a fraction of the frame's height from the top. This is the measurement the
// smoke test's scope checks are built on, printed so a frame can be read by eye.
// The bands it marks are the shader's own layout: the trace sits at 33% (its
// centre line) inside 26–52%, the spectrum runs along 72–97%, and the gap
// between the graticule and the spectrum (58–70%) is supposed to be empty.
const BANDS = 40;
const profile = new Array(BANDS).fill(0);
for (let y = 0; y < height; y++) {
  let sum = 0;
  for (let x = 0; x < width; x++) {
    const at = (y * width + x) * image.channels;
    sum += 0.2126 * image.data[at] + 0.7152 * image.data[at + 1] + 0.0722 * image.data[at + 2];
  }
  const band = Math.min(BANDS - 1, Math.floor((y / height) * BANDS));
  profile[band] = (profile[band] as number) + sum / (width * 255);
}
for (let i = 0; i < BANDS; i++) profile[i] = (profile[i] as number) / (height / BANDS);

const peak = Math.max(...profile, 1e-6);
const bandOf = (fraction: number): number => Math.min(BANDS - 1, Math.floor(fraction * BANDS));
const marks: Record<number, string> = {
  [bandOf(0.33)]: 'trace',
  [bandOf(0.58)]: 'gap',
  [bandOf(0.85)]: 'spectrum',
};
console.log('\nrow profile (mean luma per band, ▁▂▃▄▅▆▇█):');
profile.forEach((value, i) => {
  const at = ((i + 0.5) / BANDS).toFixed(2);
  const bar = RAMP[Math.min(RAMP.length - 1, Math.max(1, Math.round((value / peak) * (RAMP.length - 1))))];
  const mark = marks[i] ? `  <- ${marks[i]}` : '';
  console.log(`  ${at}  ${bar}  ${(value * 100).toFixed(2)}%${mark}`);
});
const brightest = profile.indexOf(peak);
console.log(
  `brightest band ${((brightest + 0.5) / BANDS).toFixed(2)} at ${(peak * 100).toFixed(2)}% mean luma`,
);
