// Seeded pseudo-random numbers. Pure: no DOM, no clock. Every stream in the app
// comes from here, so a seed reproduces a journey exactly (spec §2, §5).
//
// The generator is sfc32: fast, good enough statistically for texture, and
// trivially portable if a layer ever moves into wasm or a shader.

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
    // sfc32 wants a little warm-up before its output looks random.
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

/** A human-readable seed for a new journey. The only non-deterministic call in
 *  the app, and it is called once, from the UI, when no seed is supplied. */
export function randomSeed(): string {
  const pick = (arr: readonly string[]): string => arr[Math.floor(Math.random() * arr.length)] as string;
  const adjectives = [
    'quiet', 'distant', 'deep', 'slow', 'cold', 'amber', 'pale', 'wide',
    'drifting', 'ancient', 'faint', 'still', 'hollow', 'luminous',
  ];
  const nouns = [
    'orbit', 'veil', 'drift', 'nebula', 'field', 'tide', 'halo', 'expanse',
    'chorus', 'vessel', 'cinder', 'aurora', 'void', 'signal',
  ];
  const tail = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0');
  return `${pick(adjectives)}-${pick(nouns)}-${tail}`;
}
