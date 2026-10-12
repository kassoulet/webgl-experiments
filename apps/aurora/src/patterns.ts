// Aurora drum and synth patterns.

import { hashUnit } from '@fractal-rave/shared';

type Template = string;

const KICK: Template[] = [
  'x...x...x...x...',
  'x...x...x...x.o.',
  'x..x.x...x...x..',
];

const BASS: Template[] = [
  'x.x.x.x.x.x.x.x.',
  'x..x..x.x..x.x..',
  'x.x..x.x.x..x.x.',
];

const HAT: Template[] = [
  '....x...x...x...',
  '..x.x.x.x.x.x.x.',
  '.x.x.x.x.x.x.x.x',
];

const CLAP: Template[] = [
  '....x.......x...',
  '....x.......x...',
];

const PERC: Template[] = [
  '........x.......',
  '...x......x.....',
];

const STAB: Template[] = [
  'x...............',
  '....x...........',
  '........x.......',
];

const ARP: Template[] = [
  'x.x.x.x.x.x.x.x.',
  '.x.x.x.x.x.x.x.x',
  'x..x..x..x..x..x',
];

const PAD: Template[] = [
  'x...............',
  'x...............',
];

const FX: Template[] = [
  '................',
  '................',
];

const PATTERNS = {
  kick: KICK, bass: BASS, hat: HAT, clap: CLAP, perc: PERC,
  stab: STAB, arp: ARP, pad: PAD, fx: FX,
};

export type Instrument = keyof typeof PATTERNS;

/** The instruments in one canonical order, so every consumer iterates alike. */
export const INSTRUMENTS: Instrument[] = ['kick', 'bass', 'hat', 'clap', 'perc', 'stab', 'arp', 'pad', 'fx'];

export interface BarPatterns {
  kick: boolean[];
  bass: boolean[];
  hat: boolean[];
  clap: boolean[];
  perc: boolean[];
  stab: boolean[];
  arp: boolean[];
  pad: boolean[];
  fx: boolean[];
}

export const VOICE_TONES: Record<Instrument, number> = {
  kick: 0, bass: 1, hat: 2, clap: 3, perc: 4,
  stab: 5, arp: 6, pad: 7, fx: 8,
};

function templateToPattern(t: Template): boolean[] {
  return t.split('').map((c) => c === 'x');
}

function pickPattern(rng: number, templates: Template[]): Template {
  return templates[Math.floor(rng * templates.length)];
}

export function patternsFor(seed: string, bar: number, section: string): BarPatterns {
  const seedHash = hashString(seed);
  // The section biases the draw: a different passage shifts every hash, so a
  // chorus does not inherit the verse's exact variations.
  const sectionHash = hashString(section);

  const result: BarPatterns = {
    kick: [], bass: [], hat: [], clap: [], perc: [],
    stab: [], arp: [], pad: [], fx: [],
  };

  for (const inst of INSTRUMENTS) {
    const h = hashUnit(seedHash, bar, VOICE_TONES[inst], sectionHash);
    const template = pickPattern(h, PATTERNS[inst]);
    result[inst] = templateToPattern(template);
  }

  return result;
}

function hashString(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}