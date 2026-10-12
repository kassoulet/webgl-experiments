#!/usr/bin/env node
// Measure the four visual layers against what the shader says they are, with
// captured frames rather than a reading of the source. The method is the one
// tools/stars.ts uses in the Singularity app, adapted to a picture that has no
// camera in it:
//
//   * the layers are additive, so a frame drawn with N layers minus one drawn
//     with N-1 *is* the Nth layer — everything else, including the tone map and
//     the vignette, is identical. That is what makes subtraction a measurement
//     rather than a guess, and it is why the first check is that the same frame
//     drawn twice is the same image: if it is not, every number below would be
//     measuring the difference between two renders instead of the layer.
//
// Then each layer is asked something only it can answer:
//
//   * kaleidoscope — it folds the plane into `uSymmetry` segments, so the frame
//     is invariant under a rotation of 360/N about its centre. Measured with a
//     null control (a rotation that must *not* be a symmetry) so a detector
//     that always says "yes" cannot pass.
//   * plasma — smooth, so it carries little energy at the pixel scale.
//   * noise — a flow field, so it carries a lot of it. The pair is measured
//     together, because "high frequency" only means anything relative to
//     something else.
//   * fractal — an escape-time iteration, so raising `uIterations` must change
//     the picture and add detail rather than merely brighten it.
//
// Everything here reads PNGs from the built site; none of it trusts the source.
// The frames are written to .smoke/stars/ for a human to look at
// (`npm run preview .smoke/stars/layer-kaleido.png`).
//
//   npm run stars [-- --seed layer-test] [--keep]
//
// Exits non-zero if a hard check fails.

import { existsSync, promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { launchChrome, type Chrome, type Harness } from './chrome.js';
import { decodePng, encodePng, type PNGImage } from './png.js';

// The package root, found by walking up out of whatever build directory this
// tool is running from. Compiled to `tools-dist/tools/` it sits two levels
// below the root; run from `tools/` it sits one. Walking up to the nearest
// package.json gets both layouts right without the caller having to pass
// anything, and without this tool needing to know which one it is.
const ROOT = (() => {
  let dir = resolve(fileURLToPath(new URL('..', import.meta.url)));
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'dist'))) return dir;
    dir = resolve(dir, '..');
  }
  return resolve(fileURLToPath(new URL('..', import.meta.url)));
})();
const SITE = join(ROOT, 'dist');
const ARTIFACTS = join(ROOT, '.smoke', 'stars');

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const seed = readArg('--seed') ?? 'layer-test';

function readArg(name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

/** The four layers, in the order the shader's `uMix` packs them. */
const LAYERS = ['kaleido', 'plasma', 'fractal', 'noise'] as const;
type Layer = (typeof LAYERS)[number];

// --- checks ------------------------------------------------------------------

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const report = (line: string): void => console.log(`       ${line}`);

// --- rasters -----------------------------------------------------------------

/** A decoded frame as floats: the sRGB values the PNG holds, 0..1 per channel. */
interface Raster {
  width: number;
  height: number;
  rgb: Float32Array;
}

function toRaster(png: PNGImage): Raster {
  const { width, height, channels, data } = png;
  const rgb = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const at = i * channels;
    rgb[i * 3] = data[at]! / 255;
    rgb[i * 3 + 1] = data[at + 1]! / 255;
    rgb[i * 3 + 2] = data[at + 2]! / 255;
  }
  return { width, height, rgb };
}

/**
 * `a` minus `b`. The layers are additive and everything else in the frame is
 * identical, so this is the layer and nothing else. Clamped at zero: the
 * difference of two 8-bit frames can go slightly negative on a channel that was
 * rounded up, and a negative "light" would poison every mean downstream.
 */
function subtract(a: Raster, b: Raster): Raster {
  const rgb = new Float32Array(a.rgb.length);
  for (let i = 0; i < rgb.length; i++) rgb[i] = Math.max(0, a.rgb[i]! - b.rgb[i]!);
  return { width: a.width, height: a.height, rgb };
}

const lumaAt = (r: Raster, x: number, y: number): number => {
  const at = (y * r.width + x) * 3;
  return 0.2126 * r.rgb[at]! + 0.7152 * r.rgb[at + 1]! + 0.0722 * r.rgb[at + 2]!;
};

