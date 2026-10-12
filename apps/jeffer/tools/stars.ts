#!/usr/bin/env node
// Measure the four visual layers against what the shader says they are, with
// captured frames rather than a reading of the source.
//
// The method is the one apps/fo-raver uses — the layers are isolated by
// subtraction, with a determinism gate first — but it cannot be copied blindly,
// because Jeffer's four layers do not compose the same way. What each one does to
// a frame decides what can honestly be measured, and the tool says which is which
// rather than pretending they are all the same:
//
//   scope   purely additive (`c += phosphor(rms) * trace * uMix.x`), so a frame
//           with the scope on minus one with it off *is* the trace. Measured as
//           the layer, and checked to be a line in the trace band and nothing in
//           the gap below the graticule.
//   colour  the *base* of the picture rather than an addition to it: with every
//           layer off there is nothing but `void`, which is what the measurement
//           of the reference says 65% of a frame should be. Measured from black.
//   vhs     a mixture — it multiplies the picture by its scan lines and adds
//           noise and a rolling bar to it — so the difference frame is a signed
//           mix, not a layer. What it can be asked is a texture question: it must
//           raise the pixel-scale energy without raising the mean much, because
//           grain is not a light source.
//   glitch  displaces the coordinates the picture is sampled at, so a difference
//           frame shows the *edges* of the tear rather than the layer. It is
//           measured as a change that is banded horizontally — a tear is a
//           horizontal discontinuity — and as a change that is off most of the
//           time, which is the whole claim of a glitch layer that is an artefact
//           rather than a texture.
//
// Every layer gets a null control, so a detector that always says "yes" cannot
// pass: the scope is compared against a null signal, the colour layer against
// weight 0, vhs and glitch against weight 0.
//
// Everything here reads PNGs from the built site; none of it trusts the source.
// Frames are written to .smoke/stars/ to look at
// (`npm run preview .smoke/stars/layer-scope.png`).
//
//   npm run stars [-- --seed layer-test] [--keep]
//
// Exits non-zero if a hard check fails.

import { existsSync, promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { launchChrome, type Chrome, type Harness } from './chrome.ts';
import { decodePng, encodePng } from './png.ts';
import { SCOPE_BINS } from '../src/scope.ts';
import type { DrawOptions } from '../src/types.ts';

// The package root, found by walking up to the nearest package.json with a build
// beside it: this tool is compiled to `.tools/`, so it is not always one level
// below the root.
const ROOT = (() => {
  let dir = resolve(fileURLToPath(new URL('..', import.meta.url)));
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'dist'))) return dir;
    dir = resolve(dir, '..');
  }
  return resolve(fileURLToPath(new URL('..', import.meta.url))).replace(/\/\.tools$/, '');
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
const LAYERS = ['scope', 'colour', 'vhs', 'glitch'] as const;
type Layer = (typeof LAYERS)[number];

/** The bands of the frame, as fractions from the top, with what belongs in them. */
const TRACE_BAND = [0.26, 0.52] as const;
const GAP_BAND = [0.58, 0.7] as const;
/**
 * The spectrum readout's rows, as fractions of the frame from the top. These
 * follow SPEC_BASE and SPEC_H in the shader rather than being fixed once: the
 * bars were resized when the scope's hierarchy was fixed, and a band left
 * describing the old geometry would be measuring empty frame.
 *
 * The hierarchy check sums over its bands rather than averaging them, which is
 * not a detail: a band's *mean* rises when the band is made shorter, because it
 * drops the empty rows. Measuring that way, shrinking the spectrum to a third of
 * its old height made it look 15% brighter. The question is how much light a
 * region carries, and only a sum answers it.
 */
const SPEC_BAND = [0.8, 0.97] as const;
/** Where the shader draws the trace's centre line, as a fraction from the top. */
const TRACE_ROW = (1 - 0.34) / 2;

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

function toRaster(png: ReturnType<typeof decodePng>): Raster {
  const { width, height, channels, data } = png;
  const rgb = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const at = i * channels;
    rgb[i * 3] = (data[at] ?? 0) / 255;
    rgb[i * 3 + 1] = (data[at + 1] ?? 0) / 255;
    rgb[i * 3 + 2] = (data[at + 2] ?? 0) / 255;
  }
  return { width, height, rgb };
}

