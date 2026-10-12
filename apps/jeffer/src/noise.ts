// Value noise, one and two dimensions. Pure and seeded, so the colour field's
// slow wander is the same wander on every load of the same set (spec §3).
//
// Value noise rather than gradient noise: the picture wants something soft and
// cheap, and the scope layer is doing the detail work.

import { mix32 } from './rng.ts';

/** A smooth 1D value in [-1, 1] at `x`, from a seeded lattice. */
export function noise1(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  // Smoothstep, so the lattice points are the only places the derivative
  // changes — the field has no visible creases in it.
  const u = f * f * (3 - 2 * f);
  const a = lattice1(i, seed);
  const b = lattice1(i + 1, seed);
  return (a + (b - a) * u) * 2 - 1;
}

function lattice1(i: number, seed: number): number {
  return mix32(seed, i | 0) / 4294967296;
}

/**
 * Fractal 1D: `octaves` of noise1 at doubling frequency and halving amplitude.
 * Returns roughly [-1, 1].
 */
export function fbm1(x: number, octaves = 4, seed = 1): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += noise1(x * freq, mix32(seed, o | 0)) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return norm > 0 ? sum / norm : 0;
}

/** A smooth 2D value in [-1, 1] at (x, y), from a seeded lattice. */
export function noise2(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const ux = xf * xf * (3 - 2 * xf);
  const uy = yf * yf * (3 - 2 * yf);
  const c00 = lattice2(xi, yi, seed);
  const c10 = lattice2(xi + 1, yi, seed);
  const c01 = lattice2(xi, yi + 1, seed);
  const c11 = lattice2(xi + 1, yi + 1, seed);
  const top = c00 + (c10 - c00) * ux;
  const bottom = c01 + (c11 - c01) * ux;
  return (top + (bottom - top) * uy) * 2 - 1;
}

function lattice2(x: number, y: number, seed: number): number {
  return mix32(mix32(seed, x | 0), y | 0) / 4294967296;
}

/** Fractal 2D, `octaves` deep. */
export function fbm2(x: number, y: number, octaves = 4, seed = 1): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += noise2(x * freq, y * freq, mix32(seed, o | 0)) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  return norm > 0 ? sum / norm : 0;
}