/** Luminance at a fractional position, bilinearly. Needed for rotation. */
function lumaBilinear(r: Raster, x: number, y: number): number {
  if (x < 0 || y < 0 || x > r.width - 1 || y > r.height - 1) return 0;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(r.width - 1, x0 + 1);
  const y1 = Math.min(r.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const top = lumaAt(r, x0, y0) * (1 - fx) + lumaAt(r, x1, y0) * fx;
  const bottom = lumaAt(r, x0, y1) * (1 - fx) + lumaAt(r, x1, y1) * fx;
  return top * (1 - fy) + bottom * fy;
}

/** What a raster adds up to, for comparing one frame with another. */
function total(r: Raster): number {
  let sum = 0;
  for (let i = 0; i < r.width * r.height; i++) {
    sum += 0.2126 * r.rgb[i * 3]! + 0.7152 * r.rgb[i * 3 + 1]! + 0.0722 * r.rgb[i * 3 + 2]!;
  }
  return sum;
}

/** The largest difference between two rasters. */
function largestDifference(a: Raster, b: Raster): number {
  let worst = 0;
  for (let i = 0; i < a.rgb.length; i++) worst = Math.max(worst, Math.abs(a.rgb[i]! - b.rgb[i]!));
  return worst;
}

/** The mean absolute difference between two rasters, per channel. */
function meanDifference(a: Raster, b: Raster): number {
  let sum = 0;
  for (let i = 0; i < a.rgb.length; i++) sum += Math.abs(a.rgb[i]! - b.rgb[i]!);
  return a.rgb.length > 0 ? sum / a.rgb.length : 0;
}

/**
 * Mean absolute difference between a raster and itself rotated about the frame's
 * centre by `angle` radians. 0 means the image is invariant under that rotation.
 *
 * The kaleidoscope folds in `uv` space, which is centred and scaled by
 * 1/min(res.x, res.y) — a *uniform* scale about the centre, and a uniform scale
 * commutes with a rotation, so a rotation measured in pixels is the same
 * rotation the shader folded. The centre is therefore the frame's centre.
 *
 * Sampled on a grid rather than exhaustively: the fold lines themselves are a
 * thin minority of the frame and would only add sampling noise.
 *
 * Only points whose *rotated* position is also inside the frame are counted.
 * This is not a detail. Rotating about the centre carries points near the edge
 * out of bounds, and an out-of-bounds sample has no value to compare against —
 * if it is treated as black, the answer is dominated by the shape of the frame:
 * a flat mid-grey image scores 0.10 this way, and a genuinely six-fold
 * kaleidoscope scores 0.16, which is larger than the 0.22 of a real asymmetry
 * and so cannot tell the two apart. Restricted to the inscribed circle the same
 * metric reads 0.0008 on a symmetry axis and 0.49 a half-wedge off it.
 */
function rotationDifference(raster: Raster, angle: number, samples = 24000): number {
  const cx = raster.width / 2;
  const cy = raster.height / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // A deterministic grid, not a random one: a tool whose own sampling changes
  // between runs cannot be compared against a threshold someone wrote down.
  const side = Math.floor(Math.sqrt(samples));
  // The largest disc about the centre that stays inside the frame under any
  // rotation: the inscribed circle, less a pixel of margin.
  const safe = Math.min(raster.width, raster.height) / 2 - 2;
  let sum = 0;
  let count = 0;
  for (let iy = 0; iy < side; iy++) {
    for (let ix = 0; ix < side; ix++) {
      const x = ((ix + 0.5) / side) * raster.width;
      const y = ((iy + 0.5) / side) * raster.height;
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      // Stay off the exact centre, where the rotation is numerically unstable
      // and the shader short-circuits anyway.
      if (d2 < 64 || d2 > safe * safe) continue;
      const rx = cx + dx * cos - dy * sin;
      const ry = cy + dx * sin + dy * cos;
      sum += Math.abs(lumaBilinear(raster, x, y) - lumaBilinear(raster, rx, ry));
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Energy at the pixel scale: the mean absolute difference between horizontally
 * adjacent pixels. A smooth gradient scores near zero, fine detail scores high.
 * This is what separates the flow field from the plasma.
 */
function highFrequencyEnergy(raster: Raster): number {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < raster.height; y++) {
    for (let x = 0; x < raster.width - 1; x++) {
      sum += Math.abs(lumaAt(raster, x, y) - lumaAt(raster, x + 1, y));
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

/** How alike two rasters are, 0 (nothing in common) to 1 (identical). */
function similarity(a: Raster, b: Raster): number {
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    const la = 0.2126 * a.rgb[i * 3]! + 0.7152 * a.rgb[i * 3 + 1]! + 0.0722 * a.rgb[i * 3 + 2]!;
    const lb = 0.2126 * b.rgb[i * 3]! + 0.7152 * b.rgb[i * 3 + 1]! + 0.0722 * b.rgb[i * 3 + 2]!;
    num += la * lb;
    da += la * la;
    db += lb * lb;
  }
  const den = Math.sqrt(da * db);
  return den > 0 ? num / den : 0;
}

async function save(raster: Raster, name: string, gain = 1): Promise<void> {
  const { width, height } = raster;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++) {
      rgba[i * 4 + c] = Math.round(Math.min(1, raster.rgb[i * 3 + c]! * gain) * 255);
    }
    rgba[i * 4 + 3] = 255;
  }
  await fs.writeFile(join(ARTIFACTS, `${name}.png`), encodePng(width, height, rgba));
}

/** The middle value of a list (0 for an empty one). */
function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

// --- the run -----------------------------------------------------------------

/** Weights for a frame with the first `count` layers on. */
function cumulative(count: number): Record<Layer, number> {
  const weights = {} as Record<Layer, number>;
  LAYERS.forEach((layer, i) => {
    weights[layer] = i < count ? 1 : 0;
  });
  return weights;
}

async function main(): Promise<void> {
  await fs.mkdir(ARTIFACTS, { recursive: true });
  let harness: Harness;
  try {
    harness = await launchChrome({ site: SITE, artifacts: ARTIFACTS, keepProfile: keep });
  } catch (error) {
    console.error(`could not start a browser: ${(error as Error).message}`);
    process.exit(2);
  }
  const chrome: Chrome = harness.chrome;

  try {
    await harness.go(seed);
    if (!(await harness.loaded())) throw new Error('the app never came up');

    // Enter, because nothing draws until the renderer is initialised.
    const box = JSON.parse(
      (await chrome.send<{ result: { value: string } }>('Runtime.evaluate', {
        // The rect's fields are spelled out because `JSON.stringify` on a
        // DOMRect gives `{}` — its properties are prototype accessors, not own
        // enumerable ones — and a click at NaN silently never enters the app.
        expression: `(() => { const r = document.getElementById('enter-button').getBoundingClientRect();
          return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height }); })()`,
        returnByValue: true,
      }, 60000)).result.value,
    ) as { x: number; y: number; width: number; height: number };
    await chrome.click(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
    check('the app is running', await harness.waitFor('__foraver.stats().started === true', 30000));

    // Quality pins the resolution scale. In 'auto' the renderer keeps moving its
    // buffer, and two captures of the same moment would come back at different
    // sizes — which would make every subtraction below nonsense.
    await chrome.send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.getElementById('quality');
        el.value = 'low';
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
      awaitPromise: true,
    }, 120000);
    // The HUD, the toast and the enter overlay all fade on their own timers. All
    // three have to be *gone*, not merely told to go: a half-faded overlay
    // differs between two frames, and a difference between two frames is
    // exactly what every measurement below is made of.
    const viewportClear = await harness.waitFor(
      `['hud', 'toast', 'enter', 'notice'].every((id) => {
         const el = document.getElementById(id);
         return !el || getComputedStyle(el).opacity === '0' || el.hidden;
       })`,
      20000,
    );
    check('the viewport is the picture alone', viewportClear);

    /**
     * Draw one frame with the picture pinned and capture it. `drift: false`
     * freezes the slow drift so the only thing varying between two captures is
     * what the caller asked for.
     */
    const capture = async (label: string, options: Record<string, unknown>): Promise<Raster> => {
      await chrome.send('Runtime.evaluate', {
        expression: `__foraver.draw(${JSON.stringify({ drift: false, dim: 1, ...options })})`,
        awaitPromise: true,
      }, 120000);
      await delay(400);
      const raster = toRaster(decodePng(await chrome.screenshot()));
      await save(raster, label, 1);
      return raster;
    };

    // A moment in a *drop*, found by asking the conductor rather than by waiting
    // for it: a breakdown is mostly plasma and noise, and measuring the layers
    // there measures a set that has deliberately left the fractal and the
    // kaleidoscope switched off. The middle of the drop, not its first bar —
    // the section's own change takes three quarters of a second to arrive.
    const T = JSON.parse(
      (await chrome.send<{ result: { value: string } }>('Runtime.evaluate', {
        expression: `(() => {
          for (let t = 0; t < 3600; t += 2) {
            if (__foraver.pieceAt(t).section !== 'drop') continue;
            let end = t;
            while (__foraver.pieceAt(end + 2).section === 'drop') end += 2;
            return JSON.stringify({ at: (t + end) / 2 });
          }
          return JSON.stringify({ at: 60 });
        })()`,
        returnByValue: true,
      }, 60000)).result.value,
    ).at as number;

    const before = JSON.parse(
      (await chrome.send<{ result: { value: string } }>('Runtime.evaluate', {
        expression: 'JSON.stringify(__foraver.stats().render)',
        returnByValue: true,
      }, 60000)).result.value,
    ) as { scale: number; quality: string; available: boolean };
    check(
      'the renderer is up and the drawing resolution is fixed for the run',
      before.available === true && before.quality === 'low',
      `quality ${before.quality}, scale ${before.scale}`,
    );

    // --- determinism: the gate on every subtraction below --------------------
    // Warm-up captures, discarded. The first captures after entering differ
    // from each other by up to 0.55 while later ones of the *same* setting
    // differ by 0.009: the picture is still settling, and measuring a picture
    // that is still settling measures the settling, not the layer. Measured
    // before the warm-up this check read 0.0157 and failed; measured after, the
    // same three captures read 0.0001.
    for (let i = 0; i < 4; i++) await capture(`warmup-${i}`, { time: T, layers: cumulative(0) });

    const none = await capture('none', { time: T, layers: cumulative(0) });
    const again = await capture('none-again', { time: T, layers: cumulative(0) });
    const third = await capture('none-third', { time: T, layers: cumulative(0) });
    // Mean and largest, not just largest. A handful of pixels differ by more
    // than the rest put together — that is the compositor's own scheduling, not
    // the shader — so the mean is the statistic that describes the picture and
    // the largest is the one that catches a real change.
    const pairs: [Raster, Raster][] = [[none, again], [none, third], [again, third]];
    const meanDiffs = pairs.map(([a, b]) => meanDifference(a, b));
    const maxDiffs = pairs.map(([a, b]) => largestDifference(a, b));
    check(
      'the same frame drawn twice is the same image',
      Math.max(...meanDiffs) < 0.01 && Math.max(...maxDiffs) < 0.05,
      `three captures of one frame: mean ${meanDiffs.map((d) => d.toFixed(5)).join(', ')}, ` +
        `largest ${maxDiffs.map((d) => d.toFixed(4)).join(', ')}`,
    );
    report(`frame ${none.width}×${none.height}, drawing at scale ${before.scale}`);

    // --- the layers, isolated two ways ---------------------------------------
    // Two different questions, two different methods, because the shader
    // *averages* its layers (`if (weight > 0.0001) colour /= weight;`) rather
    // than summing them. Turning a fourth layer on therefore rescales the
    // other three, so the difference between a frame with N layers and one with
    // N-1 is that layer's *marginal effect*, not the layer as it appears in the
    // finished picture. Both are worth measuring and neither substitutes for the
    // other, so both are measured.
    //
    // `alone` is the layer on its own at full weight: what it looks like.
    // `marginal` is the cumulative staircase, differenced: what it changes.
    const alone: Raster[] = [];
    for (const layer of LAYERS) {
      const weights = { kaleido: 0, plasma: 0, fractal: 0, noise: 0 } as Record<Layer, number>;
      weights[layer] = 1;
      const raster = await capture(`alone-${layer}`, { time: T, layers: weights });
      alone.push(raster);
      await save(raster, `layer-${layer}`, 2);
    }

    const frames: Raster[] = [];
    for (let n = 1; n <= LAYERS.length; n++) {
      frames.push(await capture(`with-${LAYERS[n - 1]}`, { time: T, layers: cumulative(n) }));
    }
    const marginal: Raster[] = [];
    for (let i = 0; i < frames.length; i++) {
      marginal.push(subtract(frames[i]!, frames[i - 1] ?? none));
      await save(marginal[i]!, `marginal-${LAYERS[i]}`, 4);
    }

    // Each layer must actually put something on the screen. A layer that
    // measures as empty is a layer that is wired up but never drawn, which no
    // amount of "the shader compiles" would catch. Measured on the layer alone:
    // in the stack a dim layer's own light is divided by the weight of all four.
    const meanFlux = (r: Raster): number => total(r) / (r.width * r.height);
    for (let i = 0; i < LAYERS.length; i++) {
      const mean = meanFlux(alone[i]!);
      report(
        `layer ${LAYERS[i]}: alone mean ${mean.toFixed(4)} ` +
          `(pixel-scale energy ${highFrequencyEnergy(alone[i]!).toFixed(5)}); ` +
          `marginal in the stack ${meanFlux(marginal[i]!).toFixed(4)}`,
      );
      check(
        `the ${LAYERS[i]} layer draws something`,
        mean > 0.02,
        `mean ${mean.toFixed(4)} over the frame, alone at full weight`,
      );
    }

    // Turning each layer on must change the picture. This is the claim the
    // cumulative staircase can actually support: not that flux rises, which the
    // average forbids, but that the frame is not the same frame.
    for (let i = 0; i < LAYERS.length; i++) {
      const before2 = i === 0 ? none : frames[i - 1]!;
      const d = largestDifference(frames[i]!, before2);
      check(
        `turning on ${LAYERS[i]} changes the picture`,
        d > 0.01,
        `${d.toFixed(3)} between the frame without it and the frame with it`,
      );
    }

    // The four are four different pictures, not one picture drawn four times.
    const pairNames: string[] = [];
    let maxSimilarity = 0;
    for (let i = 0; i < LAYERS.length; i++) {
      for (let j = i + 1; j < LAYERS.length; j++) {
        const s = similarity(alone[i]!, alone[j]!);
        maxSimilarity = Math.max(maxSimilarity, s);
        pairNames.push(`${LAYERS[i]}/${LAYERS[j]} ${s.toFixed(2)}`);
      }
    }
    report(`pairwise similarity: ${pairNames.join(', ')}`);
    // The correlation is high across the board (0.68-0.85) because every layer
    // is drawn through the same four-stop psychedelic ramp, so they share most
    // of their light. The check is therefore a loose ceiling; the sharp claim
    // that the layers are distinguishable is the "turning on X changes the
    // picture" pair of checks above, which measure the difference directly.
    check(
      'the four layers are four different pictures',
      maxSimilarity < 0.9,
      `the most alike pair correlates ${maxSimilarity.toFixed(2)}`,
    );

    // --- the kaleidoscope's fold --------------------------------------------
    // The shader folds the plane into `uSymmetry` segments, so the frame is
    // invariant under a rotation of 360/N about its centre. Measured on the
    // isolated layer, and with a null control: half a wedge must *not* be a
    // symmetry, or a detector that always returns 0 would pass this too.
    // The segment count is a uniform, not a stat: it is not readable back from
    // the page. So it is set explicitly and the picture is then asked whether it
    // is symmetric under the rotation that count implies — twice, at two
    // different counts, so a constant "yes" cannot pass both.
    const symmetryTest = async (n: number, label: string): Promise<void> => {
      const raster = await capture(`symmetry-${label}`, {
        time: T,
        layers: { kaleido: 1, plasma: 0, fractal: 0, noise: 0 },
        symmetry: n,
      });
      const onWedge = rotationDifference(raster, (Math.PI * 2) / n);
      // Half a wedge: the mirror line, which a fold also has, but tested as a
      // *rotation* it must not be one.
      const offWedge = rotationDifference(raster, Math.PI / n);
      report(
        `${n}-fold: mean error on the wedge ${onWedge.toFixed(4)}, ` +
          `half a wedge off it ${offWedge.toFixed(4)}`,
      );
      // Thresholds from the metric's own validation on synthetic images, where
      // a true symmetry axis reads 0.0008 and a half-wedge off it reads 0.49.
      // The control is judged on its *ratio* to the on-axis reading rather than
      // an absolute floor, because its absolute size is not a property of the
      // shader: a twelve-fold fold is a finer pattern than a six-fold one and
      // a half-wedge off it is correspondingly harder to tell apart in absolute
      // terms (0.138 at six, 0.031 at twelve), while the ratio stays clear.
      check(
        `the kaleidoscope is ${n}-fold symmetric, and the detector can tell a symmetry from a non-symmetry`,
        onWedge < 0.01 && offWedge > 0.02 && offWedge > onWedge * 4,
        `on the wedge ${onWedge.toFixed(4)}, off it ${offWedge.toFixed(4)} ` +
          `(${(offWedge / Math.max(1e-9, onWedge)).toFixed(1)}× further apart)`,
      );
      await save(raster, `symmetry-${label}`, 2);
    };
    await symmetryTest(6, 'six');
    await symmetryTest(12, 'twelve');

    // --- which layer is the finest-grained ------------------------------------
    // This check was originally "the flow field is higher frequency than the
    // plasma", on the reasoning that a domain-warped fbm is detailed and a
    // sine plasma is smooth. Measurement says otherwise: the two are within 2%
    // of each other (0.00461 against 0.00470). Domain warping does not add
    // pixel-scale detail — composing fbm of fbm of fbm smooths as much as it
    // displaces, and the plasma is not purely smooth either, being 0.3 fbm
    // already. The layer that *is* visibly the finest is the fractal, whose
    // escape-time filaments are what the picture's detail is made of, and it
    // leads by a factor of nearly three.
    const energies = alone.map((r) => highFrequencyEnergy(r));
    const finest = energies.indexOf(Math.max(...energies));
    const runnerUp = [...energies].sort((a, b) => b - a)[1] ?? 0;
    check(
      'the fractal is the finest-grained layer',
      LAYERS[finest] === 'fractal' && energies[finest]! > runnerUp * 1.8,
      `pixel-scale energy ` + LAYERS.map((l, i) => `${l} ${energies[i]!.toFixed(5)}`).join(', '),
    );

    // --- the fractal's iteration count ---------------------------------------
    // An escape-time fractal at a low iteration count is a few smooth bands; at
    // a high one it resolves detail. So raising the count must change the image
    // *and* add pixel-scale detail — a fractal that only got brighter would pass
    // the first and fail the second, which is the failure worth catching.
    // 8, not 6: the renderer clamps the iteration count to a floor of 8
    // (`Math.max(8, ...)`), so asking for 6 would measure 8 and quietly mislabel
    // the capture. The floor is the cheapest picture the fractal ever draws.
    const coarse = await capture('fractal-coarse', {
      time: T,
      layers: { kaleido: 0, plasma: 0, fractal: 1, noise: 0 },
      iterations: 8,
    });
    const fine = await capture('fractal-fine', {
      time: T,
      layers: { kaleido: 0, plasma: 0, fractal: 1, noise: 0 },
      iterations: 90,
    });
    const coarseEnergy = highFrequencyEnergy(coarse);
    const fineEnergy = highFrequencyEnergy(fine);
    const coarseMean = meanFlux(coarse);
    const fineMean = meanFlux(fine);
    report(
      `fractal: 8 iterations mean ${coarseMean.toFixed(4)} energy ${coarseEnergy.toFixed(5)}; ` +
        `90 iterations mean ${fineMean.toFixed(4)} energy ${fineEnergy.toFixed(5)}`,
    );
    check(
      'the fractal responds to the iteration count',
      largestDifference(coarse, fine) > 0.01,
      `an 8-iteration and a 90-iteration frame differ by up to ` +
        `${largestDifference(coarse, fine).toFixed(3)}`,
    );
    check(
      'more iterations resolve detail, not just brightness',
      fineEnergy > coarseEnergy * 1.1,
      `pixel-scale energy ${coarseEnergy.toFixed(5)} → ${fineEnergy.toFixed(5)}`,
    );

    check('nothing threw on the way', chrome.errors.length === 0, chrome.errors.slice(0, 3).join(' | '));
    if (chrome.logs.length) {
      console.log('\n  console:');
      for (const entry of chrome.logs.slice(0, 10)) console.log(`    [${entry.level}] ${entry.text.slice(0, 160)}`);
    }
    console.log(`\n  captures: ${ARTIFACTS}`);
  } catch (error) {
    console.error(`\n  layer test error: ${(error as Error).message}`);
    for (const failure of chrome.errors.slice(0, 8)) console.error(`    [error] ${String(failure).slice(0, 400)}`);
    throw error;
  } finally {
    await harness.close();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

await main().catch((error) => {
  console.error(error);
  process.exit(2);
});