/**
 * `a` minus `b`, clamped at zero. The difference of two 8-bit frames can go
 * slightly negative on a channel that was rounded up, and a negative "light"
 * would poison every mean downstream. For the layers that *multiply* (the tape)
 * this is a magnitude rather than the layer, and is only ever used as one.
 */
function subtract(a: Raster, b: Raster): Raster {
  const rgb = new Float32Array(a.rgb.length);
  for (let i = 0; i < rgb.length; i++) rgb[i] = Math.max(0, (a.rgb[i] ?? 0) - (b.rgb[i] ?? 0));
  return { width: a.width, height: a.height, rgb };
}

/** The mean absolute difference between two rasters, per channel. */
function meanDifference(a: Raster, b: Raster): number {
  let sum = 0;
  for (let i = 0; i < a.rgb.length; i++) sum += Math.abs((a.rgb[i] ?? 0) - (b.rgb[i] ?? 0));
  return a.rgb.length > 0 ? sum / a.rgb.length : 0;
}

/** The largest difference between two rasters, on any channel. */
function largestDifference(a: Raster, b: Raster): number {
  let worst = 0;
  for (let i = 0; i < a.rgb.length; i++) {
    worst = Math.max(worst, Math.abs((a.rgb[i] ?? 0) - (b.rgb[i] ?? 0)));
  }
  return worst;
}

/** Mean luminance over the whole frame. */
function meanLuma(r: Raster): number {
  let sum = 0;
  for (let i = 0; i < r.width * r.height; i++) {
    sum +=
      0.2126 * (r.rgb[i * 3] ?? 0) + 0.7152 * (r.rgb[i * 3 + 1] ?? 0) + 0.0722 * (r.rgb[i * 3 + 2] ?? 0);
  }
  return sum / (r.width * r.height);
}

/**
 * The mean *luminance* of each row, as a fraction of the frame's height. A row
 * profile and not a rectangle mean: the trace is a line a couple of pixels tall
 * inside a band fourteen per cent of the screen, and a mean over the band
 * averages the line away into the band and the band away into the frame.
 */
function rowProfile(r: Raster): number[] {
  const out = new Array<number>(r.height).fill(0);
  for (let y = 0; y < r.height; y++) {
    let sum = 0;
    for (let x = 0; x < r.width; x++) {
      const at = (y * r.width + x) * 3;
      sum +=
        0.2126 * (r.rgb[at] ?? 0) + 0.7152 * (r.rgb[at + 1] ?? 0) + 0.0722 * (r.rgb[at + 2] ?? 0);
    }
    out[y] = sum / r.width;
  }
  return out;
}

/** The mean of a row profile over one band of the frame. */
function bandMean(profile: readonly number[], band: readonly [number, number]): number {
  const start = Math.max(0, Math.floor(band[0] * profile.length));
  const end = Math.min(profile.length, Math.ceil(band[1] * profile.length));
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) sum += profile[i] ?? 0;
  return sum / (end - start);
}

/**
 * As `bandMean`, but the *total* over the band rather than the average per row.
 * Two bands of different heights can only be compared as totals: a swing that
 * fills 50 rows above the centre line and 137 below it carries the same light
 * both ways, and the two means would say otherwise.
 */
function bandSum(profile: readonly number[], band: readonly [number, number]): number {
  const start = Math.max(0, Math.floor(band[0] * profile.length));
  const end = Math.min(profile.length, Math.ceil(band[1] * profile.length));
  let sum = 0;
  for (let i = start; i < end; i++) sum += profile[i] ?? 0;
  return sum;
}

/**
 * The brightest single pixel in a horizontal band.
 *
 * This is the measure that suits a trace, and the per-row mean is the one that
 * does not. A phosphor trace is a thin wavy line: on any given row it is at its
 * core for only a fraction of the width. The spectrum bars are vertical columns,
 * so a bar row is lit across a fixed 68% duty cycle at uniform brightness. Mean
 * per row therefore hands the spectrum the win at *any* brightness the trace
 * could survive — measured here, the bars' best row read 62% against the trace's
 * 56% while the trace's brightest pixel was several times theirs. What makes the
 * trace the subject is that its core is far above everything else and the bloom
 * pass bleeds from it, and that is a statement about pixels.
 */
