// Value noise, 1D and 2D. Pure and seeded: the same seed gives the same drift,
// in the audio and the picture alike (spec §2 "endless without repeating").
//
// The GPU has its own noise (see src/visuals/shaders.ts); this one runs on the
// main thread for slow parameter wander, so it stays cheap and allocation-free.

function hashInt(i: number, seed: number): number {
  let h = (Math.imul(i | 0, 0x27d4eb2f) ^ Math.imul(seed | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

const lattice1 = (i: number, seed: number): number => hashInt(i, seed) / 4294967296;

const smootherstep = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** 1D value noise in [0, 1). */
export function valueNoise1(x: number, seed = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = lattice1(i, seed);
  const b = lattice1(i + 1, seed);
  return a + (b - a) * smootherstep(f);
}

/** Signed 1D noise in [-1, 1). */
export function signedNoise1(x: number, seed = 0): number {
  return valueNoise1(x, seed) * 2 - 1;
}

/** Fractional Brownian motion of 1D value noise, normalised to [0, 1). */
export function fbm1(x: number, octaves = 4, seed = 0, gain = 0.5, lacunarity = 2): number {
  let sum = 0;
  let norm = 0;
  let amp = 1;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise1(x * freq, (seed + o * 0x9e37) | 0);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Signed fbm in [-1, 1). */
export function signedFbm1(x: number, octaves = 4, seed = 0): number {
  return fbm1(x, octaves, seed) * 2 - 1;
}

/** 2D value noise in [0, 1). */
export function valueNoise2(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const h = (ix: number, iy: number): number =>
    hashInt(Math.imul(ix | 0, 73856093) ^ Math.imul(iy | 0, 19349663), seed) / 4294967296;
  const a = h(xi, yi);
  const b = h(xi + 1, yi);
  const c = h(xi, yi + 1);
  const d = h(xi + 1, yi + 1);
  const u = smootherstep(xf);
  const v = smootherstep(yf);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

/** A slow wander around `center`, never leaving [center - span, center + span].
 *  Used for every parameter that must drift rather than jump (spec §2 "slow"). */
export function wander(
  t: number,
  period: number,
  center: number,
  span: number,
  seed = 0,
  octaves = 3,
): number {
  const n = fbm1(t / period, octaves, seed);
  return center + (n * 2 - 1) * span;
}
