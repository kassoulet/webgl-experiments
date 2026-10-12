#!/usr/bin/env node
// Verify the starfield against spec §3, with captured frames rather than a
// reading of the shader:
//
//   * stars come from hashed cells at several depths — so the three layers are
//     isolated exactly (a frame drawn with N layers minus one drawn with N-1 is
//     that layer, because everything else is identical), and each is measured
//     moving at its own parallax when the camera does;
//   * size, colour temperature and twinkle come from the hash — measured as the
//     spread of star colours and the way stars change over time;
//   * a few bright stars carry diffraction spikes — measured as the fraction of
//     stars whose flux lies along an axis rather than in a disc;
//   * a faint Milky Way band — measured as the luminance profile against the
//     angle from the band's great circle, and compared with the Gaussian the
//     shader draws;
//   * a far-away event lights a distant star — the conductor is asked where, and
//     the picture is checked to have a bright star *there*.
//
// Everything here reads PNGs from the built site; none of it trusts the source.
// The frames it measures are written to .smoke/stars/ for a human to look at
// (`npm run preview .smoke/stars/layer1.png`).
//
//   npm run stars [-- --seed stars] [--keep]
//
// Exits non-zero if a hard check fails.

import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { launchChrome, type Chrome, type Harness } from './chrome.js';
import { decodePng, encodePng, type PNGImage } from './png.js';
import { starTint } from '../src/palette.js';
import type { Camera } from '../src/types.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url))).replace(/\/tools-dist$/, '');
const SITE = join(ROOT, 'dist');
const ARTIFACTS = join(ROOT, '.smoke', 'stars');

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const seed = readArg('--seed') ?? 'star-field';

function readArg(name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

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
    rgb[i * 3] = data[at] / 255;
    rgb[i * 3 + 1] = data[at + 1] / 255;
    rgb[i * 3 + 2] = data[at + 2] / 255;
  }
  return { width, height, rgb };
}

/** `a` minus `b`. The star layers are additive and everything else in the frame
 *  is identical, so this is the layer itself and nothing else. */
function subtract(a: Raster, b: Raster): Raster {
  const rgb = new Float32Array(a.rgb.length);
  for (let i = 0; i < rgb.length; i++) rgb[i] = Math.max(0, a.rgb[i] - b.rgb[i]);
  return { width: a.width, height: a.height, rgb };
}

const lumaAt = (r: Raster, x: number, y: number): number => {
  const at = (y * r.width + x) * 3;
  return 0.2126 * r.rgb[at] + 0.7152 * r.rgb[at + 1] + 0.0722 * r.rgb[at + 2];
};

/** What a raster adds up to, for comparing one frame with another. */
function total(r: Raster): number {
  let sum = 0;
  for (let i = 0; i < r.width * r.height; i++) {
    sum += 0.2126 * r.rgb[i * 3]! + 0.7152 * r.rgb[i * 3 + 1]! + 0.0722 * r.rgb[i * 3 + 2]!;
  }
  return sum;
}

/** The largest difference between two rasters, for asking whether the picture
 *  is actually reproducible frame to frame. */
function largestDifference(a: Raster, b: Raster): number {
  let worst = 0;
  for (let i = 0; i < a.rgb.length; i++) worst = Math.max(worst, Math.abs(a.rgb[i]! - b.rgb[i]!));
  return worst;
}

async function save(raster: Raster, name: string, gain = 1): Promise<void> {
  const { width, height } = raster;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++) {
      rgba[i * 4 + c] = Math.round(Math.min(1, raster.rgb[i * 3 + c] * gain) * 255);
    }
    rgba[i * 4 + 3] = 255;
  }
  await fs.writeFile(join(ARTIFACTS, `${name}.png`), encodePng(width, height, rgba));
}

// --- stars in a raster -------------------------------------------------------

interface Star {
  /** The brightest pixel. */
  x: number;
  y: number;
  /** Its centre of light, to a fraction of a pixel: a star's shape is fixed, so
   *  the centroid moving between two frames *is* the star moving. */
  cx: number;
  cy: number;
  peak: number;
  /** Peak-channel colour spread, (r-b)/(r+b) at the star's brightest pixel. */
  warmth: number;
  /** How far the light reaches along the x axis, and along the y axis. */
  reachX: number;
  reachY: number;
  /** How far the light reaches along *both* screen axes at once, or 0 when it
   *  reaches as far at 45°, where no spike runs. */
  spikeReach: number;
  /** How far the light reaches at 45° — the disc's own radius, for any star. */
  diagonalReach: number;
}

/**
 * Local maxima above `threshold` in the middle of the frame. The corners are
 * skipped because the vignette lives there and because the projection skews a
 * star's spikes away from the screen axes near the edges.
 */