function bandPeakLuma(r: Raster, band: readonly [number, number]): number {
  const start = Math.max(0, Math.floor(band[0] * r.height));
  const end = Math.min(r.height, Math.ceil(band[1] * r.height));
  let best = 0;
  for (let y = start; y < end; y++) {
    for (let x = 0; x < r.width; x++) {
      const at = (y * r.width + x) * 3;
      const luma =
        0.2126 * (r.rgb[at] ?? 0) + 0.7152 * (r.rgb[at + 1] ?? 0) + 0.0722 * (r.rgb[at + 2] ?? 0);
      if (luma > best) best = luma;
    }
  }
  return best;
}

/** The index of the largest value in a profile, as a fraction of the frame. */
function peakRow(profile: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < profile.length; i++) {
    if ((profile[i] ?? 0) > (profile[best] ?? 0)) best = i;
  }
  return profile.length > 0 ? best / profile.length : 0;
}

/**
 * Energy at the pixel scale: the mean absolute difference between horizontally
 * adjacent pixels. A smooth gradient scores near zero, fine detail scores high.
 * This is what tells grain from a wash.
 */
function highFrequencyEnergy(r: Raster): number {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width - 1; x++) {
      const a = (y * r.width + x) * 3;
      const b = (y * r.width + x + 1) * 3;
      const la =
        0.2126 * (r.rgb[a] ?? 0) + 0.7152 * (r.rgb[a + 1] ?? 0) + 0.0722 * (r.rgb[a + 2] ?? 0);
      const lb =
        0.2126 * (r.rgb[b] ?? 0) + 0.7152 * (r.rgb[b + 1] ?? 0) + 0.0722 * (r.rgb[b + 2] ?? 0);
      sum += Math.abs(la - lb);
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

/**
 * How violently the difference is concentrated: the ratio of a violent row to a
 * typical one. A tear leaves most rows untouched and a few of them torn, so its
 * 95th percentile is many times its median; a general brightening leaves every
 * row the same and the ratio is 1. The *largest* row's share of the total is the
 * wrong statistic for this: the shader tears a handful of bands at once, so no
 * single row holds much and the answer comes out near the even case whatever the
 * layer does.
 */
function tearRatio(profile: readonly number[]): number {
  const sorted = [...profile].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const median = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  // A median of exactly zero (most rows untouched) is the strongest possible
  // version of the claim, so it is reported as the ceiling rather than as a
  // division by zero.
  return median > 1e-6 ? p95 / median : p95 > 0 ? Number.POSITIVE_INFINITY : 0;
}

/** How alike two rasters are, 0 (nothing in common) to 1 (identical). */
function similarity(a: Raster, b: Raster): number {
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    const la =
      0.2126 * (a.rgb[i * 3] ?? 0) +
      0.7152 * (a.rgb[i * 3 + 1] ?? 0) +
      0.0722 * (a.rgb[i * 3 + 2] ?? 0);
    const lb =
      0.2126 * (b.rgb[i * 3] ?? 0) +
      0.7152 * (b.rgb[i * 3 + 1] ?? 0) +
      0.0722 * (b.rgb[i * 3 + 2] ?? 0);
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
      rgba[i * 4 + c] = Math.round(Math.min(1, (raster.rgb[i * 3 + c] ?? 0) * gain) * 255);
    }
    rgba[i * 4 + 3] = 255;
  }
  await fs.writeFile(join(ARTIFACTS, `${name}.png`), encodePng(width, height, rgba));
}

/** Weights for a frame with one layer at `weight` and the rest off. */
function only(layer: Layer, weight = 1): [number, number, number, number] {
  const weights: [number, number, number, number] = [0, 0, 0, 0];
  weights[LAYERS.indexOf(layer)] = weight;
  return weights;
}

const off: [number, number, number, number] = [0, 0, 0, 0];

// --- the run -----------------------------------------------------------------

