// Seeded pseudo-random numbers. Pure: no DOM, no clock. Every stream in the app
// comes from here, so a seed reproduces a set exactly.

import type { Seed } from './types.ts';

/** FNV-1a with a final avalanche: any string becomes a uint32. */
export function hashString(str: string): number {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Combine a uint32 state with another uint32 into a fresh uint32 (splitmix step). */
export function mix32(a: number, b: number): number {
  let z = (a + 0x9e3779b9) >>> 0;
  z = Math.imul(z ^ (b >>> 0), 0x85ebca6b) >>> 0;
  z = (z ^ (z >>> 13)) >>> 0;
  z = Math.imul(z, 0xc2b2ae35) >>> 0;
  z = (z ^ (z >>> 16)) >>> 0;
  return z >>> 0;
}

/**
 * A stateless hash of up to four integers. Where the conductor needs a number
 * for `(section, phrase, instrument, step)` it must be the same number however
 * often and in whatever order it is asked for — a *function*, never a stream.
 * This is that function, and it is why `src/patterns.ts` needs no schedule list.
 */
export function hash4(a: number, b: number, c: number, d: number): number {
  return mix32(mix32(mix32(a | 0, b | 0), c | 0), d | 0);
}

/** The same, reduced to [0, 1). */
export function hashUnit(a: number, b: number, c: number, d: number): number {
  return hash4(a, b, c, d) / 4294967296;
}

/** Any seed the UI or a link can carry becomes a non-zero uint32. */
export function normalizeSeed(seed: Seed): number {
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    const n = Math.floor(Math.abs(seed)) >>> 0;
    return n || 1;
  }
  const s = String(seed ?? '').trim();
  if (s === '') return 1;
  if (/^\d{1,10}$/.test(s)) {
    const n = Number(s) >>> 0;
    return n || 1;
  }
  return hashString(s) || 1;
}

export class Rng {
  readonly seed: number;
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: Seed) {
    this.seed = normalizeSeed(seed);
    const s = this.seed;
    this.a = mix32(s, 0x9e3779b9);
    this.b = mix32(s, 0x85ebca6b);
    this.c = mix32(s, 0xc2b2ae35);
    this.d = mix32(s, 0x27d4eb2f);
    for (let i = 0; i < 15; i++) this.next();
  }

  /** uint32 */
  next(): number {
    let { a, b, c, d } = this;
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    return t >>> 0;
  }

  /** [0, 1) */
  float(): number {
    return this.next() / 4294967296;
  }

  /** [lo, hi) */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.float();
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.float() * n) % Math.max(1, n | 0);
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)] as T;
  }

  chance(p: number): boolean {
    return this.float() < p;
  }

  /** Signed, roughly normal in [-1, 1] (sum of two uniforms). */
  signed(): number {
    return this.float() - this.float();
  }

  /** A separate, independent stream. Use one per layer so that adding a layer
   *  does not shift the numbers another layer already consumed. */
  fork(label: string): Rng {
    return new Rng(mix32(this.seed, hashString(String(label))));
  }
}

/** A human-readable seed for a new set. The only non-deterministic call in the
 *  app, and it is called once, from the UI, when no seed is supplied. */
export function randomSeed(adjectives?: readonly string[], nouns?: readonly string[]): string {
  const pick = (arr: readonly string[]): string => arr[Math.floor(Math.random() * arr.length)] as string;
  const defaultAdjectives = [
    'acid', 'basement', 'warehouse', 'neon', 'midnight', 'feral', 'chrome',
    'hypnotic', 'molten', 'static', 'rogue', 'signal', 'underground', 'pale',
    'neon', 'synth', 'electric', 'luminous', 'radiant', 'aurora', 'cosmic',
  ];
  const defaultNouns = [
    'cathedral', 'circuit', 'strobe', 'grotto', 'pylon', 'anvil', 'prism',
    'turbine', 'kaleido', 'reactor', 'vector', 'spiral', 'voltage', 'monolith',
    'wave', 'pulse', 'echo', 'drift', 'horizon', 'zenith', 'eclipse',
  ];
  const adj = adjectives ?? defaultAdjectives;
  const noun = nouns ?? defaultNouns;
  const tail = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0');
  return `${pick(adj)}-${pick(noun)}-${tail}`;
}