function findStars(raster: Raster, threshold: number, limit = 400): Star[] {
  const { width, height } = raster;
  const x0 = Math.floor(width * 0.16);
  const x1 = Math.ceil(width * 0.84);
  const y0 = Math.floor(height * 0.16);
  const y1 = Math.ceil(height * 0.84);
  const stars: Star[] = [];
  for (let y = y0 + 1; y < y1 - 1; y++) {
    for (let x = x0 + 1; x < x1 - 1; x++) {
      const peak = lumaAt(raster, x, y);
      if (peak < threshold) continue;
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (lumaAt(raster, x + dx, y + dy) >= peak) {
            isMax = false;
            break;
          }
        }
      }
      if (!isMax) continue;
      // How far the star's light reaches along the screen axes, against how far
      // it reaches at 45° — the direction no spike ever runs. A disc ends at its
      // own radius whichever way you look, so a plain star gives 1; a spike
      // carries light well past that along the axes. Comparing two directions
      // rather than an absolute distance keeps the answer the same however big
      // the star is, and however the frame was scaled on its way to the screen.
      const above = 0.012;
      const sample = (dx: number, dy: number): number => {
        const px = x + dx;
        const py = y + dy;
        if (px < 0 || py < 0 || px >= width || py >= height) return 0;
        return lumaAt(raster, px, py);
      };
      // How far the light goes along each direction, three pixels wide so a thin
      // arm cannot slip between the samples. A star with diffraction spikes
      // carries light along *both* axes at once — which is what tells it apart
      // from a plain disc, and from the light of some other star that happens to
      // land nearby, since that would reach in one direction only.
      const reachOf = (offsets: number[][]): number => {
        let reach = 0;
        for (let d = 1; d <= 9; d++) {
          let brightest = 0;
          for (const [ox, oy] of offsets) brightest = Math.max(brightest, sample(ox * d, oy * d));
          if (brightest < above) break;
          reach = d;
        }
        return reach;
      };
      const reachX = reachOf([[1, -1], [1, 0], [1, 1], [-1, -1], [-1, 0], [-1, 1]]);
      const reachY = reachOf([[-1, 1], [0, 1], [1, 1], [-1, -1], [0, -1], [1, -1]]);
      const diagonalReach = reachOf([[1, 1], [1, -1], [-1, 1], [-1, -1]]);
      // A spike is light along both axes at a radius no disc reaches — the
      // largest a disc can be is about 4½ px in this build — but not at 45°.
      const spikeReach = diagonalReach <= 3 ? Math.min(reachX, reachY) : 0;
      // Centre of light over the core. The bias of a small window is the same in
      // both frames, so what it costs in accuracy it does not cost in
      // difference — which is all this is ever used for.
      let weight = 0;
      let sx = 0;
      let sy = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const px = x + dx;
          const py = y + dy;
          if (px < 0 || py < 0 || px >= width || py >= height) continue;
          const w = Math.max(0, lumaAt(raster, px, py) - 0.002);
          weight += w;
          sx += w * px;
          sy += w * py;
        }
      }
      const offset = (y * width + x) * 3;
      const r = raster.rgb[offset]!;
      const b = raster.rgb[offset + 2]!;
      stars.push({
        x,
        y,
        cx: weight > 0 ? sx / weight : x,
        cy: weight > 0 ? sy / weight : y,
        peak,
        warmth: (r - b) / Math.max(0.02, r + b),
        reachX,
        reachY,
        spikeReach,
        diagonalReach,
      });
    }
  }
  stars.sort((a, b) => b.peak - a.peak);
  return stars.slice(0, limit);
}

/**
 * How far the starfield moved between two frames, in pixels.
 *
 * The camera is moved perpendicular to its own view direction, so the
 * displacement is purely along the image's x axis: a star that keeps its height
 * is the same star, which is what pairs the two lists. Every candidate pair is
 * collected and the answer is the mode of their displacements — a mismatched
 * pair lands somewhere random, so the true shift is the cluster and the strays
 * are noise. The mode is then refined to the median of the pairs around it.
 */
function fieldShift(a: Star[], b: Star[], tolerance = 1.5, bin = 3): { px: number; pairs: number; spread: number } {
  const candidates: number[] = [];
  for (const star of a) {
    for (const other of b) {
      if (Math.abs(other.cy - star.cy) <= tolerance) candidates.push(other.cx - star.cx);
    }
  }
  if (!candidates.length) return { px: 0, pairs: 0, spread: 0 };
  const votes = new Map<number, number>();
  for (const dx of candidates) {
    const key = Math.round(dx / bin) * bin;
    votes.set(key, (votes.get(key) ?? 0) + 1);
  }
  let centre = 0;
  let support = -1;
  for (const [key, count] of votes) {
    if (count > support) {
      support = count;
      centre = key;
    }
  }
  const near = candidates.filter((dx) => Math.abs(dx - centre) <= bin).sort((x, y) => x - y);
  const quantile = (q: number): number => near[Math.floor(q * (near.length - 1))] ?? centre;
  return { px: quantile(0.5), pairs: near.length, spread: quantile(0.75) - quantile(0.25) };
}

// --- the camera, as the shader builds it -------------------------------------

