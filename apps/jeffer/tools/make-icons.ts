#!/usr/bin/env node
// Writes the PNG icons the manifest asks for, with no image library: a PNG is a
// few chunks and a deflate stream, and node ships zlib. Deterministic, so
// regenerating produces the same bytes.
//
//   npm run icons
//
// The picture is the app's own: an oscilloscope trace across a graticule, with
// the spectrum along the bottom, in the palette measured off the reference. The
// waveform is generated rather than hand-listed, from a kick with an exponential
// decay under a sixteenth-note bass line — the two things the arrangement is
// actually built out of, so the icon is a picture of the music and not a picture
// of a sine wave.

import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng } from './png.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, 'public', 'icons');

// The measured palette, in display bytes. Kept as numbers rather than hex so
// they can be mixed; see src/palette.ts for where they came from.
const VOID = [0, 0, 8] as const;
const DEEP = [18, 18, 60] as const;
const GRID = [36, 36, 109] as const;
const VIOLET = [73, 36, 182] as const;
const HOT = [125, 92, 255] as const;
const RED = [109, 36, 36] as const;
const WARM = [255, 74, 61] as const;

type Triple = readonly [number, number, number];

const mix = (a: Triple, b: Triple, t: number): Triple => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** The signal, in -1..1, at a position along the trace. */
function trace(x: number): number {
  // Four kicks across the box, not one per bar: at this width a kick every two
  // bars lands on the left and right edges, where the crop eats it, and the
  // trace reads as a straight line. Four across the whole trace is what a
  // triggered scope window of two bars actually shows.
  const sinceBeat = (x * 4) % 1;
  const kick = Math.exp(-sinceBeat * 5) * Math.sin(sinceBeat * 150) * 0.9;
  // The bass line on the sixteenths: a rolling figure, not a held note.
  const step = Math.floor(x * 32);
  const withinStep = (x * 32) % 1;
  const tones = [1, 1.5, 1, 0.75, 1, 1, 0.5, 0.75];
  const tone = tones[step % tones.length] as number;
  const bass = Math.sin(withinStep * Math.PI * 2 * 2) * Math.exp(-withinStep * 2.6) * 0.3 * tone;
  return clampSigned(kick + bass);
}

const clampSigned = (v: number): number => Math.max(-1, Math.min(1, v));

/** The spectrum bars, in 0..1, for the icon's lower band. */
function bar(index: number, count: number): number {
  // A bass-heavy spectrum, decaying with a couple of peaks in it, which is what
  // this music's actually looks like: 62 Hz at full, 125 at 0.6, and very little
  // above 2 kHz.
  const f = (index + 0.5) / count;
  const base = Math.exp(-f * 3.4);
  const peak = Math.exp(-Math.pow((f - 0.16) / 0.07, 2)) * 0.5;
  const shelf = Math.exp(-Math.pow((f - 0.42) / 0.12, 2)) * 0.22;
  return clamp01(base * 0.75 + peak + shelf);
}

/** A distance to the trace, in the same units the loop measures in. */
function traceDistance(px: number, py: number, samples: { x: number; y: number }[]): number {
  let best = Infinity;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1] as { x: number; y: number };
    const b = samples[i] as { x: number; y: number };
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared > 0 ? clamp01(((px - a.x) * dx + (py - a.y) * dy) / lengthSquared) : 0;
    const d = Math.hypot(px - (a.x + dx * t), py - (a.y + dy * t));
    if (d < best) best = d;
  }
  return best;
}

/**
 * The icon. `inset` keeps the subject inside the maskable safe zone, which for a
 * wide trace means shrinking the box rather than the whole picture — the box is
 * what gets cropped, so shrinking the box and leaving the graticule full width
 * is what keeps it legible once a platform has made it a circle.
 */
