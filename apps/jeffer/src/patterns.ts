// The step patterns. A *bank* of sixteen-step templates per instrument, and a
// hash that picks one per phrase — there is no schedule list here and there
// must never be one (spec §2).
//
// The rule that makes this work: `patternsFor(seed, bar, sectionIndex)` must
// answer the same sixteen steps however often it is asked, in whatever order,
// from whatever direction. That is what lets the audio scheduler and the picture
// agree about a bar without either of them owning a list, and it is why the
// conductor carries no pattern state at all.
//
// The bank is written sparse-to-dense inside each instrument, and each passage
// names a window into it. A breakdown is the sparse end of the same vocabulary
// rather than a different set of patterns, which is how a breakdown can be the
// same groove with the drums taken away and still be recognisably the record.

import { hashUnit } from './rng.ts';
import type { SectionName } from './types.ts';

export const INSTRUMENTS = ['kick', 'bass', 'hat', 'clap', 'perc', 'stab', 'arp'] as const;
export type Instrument = (typeof INSTRUMENTS)[number];

/**
 * One character per sixteenth.
 *
 *   `.`  rest
 *   1-8  a note at that tone, ordinary velocity
 *   A-H  a note at that tone, accented
 *   `-`  a ghost: the same note again, quietly — the thing that makes a
 *        sixteenth line feel played rather than sequenced
 */
const BANK: Record<Instrument, readonly string[]> = {
  // Four on the floor, and the sixteenth pickup that turns a kick into a
  // pattern. Electro keeps the kick plain and puts the interest in the bass.
  kick: [
    '1...1...1...1...',
    '1..11...1...1...',
    '1...1...1..11...',
    '1..1....1...1.1.',
    '1...1..11...1...',
  ],
  // The bass is the record. Every one of these is a roll: sixteenths with a
  // rest or an octave in them, never a held note, because a held note is a
  // pad and this is not a pad.
  bass: [
    '1.11.11.11.11.1.',
    '1.1A111.11111.11',
    '1121121121121121',
    '1.11.11A111.11A1',
    '11A111.11111A11.',
    '1A1A1A.11A1A1A.1',
  ],
  hat: [
    '1.1.1.1.1.1.1.1.',
    '1.1A1.1.1A1.1.1A.',
    '1111A1111111A111',
    '1-1A1-11-1A1-11-',
    '-1A1A1A-1A1A1A-1',
  ],
  clap: [
    '....1.......1...',
    '....1...1...1...',
    '....1.......1.-.',
    '..........1...1.',
    '....1..1....1...',
  ],
  perc: [
    '......1.....1..',
    '...1.....1.....',
    '..1..1...1..1..',
    '.....1...1...1.',
    '1...1...1...1..-',
  ],
  stab: [
    '..1......1.....',
    '...1.....1....1',
    '.1...1...1...1.',
    '........1...1..',
    '1..1..1..1..1..1',
  ],
  arp: [
    '...1.......1...',
    '..1...1...1...1',
    '.1...1...1...1.',
    '1...1...1...1..',
    '..1..1..1..1..1',
  ],
};

/** How many distinct tones the bass line walks. Electro bass lines move by
 *  step and by octave, not by chord, so the tones are offsets from the root. */
export const VOICE_TONES = 3;

/**
 * The window into each bank that a passage plays. Sparse on the left, dense on
 * the right; a breakdown is `[0, 1]` and a drop is the whole bank.
 */
const DENSITY: Record<SectionName, [number, number]> = {
  intro: [0, 1],
  build: [0, 2],
  groove: [1, 3],
  drop: [2, 5],
  break: [0, 1],
  peak: [3, 5],
};

export interface StepPattern {
  /** 0..255 per step; 0 is a rest. */
  velocity: Uint8Array;
  /** Which tone this step plays, per instrument's own scale. */
  tone: Uint8Array;
  fill: boolean;
}

export interface BarPatterns {
  kick: StepPattern;
  bass: StepPattern;
  hat: StepPattern;
  clap: StepPattern;
  perc: StepPattern;
  stab: StepPattern;
  arp: StepPattern;
  /** True when this bar carries a fill. */
  fill: boolean;
  /** Which four-bar phrase this bar belongs to. */
  phrase: number;
}

const ORDINARY = 0.72;
const ACCENT = 1.0;
const GHOST = 0.34;

function velocityOf(ch: string): number {
  if (ch === '.') return 0;
  if (ch === '-') return GHOST;
  const code = ch.charCodeAt(0);
  if (code >= 65 && code <= 72) return ACCENT; // A-H
  return ORDINARY; // 1-8
}