type Vec3 = [number, number, number];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const unit = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(a[0], a[1], a[2]));

/** The basis `main()` in src/visuals/shaders.ts builds — keep the two in step. */
function basis(camera: Camera): { forward: Vec3; right: Vec3; up: Vec3 } {
  const cp = Math.cos(camera.pitch);
  const sp = Math.sin(camera.pitch);
  const cy = Math.cos(camera.yaw);
  const sy = Math.sin(camera.yaw);
  const forward: Vec3 = [cp * sy, sp, cp * cy];
  const right = unit(cross(forward, [0, 1, 0]));
  return { forward, right, up: cross(right, forward) };
}

/** Where a sky direction lands on the frame, in pixels from the top left. */
function project(camera: Camera, dir: Vec3, width: number, height: number): { x: number; y: number } {
  const { forward, right, up } = basis(camera);
  const denom = dot(dir, forward);
  const uvx = dot(dir, right) / denom;
  const uvy = dot(dir, up) / denom;
  return { x: uvx * height + width / 2, y: height - (uvy * height + height / 2) };
}

/** The direction a pixel looks in — the inverse of `project`. */
function directionAt(camera: Camera, x: number, y: number, width: number, height: number): Vec3 {
  const { forward, right, up } = basis(camera);
  const uvx = (x - width / 2) / height;
  const uvy = (height - y - height / 2) / height;
  return unit([
    forward[0] + uvx * right[0] + uvy * up[0],
    forward[1] + uvx * right[1] + uvy * up[1],
    forward[2] + uvx * right[2] + uvy * up[2],
  ]);
}

/** The camera the shader would give at this yaw and pitch, looking from here. */
const cam = (position: Vec3, yaw: number, pitch: number): Camera => ({ position, yaw, pitch });

/**
 * A camera looking along the band, with the band's normal as its `up`.
 *
 * The shader builds the frame from a yaw and a pitch, so this solves for the
 * pair that makes the camera's up vector the normal: then the band runs
 * *horizontally* across the middle and, because the horizontal direction is
 * perpendicular to the normal, the angle away from the band is exactly the
 * vertical angle of the pixel. That turns a width measurement into a profile of
 * the frame's own rows.
 */
function alongBand(position: Vec3, normal: Vec3): Camera {
  const cosPitch = normal[1];
  const sinPitch = -Math.sqrt(Math.max(0, 1 - cosPitch * cosPitch));
  return cam(position, Math.atan2(-normal[0] / sinPitch, -normal[2] / sinPitch), Math.asin(sinPitch));
}