export function renderIcon(
  size: number,
  { inset = 1 }: { inset?: number } = {},
): Buffer {
  const rgba = Buffer.alloc(size * size * 4);
  const s = size / 512; // everything below is written at 512 and scaled

  // The trace, sampled once and reused for every pixel.
  const samples: { x: number; y: number }[] = [];
  const boxLeft = 56 * s;
  const boxRight = 456 * s;
  const boxTop = 176 * s;
  const boxBottom = 336 * s;
  const centreY = (boxTop + boxBottom) / 2;
  const amplitude = ((boxBottom - boxTop) / 2) * 0.9 * inset;
  for (let i = 0; i <= 512; i++) {
    const u = i / 512;
    samples.push({ x: boxLeft + u * (boxRight - boxLeft), y: centreY - trace(u) * amplitude });
  }

  const barCount = 24;
  const barTop = 438 * s;
  const barWidth = 12 * s;
  const barGap = 6 * s;
  const barsLeft = 64 * s;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      // The background: the app's black, with the violet wash in the middle.
      const r = Math.hypot((px - size / 2) / (size / 2), (py - size / 2) / (size / 2));
      const wash = Math.max(0, 1 - r) ** 2;
      let red = VOID[0] + VIOLET[0] * wash * 0.16;
      let green = VOID[1] + VIOLET[1] * wash * 0.16;
      let blue = VOID[2] + VIOLET[2] * wash * 0.16;

      // The graticule: the box, its border, and the interior divisions. The
      // interior is much fainter than the border, which is how a real one is.
      const onBox =
        px >= boxLeft && px <= boxRight && py >= boxTop && py <= boxBottom;
      const border = Math.min(
        Math.abs(px - boxLeft),
        Math.abs(px - boxRight),
        Math.abs(py - boxTop),
        Math.abs(py - boxBottom),
      );
      if (onBox && border < 1.6 * s) {
        const edge: Triple = GRID;
        red += edge[0]; green += edge[1]; blue += edge[2];
      } else if (onBox) {
        const gx = ((px - boxLeft) / ((boxRight - boxLeft) / 10)) % 1;
        const gy = ((py - boxTop) / ((boxBottom - boxTop) / 8)) % 1;
        const onDivision =
          Math.min(gx, 1 - gx) * ((boxRight - boxLeft) / 10) < 0.9 * s ||
          Math.min(gy, 1 - gy) * ((boxBottom - boxTop) / 8) < 0.9 * s;
        if (onDivision) {
          red += GRID[0] * 0.5; green += GRID[1] * 0.5; blue += GRID[2] * 0.5;
        }
      }

      // The trace, twice: a wide dim halo and a narrow hot core. This is the
      // same two-weight trick the bloom pass plays on the real picture, done by
      // hand because there is no GPU here.
      const d = traceDistance(px, py, samples);
      const u = clamp01((px - boxLeft) / (boxRight - boxLeft));
      const stroke: Triple = u < 0.5 ? mix(VIOLET, HOT, u * 2) : mix(HOT, WARM, (u - 0.5) * 2);
      const core = Math.exp(-Math.pow(d / (2.6 * s), 2));
      const halo = Math.exp(-Math.pow(d / (11 * s), 2)) * 0.35;
      const light = Math.min(1.4, core + halo);
      red += stroke[0] * light;
      green += stroke[1] * light;
      blue += stroke[2] * light;

      // The spectrum, along the bottom.
      const index = Math.floor((px - barsLeft) / (barWidth + barGap));
      if (index >= 0 && index < barCount) {
        const local = px - (barsLeft + index * (barWidth + barGap));
        if (local >= 0 && local <= barWidth) {
          const height = bar(index, barCount) * 78 * s * inset;
          const top = barTop - height;
          if (py >= top && py <= barTop) {
            const fade = 0.5 + 0.5 * (1 - (py - top) / Math.max(1, height));
            const colour: Triple = mix(VIOLET, HOT, index / barCount);
            const weight = 0.55 + 0.45 * fade;
            red += colour[0] * weight;
            green += colour[1] * weight;
            blue += colour[2] * weight;
          }
        }
      }
      // The analyser's floor.
      if (Math.abs(py - barTop) < 1.5 * s && px > barsLeft - 8 * s && px < 456 * s) {
        red += GRID[0] * 0.6; green += GRID[1] * 0.6; blue += GRID[2] * 0.6;
      }

      // A soft vignette, so the corners of a square icon are not competing with
      // the trace for attention.
      const vignette = 1 - 0.45 * clamp01((r - 0.55) / 0.45);
      const i = (y * size + x) * 4;
      rgba[i] = quantise(red * vignette);
      rgba[i + 1] = quantise(green * vignette);
      rgba[i + 2] = quantise(blue * vignette);
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

/** Rounded to a multiple of three: a smooth gradient across a few hundred
 *  pixels bands visibly on an 8-bit display, and stepping the quantisation is
 *  cheaper than dithering the output. */
const quantise = (value: number): number => Math.max(0, Math.min(255, Math.round(value / 3) * 3));

async function main(): Promise<void> {
  await fs.mkdir(OUT, { recursive: true });
  const jobs = [
    { name: 'icon-192.png', size: 192, inset: 1 },
    { name: 'icon-512.png', size: 512, inset: 1 },
    // Maskable icons are cropped to a circle by the platform: keep the trace
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

await main();