function toneOf(ch: string): number {
  if (ch === '.' || ch === '-') return 0;
  const code = ch.charCodeAt(0);
  if (code >= 65 && code <= 72) return code - 65;
  if (code >= 49 && code <= 56) return code - 49;
  return 0;
}

/**
 * The last bar of every four-bar phrase, and that is every passage's last bar
 * too, because passages are whole numbers of phrases. A fill is therefore
 * always *in front of* a change, which is the entire reason the conductor
 * rounds its bar counts: without it a drop can arrive with nothing before it.
 */
export function isFillBar(bar: number): boolean {
  return ((bar % 4) + 4) % 4 === 3;
}

/** Add hits to the last beat of a bar, so it rolls into the next one. */
function applyFill(pattern: StepPattern, seed: number, phrase: number): void {
  const hits = 2 + (Math.floor(hashUnit(seed, phrase, 41, 7) * 3) % 3);
  // The roll lands in the last quarter — a fill that spread across the whole
  // bar would not read as a roll into the next one, it would read as a
  // different groove.
  const from = 16 - hits;
  for (let i = 0; i < hits; i++) {
    const step = from + i;
    // Each hit is louder than the one before it: a roll has to build or it is
    // just three more hits.
    const ramp = 0.5 + (0.5 * (i + 1)) / hits;
    pattern.velocity[step] = Math.round(Math.min(1, ramp) * 255);
  }
}

function build(template: string, fill: boolean, seed: number, phrase: number): StepPattern {
  const velocity = new Uint8Array(16);
  const tone = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    const ch = template[i] ?? '.';
    velocity[i] = Math.round(Math.min(1, velocityOf(ch)) * 255);
    tone[i] = toneOf(ch);
  }
  const pattern: StepPattern = { velocity, tone, fill };
  if (fill) applyFill(pattern, seed, phrase);
  return pattern;
}

/**
 * The sixteen steps of every instrument for one absolute bar.
 *
 * Note what is *not* here: no state, no cursor, no list of what came before.
 * The bar number is the whole input, so asking for bar 900 and then bar 3
 * gives the same answer as asking for bar 3 first.
 */
export function patternsFor(seed: number, bar: number, sectionIndex: number, section: SectionName): BarPatterns {
  const phrase = Math.floor(bar / 4);
  const fill = isFillBar(bar);
  const window = DENSITY[section];

  const draw = (instrument: Instrument): StepPattern => {
    const bank = BANK[instrument];
    const lo = window[0];
    const hi = Math.min(bank.length - 1, window[1]);
    const span = Math.max(1, hi - lo + 1);
    const at = INSTRUMENTS.indexOf(instrument);
    // A different offset per instrument, so the kick and the hat are not
    // picking the same index out of the same hash and arriving together.
    const roll = hashUnit(seed, sectionIndex, phrase, 7 + at * 13);
    const pick = lo + (Math.floor(roll * span) % span);
    return build(bank[pick] as string, fill, seed, phrase);
  };

  return {
    kick: draw('kick'),
    bass: draw('bass'),
    hat: draw('hat'),
    clap: draw('clap'),
    perc: draw('perc'),
    stab: draw('stab'),
    arp: draw('arp'),
    fill,
    phrase,
  };
}

/**
 * How a synth line walks the chord: which chord tones it visits, in what
 * order. Electro stabs are almost always a *shape* rather than an arpeggio of
 * the chord — two notes, a gap, a third — so the contour is short and
 * directional rather than a sweep.
 */
export function contourFor(seed: number, sectionIndex: number, phrase: number, count: number): number[] {
  const shape = Math.floor(hashUnit(seed, sectionIndex, phrase, 991) * 4);
  const tones = Math.max(1, count);
  const out: number[] = [];
  switch (shape) {
    case 0: // root and third, alternating
      for (let i = 0; i < count; i++) out.push(i % 2);
      break;
    case 1: // a rising pair
      for (let i = 0; i < count; i++) out.push(i % tones);
      break;
    case 2: // a falling pair
      for (let i = 0; i < count; i++) out.push((tones - 1 - (i % tones)) % tones);
      break;
    default: // one note held
      for (let i = 0; i < count; i++) out.push(0);
      break;
  }
  return out;
}

/** The density window a passage plays from, for the tests and the HUD. */
export function densityFor(section: SectionName): [number, number] {
  return DENSITY[section];
}