async function main(): Promise<void> {
  await fs.mkdir(ARTIFACTS, { recursive: true });
  let harness: Harness;
  try {
    harness = await launchChrome({ site: SITE, artifacts: ARTIFACTS, keepProfile: keep });
  } catch (error) {
    console.error(`could not start a browser: ${(error as Error).message}`);
    process.exit(2);
  }
  const client: Chrome = harness.chrome;

  try {
    await harness.go(`/#s=${encodeURIComponent(seed)}`);
    if (!(await harness.loaded())) throw new Error('the app never came up');

    // Enter, because nothing draws until the gesture has started the audio, and
    // the scope has nothing to measure until there is a master to measure.
    const { x, y } = await client.centreOf('enter-button');
    await client.click(x, y);
    const started = await harness.waitFor('__jeffer.stats().started === true', 30_000);
    check('the app is running', started);
    if (!started) throw new Error('the set never started');

    // Quality pins the drawing scale. In 'auto' the renderer moves its own
    // buffer to hold the frame rate, and two captures of the same moment can come
    // back at different sizes — which would make every subtraction below
    // nonsense. 'high' rather than 'low' because this is the one tool whose
    // subject is the finished picture: bloom on, five noise octaves, full scale.
    await client.evaluate(`(() => {
      const el = document.getElementById('quality');
      el.value = 'high';
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    // The HUD, the toast and the enter overlay fade on their own timers, and a
    // half-faded overlay differs between two frames — a difference between two
    // frames is exactly what every measurement below is made of.
    const clear = await harness.waitFor(
      `['hud', 'toast', 'enter', 'notice'].every((id) => {
         const el = document.getElementById(id);
         return !el || getComputedStyle(el).opacity === '0' || el.hidden;
       })`,
      20_000,
    );
    check('the viewport is the picture alone', clear);

    /**
     * Draw one frame with the moment, the signal and the flash pinned, and
     * capture it. `scope` is pinned from one reading, so the trace is the same
     * waveform in every frame below — otherwise the difference between two
     * captures is as likely to be the music as the layer under test.
     *
     * The signal is *synthesised* rather than taken off the analyser, and that is
     * the whole reason this tool can make claims about the scope layer at all. A
     * live reading depends on what the set happens to be playing, on the audio
     * thread keeping up, and on the headless clock running at half wall time: the
     * first attempt at this check waited four minutes for a drop and gave up with
     * an intro waveform so quiet that the trace and a flat line were the same
     * picture. A known input is a better experiment: two and a half cycles of a
     * 62 Hz sine with a third harmonic, which is the reference's own fundamental
     * and dominant partial, at an amplitude the auto-ranging deflection will fill
     * the graticule with.
     *
     * It is also the honest null: the same frame with `scope: null` must draw a
     * straight line, and the difference between the two frames is then a fact
     * about the shader rather than about the music.
     */
    // The arrays cross as JSON text and are parsed here, because what goes into
    // `draw` has to be an object: a stringified scope reads back as a string,
    // whose `.wave` is undefined, and the renderer then uploads a zero-filled
    // texture — a flat trace, which is exactly the picture this check exists to
    // rule out.
    const signalJson = await client.evaluate<string>(`JSON.stringify((() => {
      const BINS = ${SCOPE_BINS};
      const wave = new Array(BINS);
      let sum = 0;
      for (let i = 0; i < BINS; i++) {
        // Two and a half cycles across the window, plus a third harmonic: enough
        // shape for a waveform, flat enough to be readable as one.
        const t = (i / BINS) * Math.PI * 2 * 2.5;
        wave[i] = 0.62 * Math.sin(t) + 0.18 * Math.sin(t * 3 + 0.4);
        sum += wave[i] * wave[i];
      }
      const rms = Math.sqrt(sum / BINS);
      // A spectrum with the energy where this music has it, so the bars are not
      // a flat row of 24 identical heights.
      const spectrum = new Array(BINS);
      for (let i = 0; i < BINS; i++) {
        const f = i / BINS;
        spectrum[i] = Math.max(0, 1 - f * 2.2) * (0.75 + 0.25 * Math.sin(i * 0.7));
      }
      return { wave, spectrum, peak: 0.8, rms };
    })())`);
    const signal = JSON.parse(signalJson) as DrawOptions['scope'];
    // What the renderer made of each frame's signal, by capture label: the bins
    // it accepted, or 0 for a frame drawn with no signal at all. This is the
    // difference between "the trace looks like a waveform" and "the trace is
    // this frame's waveform", and only the renderer knows which.
    const binsSeen = new Map<string, number>();
    const capture = async (label: string, options: Record<string, unknown>): Promise<Raster> => {
      await client.evaluate(
        `__jeffer.draw(${JSON.stringify({ time: T, scope: signal, drift: false, dim: 1, pulse: 0, ...options })})`,
      );
      binsSeen.set(
        label,
        await client.evaluate<number>('__jeffer.stats().render.scopeBins'),
      );
      const raster = toRaster(decodePng(await client.screenshot()));
      await save(raster, label, 1);
      return raster;
    };

    // A moment in a *drop*, found by asking the conductor rather than by waiting
    // for it: an intro is deliberately almost black, and measuring the layers
    // there measures a set that has left the colour field three-quarters closed.
    const T = await client.evaluate<number>(`(() => {
      for (let t = 0; t < 3600; t += 2) {
        if (__jeffer.pieceAt(t).section !== 'drop') continue;
        let end = t;
        while (__jeffer.pieceAt(end + 2).section === 'drop') end += 2;
        return (t + end) / 2;
      }
      return 60;
    })()`);

    const before = JSON.parse(
      await client.evaluate<string>('JSON.stringify(__jeffer.stats().render)'),
    ) as { available: boolean; quality: string; scale: number; octaves: number };
    check(
      'the renderer is up and the drawing resolution is fixed for the run',
      before.available === true && before.quality === 'high',
      `quality ${before.quality}, scale ${before.scale}, ${before.octaves} octaves, at ${T.toFixed(0)}s`,
    );

    // --- determinism: the gate on every subtraction below --------------------
    // Warm-up captures, discarded. The first captures after entering differ from
    // each other far more than later ones of the same setting: the picture is
    // still settling, and measuring a picture that is settling measures the
    // settling.
    for (let i = 0; i < 3; i++) await capture(`warmup-${i}`, { layers: off });

    const none = await capture('none', { layers: off });
    const again = await capture('none-again', { layers: off });
    const third = await capture('none-third', { layers: off });
    const meanDiffs = [
      meanDifference(none, again),
      meanDifference(none, third),
      meanDifference(again, third),
    ];
    const maxDiffs = [
      largestDifference(none, again),
      largestDifference(none, third),
      largestDifference(again, third),
    ];
    check(
      'the same frame drawn twice is the same image',
      Math.max(...meanDiffs) < 0.01 && Math.max(...maxDiffs) < 0.05,
      `three captures of one frame: mean ${meanDiffs.map((d) => d.toFixed(5)).join(', ')}, ` +
        `largest ${maxDiffs.map((d) => d.toFixed(4)).join(', ')}`,
    );
    report(`frame ${none.width}×${none.height}`);

    // A frame with every layer off should be the void: the measurement of the
    // reference says 65% of a frame of this material is pure black, so the
    // thing under all the layers is black and not a dark colour.
    report(`no layers: mean luma ${meanLuma(none).toFixed(4)}`);

    // --- each layer, alone, and what it takes away with it -------------------
    const alone: Raster[] = [];
    for (const layer of LAYERS) {
      const raster = await capture(`alone-${layer}`, { layers: only(layer) });
      alone.push(raster);
      // Saved twice: once as it stands, and once boosted, because a layer alone
      // on black is dim by construction and the shape is the interesting part.
      await save(raster, `layer-${layer}`, 4);
    }

    for (let i = 0; i < LAYERS.length; i++) {
      const layer = LAYERS[i] as Layer;
      const frame = alone[i] as Raster;
      const mean = meanLuma(frame);
      report(
        `layer ${layer}: alone mean luma ${mean.toFixed(4)} ` +
          `(pixel-scale energy ${highFrequencyEnergy(frame).toFixed(5)})`,
      );
      // The glitch is excluded here, and not by special-casing its check: it
      // displaces the coordinates the picture is sampled at, so displacing a
      // black frame returns a black frame. It is measured over the colour field
      // further down, where there is something to move.
      if (layer === 'glitch') {
        report('  (measured over the colour field below — it moves pixels, and there is nothing to move on black)');
        continue;
      }
      check(
        `the ${layer} layer draws something`,
        mean > 0.004,
        `mean ${mean.toFixed(4)} over the frame, alone at full weight`,
      );
    }

    // --- scope: the one layer subtraction can measure exactly -----------------
    // It is additive, so this difference is the trace and not a side effect.
    const scopeOnly = alone[0] as Raster;
    const scopeDiff = subtract(scopeOnly, none);
    const scopeProfile = rowProfile(scopeDiff);
    const scopeTrace = bandMean(scopeProfile, TRACE_BAND);
    const scopeGap = bandMean(scopeProfile, GAP_BAND);
    const scopeSpec = bandMean(scopeProfile, SPEC_BAND);
    await save(scopeDiff, 'layer-scope-diff', 4);
    report(
      `scope diff: trace band ${(scopeTrace * 100).toFixed(2)}%, ` +
        `gap ${(scopeGap * 100).toFixed(2)}%, spectrum ${(scopeSpec * 100).toFixed(2)}%, ` +
        `brightest row ${(peakRow(scopeProfile) * 100).toFixed(0)}%`,
    );
    check(
      'the scope layer is the trace, in the trace band',
      scopeTrace > scopeGap * 3 && scopeTrace > 0.002,
      `${(scopeTrace * 100).toFixed(2)}% in the trace band against ${(scopeGap * 100).toFixed(2)}% in the gap below it`,
    );

    // The null control. A scope fed no signal draws a straight line and a scope
    // fed a signal draws the signal: if the two frames are the same, the trace is
    // a drawing and the analyser is decorative.
    //
    // Measured as the *difference between the two frames* rather than each frame
    // against black, and that is not a detail. The graticule is part of the scope
    // layer, so a profile taken against black is floored by the box and its grid
    // dots: both frames then light twenty-odd rows of the trace band, the sine and
    // the flat line alike, and the measurement says they are identical. The
    // graticule cancels in the difference between them, which leaves the trace.
    const noSignal = await capture('scope-null', { layers: only('scope'), scope: null });
    const withSignal = scopeOnly;
    const shapeProfile = rowProfile(subtract(withSignal, noSignal));
    const shapeRows = (() => {
      const start = Math.floor(TRACE_BAND[0] * shapeProfile.length);
      const end = Math.ceil(TRACE_BAND[1] * shapeProfile.length);
      const peak = Math.max(0, ...shapeProfile.slice(start, end));
      if (peak <= 0) return 0;
      let count = 0;
      for (let i = start; i < end; i++) {
        if ((shapeProfile[i] ?? 0) >= peak * 0.2) count++;
      }
      return count;
    })();
    const sineBins = binsSeen.get('alone-scope') ?? 0;
    report(
      `scope alone: the renderer took ${sineBins} of ${SCOPE_BINS} bins from the sine and ` +
        `${binsSeen.get('scope-null') ?? 0} from the null`,
    );
    check(
      'the trace comes from the signal, not from the shader',
      shapeRows >= 8 && largestDifference(withSignal, noSignal) > 0.005 && sineBins === SCOPE_BINS,
      `a straight line and a two-and-a-half-cycle sine differ across ${shapeRows} rows of the ` +
        `trace band, by up to ${largestDifference(withSignal, noSignal).toFixed(3)}, with ` +
        `${sineBins}/${SCOPE_BINS} bins accepted`,
    );
    report(
      `scope alone: mean luma ${meanLuma(withSignal).toFixed(4)} with the sine, ` +
        `${meanLuma(noSignal).toFixed(4)} with no signal at all`,
    );

    // Signed, not folded. This is the claim the fix to the 8-bit decode turned
    // into, and it cannot be asked as "where is the peak row": a sine fills its
    // band, so the brightest row is the top of the swing and says nothing about
    // centring. What says it is that the trace has light *both sides* of the
    // centre line the shader draws it on. A trace folded into the positive half
    // — which is exactly what the arguments to `mix` being the wrong way round
    // did to the float path — is bright above the line and dark below, and
    // against a null signal it puts every row it has on one side of the centre.
    const centre = TRACE_ROW * shapeProfile.length;
    const above = bandSum(shapeProfile, [TRACE_BAND[0], TRACE_ROW] as const);
    const below = bandSum(shapeProfile, [TRACE_ROW, TRACE_BAND[1]] as const);
    const skew = (Math.max(above, below) - Math.min(above, below)) / Math.max(above, below);
    report(
      `scope diff: light above the centre line ${above.toFixed(1)} against ${below.toFixed(1)} ` +
        `below it, summed over the trace band ` +
        `(the line is at ${(TRACE_ROW * 100).toFixed(0)}% from the top)`,
    );
    check(
      'the trace crosses its centre line, so the waveform is signed',
      above > 0.05 && below > 0.05 && skew < 0.5,
      `${((above / below - 1) * 100).toFixed(0)}% more light above the centre line than below, ` +
        `the line being at ${(centre / shapeProfile.length * 100).toFixed(0)}% — a folded trace ` +
        `would put all of it on one side`,
    );

    // The scope's own hierarchy, which is two claims and only one of them used to
    // be checked. The first is about the brightest single mark in the frame; the
    // second is about how much of the *picture* each band carries, and the second
    // is the one that matters, because a trace two pixels tall loses any contest
    // measured on peak brightness to a solid fill across a fifth of the frame.
    // Both were true of this app at one point: the spectrum band measured 8.6% of
    // the frame against the trace's 3.7%, and the picture read as an analyser
    // with a decoration on top of it. SPEC_WEIGHT in the shader is the fix, and
    // this is the check that keeps it fixed.
    const traceMass = bandSum(scopeProfile, TRACE_BAND);
    const spectrumMass = bandSum(scopeProfile, SPEC_BAND);
    report(
      `scope layer: total light ${(traceMass * 100).toFixed(1)} in the trace band against ` +
        `${(spectrumMass * 100).toFixed(1)} in the spectrum band ` +
        `(mean luma per row ${(scopeTrace * 100).toFixed(2)}% and ${(scopeSpec * 100).toFixed(2)}%)`,
    );
    check(
      'the trace outranks the spectrum, as on a real scope',
      traceMass > spectrumMass,
      `the trace band carries ${(traceMass * 100).toFixed(1)} of light against the spectrum ` +
        `band's ${(spectrumMass * 100).toFixed(1)}`,
    );
    const tracePeak = Math.max(...scopeProfile);
    report(
      `scope alone: its brightest row is ${(tracePeak * 100).toFixed(1)}% at ` +
        `${(peakRow(scopeProfile) * 100).toFixed(0)}%`,
    );

    // --- colour: a weight, and one the shader has to read ---------------------
    // This is the check that would have caught uMix.y going unread: a weight the
    // shader ignores is a number in the HUD and nothing in the picture.
    const dimColour = await capture('colour-035', { layers: only('colour', 0.35) });
    const fullColour = alone[1] as Raster;
    check(
      "the colour layer's weight changes the picture",
      meanLuma(fullColour) > meanLuma(dimColour) * 1.2,
      `weight 1.0 at ${meanLuma(fullColour).toFixed(4)} against weight 0.35 at ${meanLuma(dimColour).toFixed(4)}`,
    );

    // --- vhs: grain, not a light source ---------------------------------------
    const tape = alone[2] as Raster;
    const tapeEnergy = highFrequencyEnergy(tape);
    const colourEnergy = highFrequencyEnergy(fullColour);
    check(
      'the tape adds texture rather than brightness',
      tapeEnergy > colourEnergy * 1.2 && meanLuma(tape) < meanLuma(fullColour) * 1.5,
      `pixel-scale energy ${tapeEnergy.toFixed(5)} against the colour field's ${colourEnergy.toFixed(5)}, ` +
        `at mean luma ${meanLuma(tape).toFixed(4)}`,
    );

    // --- glitch: an artefact, so a change that is banded and mostly absent ----
    // Measured *over the scope layer*, and that is not a convenience twice over.
    // The glitch layer displaces the coordinates the picture is sampled at, so
    // displacing a black frame returns a black frame and displacing a smooth wash
    // returns nearly the same wash — both measure nothing. What it can be seen
    // moving is a picture with detail in it, and the scope's trace and graticule
    // are the only such thing on this screen.
    const withGlitch = await capture('scope-plus-glitch', { layers: [1, 0, 0, 1] });
    const glitchProfile = rowProfile(subtract(withGlitch, scopeOnly));
    const glitchMass = glitchProfile.reduce((sum, v) => sum + v, 0);
    check(
      'the glitch layer moves the picture',
      glitchMass > 0 && largestDifference(withGlitch, scopeOnly) > 0.01,
      `largest difference ${largestDifference(withGlitch, scopeOnly).toFixed(3)} between the ` +
        'scope layer with the glitch on and with it off',
    );
    check(
      'the glitch is a horizontal tear, not a general brightening',
      tearRatio(glitchProfile) > 4,
      `a violent row of the difference is ${tearRatio(glitchProfile) === Number.POSITIVE_INFINITY ? 'infinitely' : `${tearRatio(glitchProfile).toFixed(1)}×`} ` +
        'a typical one (an even change would be 1×)',
    );
    report(
      `glitch over a smooth field: mean luma ${meanLuma(subtract(await capture('colour-plus-glitch', { layers: [0, 1, 0, 1] }), fullColour)).toFixed(5)} ` +
        'of difference — displacing a gradient is nearly a no-op, which is why it is measured over the trace',
    );

    // --- the four are four different pictures, not one drawn four times -------
    let mostAlike = 0;
    let mostAlikePair = '';
    for (let i = 0; i < LAYERS.length; i++) {
      for (let j = i + 1; j < LAYERS.length; j++) {
        const s = similarity(alone[i] as Raster, alone[j] as Raster);
        if (s > mostAlike) {
          mostAlike = s;
          mostAlikePair = `${LAYERS[i]}/${LAYERS[j]}`;
        }
      }
    }
    check(
      'the four layers are four different pictures',
      mostAlike < 0.9,
      `the most alike pair is ${mostAlikePair} at ${mostAlike.toFixed(2)}`,
    );

    // --- the whole picture, for the record -----------------------------------
    const full: [number, number, number, number] = [1, 1, 1, 1];
    const all = await capture('all', { layers: full });
    report(
      `all four: mean luma ${meanLuma(all).toFixed(4)}, ` +
        `pixel-scale energy ${highFrequencyEnergy(all).toFixed(5)}`,
    );
    check('nothing threw on the way', true);

    // The hierarchy claim on the *composited* picture, which is the only place
    // it means anything: what a viewer sees is four layers over each other, and
    // "the trace is the subject" is a statement about that, not about the scope
    // layer in isolation. It also cannot be asked as "is the trace brighter than
    // some other layer" — the tape's scanlines are bright lines too, and that
    // comparison is a coin flip between two line-like things, which is how this
    // check sat 0.5% from failing while the picture was plainly wrong.
    //
    // So: on the whole frame, is the brightest row the trace's? That is the claim,
    // and it is either true of the picture or it is not.
    const allProfile = rowProfile(all);
    const tracePixels = bandPeakLuma(all, TRACE_BAND);
    // The bars' own peak, taken from the null-signal frame: the scope layer with
    // the graticule and the bars and *no trace at all*. Reading it off the
    // finished frame instead measures the wrong thing — the spectrum band's peak
    // there is bloom bleeding down off the trace's core, which is why it sat at
    // 66.6% whether the bars were drawn at 0.34 or at 0.25. A bar that does not
    // get dimmer when you dim it is not a bar.
    const barPixels = bandPeakLuma(noSignal, SPEC_BAND);
    report(
      `all four: the trace's brightest pixel is ${(tracePixels * 100).toFixed(1)}%, the bars' ` +
        `own is ${(barPixels * 100).toFixed(1)}%, and the spectrum band as a whole reads ` +
        `${(bandPeakLuma(all, SPEC_BAND) * 100).toFixed(1)}% — that last one is bloom off the ` +
        `trace, not a bar; the brightest *row* is at ${(peakRow(allProfile) * 100).toFixed(0)}%`,
    );
    check(
      'the trace is the brightest mark in the finished picture, as on a real scope',
      tracePixels > barPixels * 1.5,
      `the trace's brightest pixel is ${(tracePixels * 100).toFixed(1)}% against the bars' own ` +
        `${(barPixels * 100).toFixed(1)}%, a factor of ` +
        `${(tracePixels / Math.max(barPixels, 1e-6)).toFixed(1)}`,
    );
  } catch (error) {
    console.error(`\n  stars error: ${(error as Error).message}`);
    for (const entry of client.logs.slice(0, 12)) console.error(`    [${entry.level}] ${entry.text}`);
    for (const failure of client.errors.slice(0, 6)) console.error(`    [error] ${String(failure).slice(0, 300)}`);
    process.exit(2);
  } finally {
    await harness.close();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n  captures: ${ARTIFACTS}`);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main();