/** The Milky Way's plane normal, as the shader has it. */
const BAND_NORMAL: Vec3 = unit([0.32, 0.86, 0.28]);

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
  const chrome: Chrome = harness.chrome;

  try {
    await harness.go(seed);
    const ready = await harness.loaded();
    if (!ready) throw new Error('the app never came up');

    // Enter, because nothing draws until the renderer is initialised.
    const box = JSON.parse(
      (await chrome.send<{ result: { value: string } }>('Runtime.evaluate', {
        expression: 'JSON.stringify(document.getElementById("enter-button").getBoundingClientRect())',
        returnByValue: true,
      }, 60000)).result.value,
    ) as { x: number; y: number; width: number; height: number };
    await chrome.click(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
    const started = await harness.waitFor('__singularity.stats().started === true', 30000);
    check('the app is running', started);

    // Quality pins the resolution scale: in 'auto' the renderer keeps moving its
    // buffer and two captures of the same moment would come back at different
    // sizes, which would make the layer subtraction nonsense. 'low' is chosen
    // over 'high' because it also takes the raymarch out of the frame loop —
    // under software rendering a full-resolution volumetric frame can outlast
    // any screenshot timeout, and none of this needs a nebula.
    await chrome.send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.getElementById('quality');
        el.value = 'low';
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
      awaitPromise: true,
    }, 120000);
    // The pointer moved on the way in, so the HUD is up; wait for its own hide
    // timer rather than cropping it out of every frame.
    // The HUD hides itself a few seconds after the pointer stops, the toast that
    // says what changed fades on its own timer, and the enter overlay fades out
    // once it is dismissed. All three have to be *gone*, not merely told to go:
    // a half-faded element differs between two frames, and a difference between
    // two frames is exactly what every measurement below is made of.
    const viewportClear = await harness.waitFor(
      `['hud', 'toast', 'enter'].every((id) => {
         const el = document.getElementById(id);
         return !el || getComputedStyle(el).opacity === '0';
       })`,
      15000,
    );
    check('the viewport is the sky alone', viewportClear);

    const readStats = async (): Promise<{ frames: number; scale: number; quality: string }> =>
      JSON.parse(
        (await chrome.send<{ result: { value: string } }>('Runtime.evaluate', {
          expression: 'JSON.stringify({ frames: __singularity.stats().frames, scale: __singularity.stats().render.scale, quality: __singularity.stats().render.quality })',
          returnByValue: true,
        }, 60000)).result.value,
      ) as { frames: number; scale: number; quality: string };

    const before = await readStats();
    check(
      'the drawing resolution is fixed for the run',
      before.quality === 'low' && before.scale === 0.6,
      `quality ${before.quality}, scale ${before.scale}`,
    );

    /**
     * Draw one frame with the picture pinned, and capture it. `density: 0` takes
     * the nebula out of the way — what is left is the starfield, the band, the
     * vignette and a fixed dither, all of which are pure functions of (t,
     * camera), so two frames drawn the same way are the same image.
     */
    const capture = async (
      label: string,
      options: { time: number; camera: Camera; stars: number; flare?: number },
    ): Promise<Raster> => {
      await chrome.send('Runtime.evaluate', {
        expression: `__singularity.draw(${JSON.stringify({
          time: options.time,
          camera: options.camera,
          stars: options.stars,
          flare: options.flare,
          density: 0,
          volumetric: false,
          brightness: 0.5,
          dim: 1,
        })})`,
        awaitPromise: true,
      }, 120000);
      await delay(500);
      const png = decodePng(await chrome.screenshot());
      const raster = toRaster(png);
      await save(raster, label, 6);
      return raster;
    };

    const T = 90;
    const look: [number, number] = [0, 0];
    const camA = cam([0, 0, 0.4], look[0], look[1]);
    const camB = cam([0.3, 0, 0.4], look[0], look[1]);

    // --- the layers, isolated by subtraction ---------------------------------
    const noStars = await capture('none', { time: T, camera: camA, stars: 0 });
    const width = noStars.width;
    const height = noStars.height;
    report(`frame ${width}×${height}, drawing at scale ${before.scale}`);
    // Everything below is a subtraction of two captures, so the picture has to
    // be the same picture when the same frame is asked for twice. If it is not,
    // every number here would be measuring the difference between two renders
    // instead of the layer.
    const noStarsAgain = await capture('none-again', { time: T, camera: camA, stars: 0 });
    const noStarsThird = await capture('none-third', { time: T, camera: camA, stars: 0 });
    const repeat = [
      largestDifference(noStars, noStarsAgain),
      largestDifference(noStars, noStarsThird),
      largestDifference(noStarsAgain, noStarsThird),
    ];
    check(
      'the same frame drawn twice is the same image',
      Math.min(...repeat) < 0.004,
      `three captures of one frame differ by ${repeat.map((d) => d.toFixed(5)).join(', ')}`,
    );
    const one = await capture('stars1', { time: T, camera: camA, stars: 1 });
    const two = await capture('stars2', { time: T, camera: camA, stars: 2 });
    const three = await capture('stars3', { time: T, camera: camA, stars: 3 });
    const layers = [subtract(one, noStars), subtract(two, one), subtract(three, two)];
    await save(layers[0] as Raster, 'layer1', 8);
    await save(layers[1] as Raster, 'layer2', 8);
    await save(layers[2] as Raster, 'layer3', 8);
    // The whole field, for the checks that are about stars rather than layers.
    const field = subtract(three, noStars);
    await save(field, 'field', 8);
    const fieldStars = findStars(field, 0.01);
    check(
      'the frame is a starless sky when asked for one',
      total(noStars) / (width * height) < 0.05,
      `mean ${(total(noStars) / (width * height)).toFixed(4)} with 0 layers`,
    );
    // Deeper layers are dimmer per star and there are more of them: the total
    // flux of the field has to grow with the number of layers drawn.
    const totals = [one, two, three].map((r) => total(r));
    check(
      'adding a layer only ever adds stars',
      totals[0]! < totals[1]! && totals[1]! < totals[2]!,
      `flux by layer count: ${totals.map((t) => t.toFixed(1)).join(' < ')}`,
    );

    const detected = layers.map((l) => findStars(l, 0.005));
    for (let i = 0; i < 3; i++) {
      const layer = layers[i] as Raster;
      const peaks = detected[i]!.map((s) => s.peak);
      const bins = levelCounts(layer, [0.02, 0.05, 0.1, 0.2]);
      report(
        `layer ${i + 1}: ${detected[i]!.length} stars above threshold, brightest ` +
          `${Math.max(...peaks, 0).toFixed(3)}, median ${median(peaks).toFixed(3)}; ` +
          `pixels at 0.02/0.05/0.1/0.2: ${bins.join('/')}; ` +
          `${findStars(layer, 0.0025).length} local maxima in all`,
      );
    }
    // The layers are three separate star sets: layer 1 is the sparse bright one,
    // and each layer below adds dimmer and more numerous stars.
    check(
      'each layer has its own stars, and deeper layers are denser and dimmer',
      detected.every((d) => d.length >= 8) &&
        detected[1]!.length > detected[0]!.length &&
        detected[2]!.length > detected[1]!.length &&
        median(detected[0]!.map((s) => s.peak)) > median(detected[2]!.map((s) => s.peak)),
      `${detected.map((d) => d.length).join(' / ')} stars, median peaks ` +
        detected.map((d) => median(d.map((s) => s.peak)).toFixed(3)).join(' / '),
    );
    check(
      'the layers are separate star sets, not the same stars twice',
      agreement(detected[0]!, detected[1]!) < 0.25,
      `layer 1 and 2 agree on ${(agreement(detected[0]!, detected[1]!) * 100).toFixed(1)}% of positions`,
    );

    // --- parallax: the depths move by their own amounts ----------------------
    const oneB = await capture('stars1-b', { time: T, camera: camB, stars: 1 });
    const twoB = await capture('stars2-b', { time: T, camera: camB, stars: 2 });
    const threeB = await capture('stars3-b', { time: T, camera: camB, stars: 3 });
    const noStarsB = await capture('none-b', { time: T, camera: camB, stars: 0 });
    const layersB = [subtract(oneB, noStarsB), subtract(twoB, oneB), subtract(threeB, twoB)];
    const detectedB = layersB.map((l) => findStars(l, 0.005));

    const nullShift = fieldShift(detected[0]!, detected[0]!);
    const shifts = detected.map((d, i) => fieldShift(d, detectedB[i] ?? d));
    const parallax = [0.16, 0.09, 0.04];
    const travelled = 0.3;
    // The camera moves perpendicular to its view and a star's view direction
    // shifts by (parallax × distance) radians; one radian is `height` pixels at
    // the middle of the frame, where uv is the tangent of the angle.
    const predicted = parallax.map((p) => p * travelled * height);
    report(
      `camera moved ${travelled} perpendicular to the view; predicted shift ` +
        predicted.map((p) => `${p.toFixed(1)}px`).join(', '),
    );
    for (let i = 0; i < 3; i++) {
      report(
        `layer ${i + 1}: ${shifts[i]!.px.toFixed(2)} px of a predicted ${predicted[i]!.toFixed(1)} ` +
          `(${((shifts[i]!.px / predicted[i]!) * 100).toFixed(0)}%), ` +
          `from ${shifts[i]!.pairs} pairs spread over ${shifts[i]!.spread.toFixed(1)} px`,
      );
    }
    check(
      'a starfield that does not move measures as not moving',
      Math.abs(nullShift.px) < 0.05,
      `${nullShift.px.toFixed(3)} px for a zero shift`,
    );
    check(
      'every layer moves with the camera',
      shifts.every((s) => Math.abs(s.px) > 1.5 && s.pairs >= 5),
      shifts.map((s) => `${s.px.toFixed(1)}px from ${s.pairs} pairs`).join(', '),
    );
    const ratios = [shifts[0]!.px / shifts[2]!.px, shifts[1]!.px / shifts[2]!.px];
    check(
      'the two nearer layers move further than the far one, in the ratio of their parallax',
      ratios[0]! > 3.0 && ratios[0]! < 5.0 && ratios[1]! > 1.7 && ratios[1]! < 2.9,
      `1:3 = ${ratios[0]!.toFixed(2)} (0.16:0.04 = 4), 2:3 = ${ratios[1]!.toFixed(2)} (0.09:0.04 = 2.25)`,
    );
    check(
      'the measured shift is the shift the parallax asks for',
      shifts.every((s, i) => Math.abs(s.px / predicted[i]! - 1) < 0.25),
      shifts.map((s, i) => `${((s.px / predicted[i]!) * 100).toFixed(0)}%`).join(', '),
    );

    // --- colour temperature --------------------------------------------------
    const warm = fieldStars.filter((s) => s.warmth > 0.04).length;
    const cool = fieldStars.filter((s) => s.warmth < -0.04).length;
    const warmth = fieldStars.map((s) => s.warmth).sort((a, b) => a - b);
    const quantile = (q: number): number => warmth[Math.min(warmth.length - 1, Math.floor(q * warmth.length))] ?? 0;
    const coolTint = starTint(0);
    const warmTint = starTint(1);
    report(
      `star colour (r-b)/(r+b): p10 ${quantile(0.1).toFixed(3)}, median ${quantile(0.5).toFixed(3)}, ` +
        `p90 ${quantile(0.9).toFixed(3)}`,
    );
    report(
      `the shader's tints are ${coolTint.map((c) => c.toFixed(2)).join('/')} (cool) and ` +
        `${warmTint.map((c) => c.toFixed(2)).join('/')} (warm), linearly`,
    );
    check(
      'stars come in both colour temperatures, from the hash',
      warm >= 8 && cool >= 8,
      `${warm} warm and ${cool} cool of ${fieldStars.length} stars`,
    );
    check(
      'the warm and cool stars are meaningfully different colours',
      quantile(0.9) - quantile(0.1) > 0.15,
      `p90-p10 = ${(quantile(0.9) - quantile(0.1)).toFixed(3)}`,
    );

    // --- twinkle -------------------------------------------------------------
    const later = T + 5;
    const threeLater = await capture('field-later', { time: later, camera: camA, stars: 3 });
    const noneLater = await capture('none-later', { time: later, camera: camA, stars: 0 });
    const fieldLater = subtract(threeLater, noneLater);
    // The camera is explicit and identical, so a star sits on the same pixel at
    // both times: the ratio of the two is the twinkle itself.
    const twinkles: number[] = [];
    for (const star of fieldStars.slice(0, 80)) {
      const pixel = star.y * width + star.x;
      const a = field.rgb[pixel * 3]!;
      const b = fieldLater.rgb[pixel * 3]!;
      if (a > 0.05) twinkles.push(b / a);
    }
    twinkles.sort((a, b) => a - b);
    if (twinkles.length < 10) {
      check('enough bright stars to watch twinkle', false, `only ${twinkles.length} stars above the noise`);
    }
    const dimmer = twinkles.filter((v) => v < 0.95).length;
    const brighter = twinkles.filter((v) => v > 1.05).length;
    report(
      `twinkle over 5 s: ${twinkles.length} stars, ratio ${twinkles[0]!.toFixed(2)}..${twinkles[twinkles.length - 1]!.toFixed(2)}, ` +
        `${brighter} brighter / ${dimmer} dimmer`,
    );
    check(
      'stars twinkle, both ways, from the hash',
      brighter >= 3 && dimmer >= 3 && twinkles.length >= 10,
      `${brighter} brighter and ${dimmer} dimmer of ${twinkles.length}`,
    );
    check(
      'no star blinks out or doubles in one breath',
      twinkles[0]! > 0.3 && twinkles[twinkles.length - 1]! < 2.6,
      `ratio range ${twinkles[0]!.toFixed(2)}..${twinkles[twinkles.length - 1]!.toFixed(2)} ` +
        `(the shader's own range is 0.44..2.27)`,
    );

    // --- diffraction spikes --------------------------------------------------
    const spiked = fieldStars.filter((s) => s.spikeReach >= 5);
    const symmetric = spiked.filter((s) => Math.abs(s.reachX - s.reachY) <= 2).length;
    report(
      `star shape: ${spiked.length} of ${fieldStars.length} carry light along both axes to ` +
        `${median(spiked.map((s) => s.spikeReach)).toFixed(0)} px — past the 4½ px the largest disc ` +
        `reaches — and ${symmetric} of those do it equally on both axes`,
    );
    check(
      'a few of the field stars carry diffraction spikes, and most do not',
      spiked.length >= 3 && spiked.length / fieldStars.length < 0.2,
      `${spiked.length} of ${fieldStars.length} stars spiked (${((spiked.length / fieldStars.length) * 100).toFixed(1)}%)`,
    );
    check(
      'the spikes are crosses: the light reaches as far along one axis as the other',
      symmetric >= Math.ceil(spiked.length * 0.6),
      `${symmetric} of ${spiked.length} spiked stars are symmetric within 2 px`,
    );

    // --- the Milky Way band --------------------------------------------------
    // Look along a direction *perpendicular* to the band's normal, so the band
    // crosses the middle of the frame and the profile is centred on it.
    const bandCamera = alongBand([0, 0, 0.4], BAND_NORMAL);
    const band = await capture('band', { time: T, camera: bandCamera, stars: 0 });
    const profile = bandProfile(band, bandCamera, BAND_NORMAL);
    // Only the bins the frame actually reaches: past the frame's own edge there
    // are no pixels at all, and a mean of nothing would read as a floor of zero.
    let lastFilled = 0;
    for (let i = 0; i < profile.count.length; i++) if ((profile.count[i] ?? 0) > 200) lastFilled = i;
    const floor = profile.mean[lastFilled] ?? 0;
    const peak = profile.mean[0] ?? 0;
    const half = (peak + floor) / 2;
    // Undo the gamma the shader ends with, so the profile is the light the band
    // made rather than its encoding. ACES is linear this dark, so the shape
    // survives the tone mapping and the width is the Gaussian's own width.
    const linear = profile.mean.map((v) => Math.pow(Math.max(0, v), 2.2));
    const peakLinear = (linear[0] ?? 0) - (linear[lastFilled] ?? 0);
    let halfWidth = 0;
    for (let i = 1; i <= lastFilled; i++) {
      const previous = (linear[i - 1] ?? 0) - (linear[lastFilled] ?? 0);
      const current = (linear[i] ?? 0) - (linear[lastFilled] ?? 0);
      if (previous >= peakLinear / 2 && current < peakLinear / 2) {
        const f = (previous - peakLinear / 2) / Math.max(1e-12, previous - current);
        halfWidth = (profile.b[i - 1] ?? 0) + ((profile.b[i] ?? 0) - (profile.b[i - 1] ?? 0)) * f;
        break;
      }
    }
    // Spec §3's Gaussian is exp(-(b/0.24)^2), which is half its peak at b=0.2.
    // The width is measured in *linear* light: the capture is gamma-encoded, and
    // half of a gamma-encoded profile is not half of the light that made it.
    report(
      `band profile: peak ${peak.toFixed(4)} at b=0, floor ${floor.toFixed(4)} at |b| = ` +
        `${(profile.b[lastFilled] ?? 0).toFixed(2)}; half height at |b| = ${halfWidth.toFixed(3)} ` +
        `(the shader's Gaussian says 0.200)`,
    );
    check(
      'the Milky Way is a band: bright on its great circle, dark away from it',
      peak > floor * 1.8,
      `peak ${peak.toFixed(4)} vs floor ${floor.toFixed(4)} (${(peak / Math.max(1e-9, floor)).toFixed(2)}×)`,
    );
    check(
      'the band is the width the shader draws',
      halfWidth > 0.15 && halfWidth < 0.26,
      `${halfWidth.toFixed(3)} against a predicted 0.200`,
    );
    check(
      'the band stays faint: it is a whisper, not a fog',
      peak < 0.16,
      `mean luminance on the band ${peak.toFixed(4)}`,
    );
    // Dust lanes: with the band's normal as the camera's up, two strips mirrored
    // about the middle of the frame are on the same band brightness under the
    // same vignette — so what the ratio between them varies with is the dust.
    const dust = dustAlongBand(band, bandCamera, BAND_NORMAL);
    report(
      `along the band (|b| < 0.04, 8 px columns): mirrored halves average ` +
        `${dust.ratio.toFixed(3)}, varying by ${(dust.spread * 100).toFixed(1)}%`,
    );
    check(
      'the band has structure along it (dust lanes), not a flat stripe',
      dust.spread > 0.02 && Math.abs(dust.ratio - 1) < 0.1,
      `the mirrored halves differ by ${(dust.spread * 100).toFixed(1)}% from column to column ` +
        `(a featureless band would give 0%)`,
    );

    // --- a far-away event lights a distant star ------------------------------
    const flares = JSON.parse(
      (await chrome.send<{ result: { value: string } }>('Runtime.evaluate', {
        expression: `(() => {
          const found = [];
          let current = null;
          for (let t = 0; t < 3600; t += 0.5) {
            const f = __singularity.flareAt(t);
            if (!f) { if (current) { found.push(current); current = null; } continue; }
            if (!current || f.level > current.level) current = { t: t, level: f.level, dir: f.dir };
          }
          if (current) found.push(current);
          return JSON.stringify(found.slice(0, 4));
        })()`,
        returnByValue: true,
      }, 60000)).result.value,
    ) as { t: number; level: number; dir: Vec3 }[];
    check(
      'the journey schedules far-away events, and each lights a star',
      flares.length >= 3 && flares.every((f) => f.level > 0.2),
      `${flares.length} events in the first hour, peaks ${flares.map((f) => f.level.toFixed(2)).join(', ')}`,
    );

    let litPositions: { x: number; y: number }[] = [];
    for (const [index, flare] of flares.slice(0, 2).entries()) {
      // Point the camera at wherever the event put its star: the sky is wide and
      // an event's direction comes from its own pan and offset, so looking along
      // a fixed direction would usually miss it.
      const flareCam = cam([0, 0, 0.4], Math.atan2(flare.dir[0], flare.dir[2]), Math.asin(flare.dir[1]));
      const on = await capture(`flare${index + 1}-on`, { time: flare.t, camera: flareCam, stars: 1 });
      const off = await capture(`flare${index + 1}-off`, {
        time: flare.t,
        camera: flareCam,
        stars: 1,
        flare: 0,
      });
      const lit = subtract(on, off);
      await save(lit, `flare${index + 1}-lit`, 8);
      const found = findStars(lit, 0.02, 8);
      const brightest = found[0];
      const field = findStars(off, 0.012, 8)[0];
      if (!brightest || !field) {
        check(`event ${index + 1} lights a star`, false, 'no star found in the difference');
        continue;
      }
      // The star the event lights must be *where the conductor said*: project the
      // event's own direction through the same camera basis the shader uses, and
      // allow for the far layer's parallax.
      const expected = project(
        flareCam,
        unit(sub(flare.dir, scale(flareCam.position, 0.05))),
        width,
        height,
      );
      const offBy = Math.hypot(brightest.x - expected.x, brightest.y - expected.y);
      report(
        `event ${index + 1} at t=${flare.t.toFixed(1)}s, level ${flare.level.toFixed(2)}: lit star at ` +
          `(${brightest.x}, ${brightest.y}), the conductor's direction projects to ` +
          `(${expected.x.toFixed(0)}, ${expected.y.toFixed(0)})`,
      );
      check(
        `event ${index + 1} lights a star where the conductor put it, brighter than any other`,
        offBy < 6 && brightest.peak > field.peak * 1.2,
        `${offBy.toFixed(1)} px away, peak ${brightest.peak.toFixed(3)} vs the brightest field star ${field.peak.toFixed(3)}`,
      );
      litPositions.push({ x: brightest.x, y: brightest.y });
    }
    const directionsApart = flares.length >= 2 ? Math.hypot(
      flares[0]!.dir[0] - flares[1]!.dir[0],
      flares[0]!.dir[1] - flares[1]!.dir[1],
      flares[0]!.dir[2] - flares[1]!.dir[2],
    ) : 0;
    check(
      'each event lights its own part of the sky',
      litPositions.length === 2 && directionsApart > 0.5,
      `the two events are ${directionsApart.toFixed(2)} apart on the sky (a unit sphere spans 2)`,
    );

    check('nothing threw on the way', chrome.errors.length === 0, chrome.errors.slice(0, 3).join(' | '));
    if (chrome.logs.length) {
      console.log('\n  console:');
      for (const entry of chrome.logs.slice(0, 10)) console.log(`    [${entry.level}] ${entry.text.slice(0, 160)}`);
    }
    console.log(`\n  captures: ${ARTIFACTS}`);
  } catch (error) {
    console.error(`\n  star test error: ${(error as Error).message}`);
    for (const failure of chrome.errors.slice(0, 8)) console.error(`    [error] ${String(failure).slice(0, 400)}`);
    throw error;
  } finally {
    await harness.close();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

/** How many pixels of a raster reach each of a list of levels. */
function levelCounts(raster: Raster, levels: number[]): number[] {
  const counts = levels.map(() => 0);
  for (let y = 0; y < raster.height; y++) {
    for (let x = 0; x < raster.width; x++) {
      const v = lumaAt(raster, x, y);
      for (let i = 0; i < levels.length; i++) if (v >= (levels[i] ?? 1)) counts[i] = (counts[i] ?? 0) + 1;
    }
  }
  return counts;
}

/** The middle value of a list (0 for an empty one). */
function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** How many of `a`'s star positions have a star of `b` within 1.5 px. */
function agreement(a: Star[], b: Star[]): number {
  if (!a.length) return 0;
  let found = 0;
  for (const star of a) {
    if (b.some((other) => Math.hypot(other.x - star.x, other.y - star.y) < 1.5)) found++;
  }
  return found / a.length;
}

/** Mean luminance against the angle from the band's great circle. */
function bandProfile(
  raster: Raster,
  camera: Camera,
  normal: Vec3,
  bins = 16,
  step = 0.04,
): { b: number[]; mean: number[]; count: number[] } {
  const sums = new Float64Array(bins);
  const counts = new Float64Array(bins);
  for (let y = 0; y < raster.height; y += 2) {
    for (let x = 0; x < raster.width; x += 2) {
      const dir = directionAt(camera, x + 0.5, y + 0.5, raster.width, raster.height);
      const b = Math.abs(dot(dir, normal));
      const bin = Math.min(bins - 1, Math.floor(b / step));
      sums[bin] += lumaAt(raster, x, y);
      counts[bin] += 1;
    }
  }
  const b: number[] = [];
  const mean: number[] = [];
  const count: number[] = [];
  for (let i = 0; i < bins; i++) {
    b.push((i + 0.5) * step);
    mean.push(counts[i]! > 0 ? sums[i]! / counts[i]! : 0);
    count.push(counts[i]!);
  }
  return { b, mean, count };
}

/**
 * The dust the band shows through, isolated from everything else in the frame.
 *
 * With `alongBand`'s camera the angle from the band is exactly the pixel's
 * vertical angle, so two strips mirrored about the middle of the frame sit at
 * the *same* angle from the band (the same brightness) and the *same* distance
 * from the frame's centre (the same vignette). The only thing left to differ
 * between them is which way the sky turns — which is the dust. A flat band with
 * no structure would give a ratio of 1 in every column.
 */
function dustAlongBand(
  raster: Raster,
  camera: Camera,
  normal: Vec3,
  band = 0.04,
  block = 8,
): { ratio: number; spread: number } {
  const ratios: number[] = [];
  for (let bx = 0; bx + block <= raster.width; bx += block) {
    let above = 0;
    let below = 0;
    let count = 0;
    for (let y = 0; y < raster.height; y++) {
      for (let x = bx; x < bx + block; x++) {
        const b = dot(directionAt(camera, x + 0.5, y + 0.5, raster.width, raster.height), normal);
        if (Math.abs(b) > band) continue;
        if (b >= 0) above += lumaAt(raster, x, y);
        else below += lumaAt(raster, x, y);
        count += b >= 0 ? 1 : 0;
      }
    }
    if (count <= 0 || below <= 0) continue;
    ratios.push(above / below);
  }
  if (!ratios.length) return { ratio: 0, spread: 0 };
  const mean = ratios.reduce((s, v) => s + v, 0) / ratios.length;
  const variance = ratios.reduce((s, v) => s + (v - mean) ** 2, 0) / ratios.length;
  return { ratio: mean, spread: Math.sqrt(variance) / Math.max(1e-9, mean) };
}

await main().catch((error) => {
  console.error(error);
  process.exit(2);
});
