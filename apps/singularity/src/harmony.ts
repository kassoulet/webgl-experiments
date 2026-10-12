// Keys, modes, chord construction and voice leading. Pure: seeded input, no DOM.
//
// This is the "harmony generator" the spec asks for (spec §2): key and mode,
// modal progressions, suspended and added-note voicings, and voice leading so
// each change moves as few notes as possible.

import type { Chord, Key, Mode, Register, ShapeName } from './types.ts';
import type { Rng } from './rng.ts';

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const NOTE_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

/** The church modes plus the two the spec names explicitly (minor, dorian,
 *  lydian). `flavour` steers chord shapes and the picture's palette. */
export const MODES: Record<string, Mode> = {
  aeolian: { name: 'aeolian', intervals: [0, 2, 3, 5, 7, 8, 10], flavour: 'melancholy' },
  dorian: { name: 'dorian', intervals: [0, 2, 3, 5, 7, 9, 10], flavour: 'wistful' },
  phrygian: { name: 'phrygian', intervals: [0, 1, 3, 5, 7, 8, 10], flavour: 'dark' },
  lydian: { name: 'lydian', intervals: [0, 2, 4, 6, 7, 9, 11], flavour: 'shimmering' },
  mixolydian: { name: 'mixolydian', intervals: [0, 2, 4, 5, 7, 9, 10], flavour: 'warm' },
  ionian: { name: 'ionian', intervals: [0, 2, 4, 5, 7, 9, 11], flavour: 'bright' },
  locrian: { name: 'locrian', intervals: [0, 1, 3, 5, 6, 8, 10], flavour: 'unstable' },
};

export const MODE_NAMES = Object.keys(MODES);

/** Minor-ish modes read better in flats: C aeolian has Eb, Ab, Bb, not D#, G#, A#. */
export function spellsFlat(modeName: string): boolean {
  const mode = MODES[modeName] ?? (MODES.aeolian as Mode);
  return mode.intervals[2] === 3;
}

export const pcName = (pc: number, modeName: string | null = null): string => {
  const names = modeName && spellsFlat(modeName) ? NOTE_NAMES_FLAT : NOTE_NAMES;
  return names[((pc % 12) + 12) % 12] as string;
};

/** The seven pitch classes of a key, ascending from the root. */
export function scalePitchClasses(rootPc: number, modeName: string): number[] {
  const mode = MODES[modeName] ?? (MODES.aeolian as Mode);
  return mode.intervals.map((iv) => (rootPc + iv) % 12);
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

/** Semitone offset of the scale's k-th step above degree `d` (octave-aware). */
function step(mode: Mode, d: number, k: number): number {
  const i = d + k;
  const oct = Math.floor(i / 7);
  const idx = ((i % 7) + 7) % 7;
  return (mode.intervals[idx] as number) + 12 * oct;
}

/** Offset of a scale step measured from the chord's own root, not the scale's. */
const off = (m: Mode, d: number, k: number): number => step(m, d, k) - step(m, d, 0);

/** Chord shapes, as intervals above the degree's root. The open ones (sus, add,
 *  quartal) are the ambient default: they ask no question and need no answer. */
export const SHAPES: Record<ShapeName, (m: Mode, d: number) => number[]> = {
  sus2: (m, d) => [0, off(m, d, 1), off(m, d, 4)],
  sus4: (m, d) => [0, off(m, d, 3), off(m, d, 4)],
  quartal: (m, d) => [0, off(m, d, 3), off(m, d, 6)],
  add9: (m, d) => [0, off(m, d, 2), off(m, d, 4), off(m, d, 8)],
  sixth: (m, d) => [0, off(m, d, 2), off(m, d, 4), off(m, d, 5)],
  triad: (m, d) => [0, off(m, d, 2), off(m, d, 4)],
  seventh: (m, d) => [0, off(m, d, 2), off(m, d, 4), off(m, d, 6)],
  ninth: (m, d) => [0, off(m, d, 2), off(m, d, 4), off(m, d, 6), off(m, d, 8)],
  eleventh: (m, d) => [0, off(m, d, 2), off(m, d, 4), off(m, d, 6), off(m, d, 10)],
};

const SHAPE_NAMES = Object.keys(SHAPES) as ShapeName[];

/** The chord's triad quality, from the intervals above its own root. */
function qualityOf(third: number, fifth: number): string {
  if (third === 3 && fifth === 6) return 'dim';
  if (third === 3) return 'm';
  if (third === 4 && fifth === 8) return 'aug';
  if (third === 2) return 'sus2';
  if (third === 5) return 'sus4';
  return '';
}

function suffixFor(shape: ShapeName, iv: number[]): string {
  const third = iv[1] ?? 4;
  const fifth = iv[2] ?? 7;
  const seventh = iv[3];
  const minor = third === 3;
  const quality = qualityOf(third, fifth);
  switch (shape) {
    case 'sus2':
      return 'sus2';
    case 'sus4':
      return 'sus4';
    case 'quartal':
      return 'quartal';
    case 'triad':
      return quality;
    case 'sixth':
      return `${quality}6`;
    case 'add9':
      return `${quality}add9`;
    case 'seventh':
      if (minor && fifth === 6) return 'm7b5';
      if (minor) return seventh === 11 ? 'mMaj7' : 'm7';
      if (fifth === 8) return 'aug7';
      return seventh === 11 ? 'maj7' : '7';
    case 'ninth':
      if (minor && fifth === 6) return 'm9b5';
      if (minor) return 'm9';
      return seventh === 11 ? 'maj9' : '9';
    case 'eleventh':
      if (minor) return 'm11';
      return seventh === 11 ? 'maj11' : '11';
    default:
      return quality;
  }
}

export interface ChordRequest {
  rootPc: number;
  modeName: string;
  degree: number;
  shape?: ShapeName;
}

/** Build a chord: root pitch class, its pitch classes, its intervals and a name. */
export function buildChord({ rootPc, modeName, degree, shape = 'triad' }: ChordRequest): Chord {
  const mode = MODES[modeName] ?? (MODES.aeolian as Mode);
  const fn = SHAPES[shape] ?? SHAPES.triad;
  const iv = fn(mode, degree);
  const root = (rootPc + step(mode, degree, 0) + 120) % 12;
  const pcs = iv.map((i) => (root + (((i % 12) + 12) % 12)) % 12);
  return {
    degree,
    rootPc: root,
    modeName,
    shape,
    pcs,
    intervals: iv,
    name: `${pcName(root, modeName)}${suffixFor(shape, iv)}`,
  };
}

const SKIP_COST = 8; // dropping or adding a voice is worse than moving one

/** Cost of the cheapest order-preserving match between two sorted voicings. */
function matchCost(prev: readonly number[], next: readonly number[]): number {
  const n = prev.length;
  const m = next.length;
  const dp = new Array<number>((n + 1) * (m + 1)).fill(Infinity);
  const at = (i: number, j: number): number => i * (m + 1) + j;
  dp[at(0, 0)] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const c = dp[at(i, j)] as number;
      if (!Number.isFinite(c)) continue;
      if (i < n && j < m) {
        dp[at(i + 1, j + 1)] = Math.min(dp[at(i + 1, j + 1)] as number, c + Math.abs((prev[i] as number) - (next[j] as number)));
      }
      if (i < n) dp[at(i + 1, j)] = Math.min(dp[at(i + 1, j)] as number, c + SKIP_COST);
      if (j < m) dp[at(i, j + 1)] = Math.min(dp[at(i, j + 1)] as number, c + SKIP_COST);
    }
  }
  return dp[at(n, m)] as number;
}

export const DEFAULT_REGISTER: Register = { lo: 45, hi: 76, span: 19, center: 58 };

/** The voicing of `pcs` that moves least from `prev`, inside a register.
 *  Deterministic: ties break on the search order, which is fixed. */
export function voiceLead(
  prev: readonly number[],
  pcs: readonly number[],
  register: Partial<Register> = {},
): number[] {
  const { lo, hi, span, center } = { ...DEFAULT_REGISTER, ...register };
  const unique = [...new Set(pcs.map((pc) => ((pc % 12) + 12) % 12))];
  const cands = unique.map((pc) => {
    const out: number[] = [];
    for (let m = lo; m <= hi; m++) if (m % 12 === pc) out.push(m);
    return out;
  });
  if (cands.some((c) => c.length === 0)) return [...prev];

  let best: number[] | null = null;
  let bestCost = Infinity;
  const acc = new Array<number>(unique.length);
  const walk = (i: number): void => {
    if (i === cands.length) {
      const sorted = [...acc].sort((a, b) => a - b);
      const width = (sorted[sorted.length - 1] as number) - (sorted[0] as number);
      if (width > span) return;
      let cost = prev.length ? matchCost(prev, sorted) : 0;
      let sum = 0;
      for (const n of sorted) sum += n;
      const centroid = sum / sorted.length;
      cost += Math.max(0, width - 12) * 0.15; // keep the voicing tight
      cost += Math.abs(centroid - center) * 0.12; // and near the middle register
      if (cost < bestCost - 1e-9) {
        bestCost = cost;
        best = sorted;
      }
      return;
    }
    for (const m of cands[i] as number[]) {
      acc[i] = m;
      walk(i + 1);
    }
  };
  walk(0);
  return best ?? [...prev];
}

/** A voicing in a wider register for drones and low pedal tones. */
export const DRONE_REGISTER: Register = { lo: 24, hi: 52, span: 24, center: 36 };

const MOVE_WEIGHTS: Record<number, number> = { 0: 0.2, 1: 1.8, 2: 1.4, 3: 1.6, 4: 1.7, 5: 0.9, 6: 0.8 };

/** The next scale degree: mostly steps and fourths, never a hard cadence.
 *  Ambient music wants no dominant, so V–I is just another move here. */
export function nextDegree(rng: Rng, prevDegree: number, { allowRepeat = false } = {}): number {
  const options: { move: number; cumulative: number }[] = [];
  let total = 0;
  for (let move = 0; move <= 6; move++) {
    if (move === 0 && !allowRepeat) continue;
    const weight = MOVE_WEIGHTS[move] ?? 0.5;
    total += weight;
    options.push({ move, cumulative: total });
  }
  const r = rng.float() * total;
  let move = 0;
  for (const o of options) {
    if (r <= o.cumulative) {
      move = o.move;
      break;
    }
    move = o.move;
  }
  if (move === 0) return ((prevDegree % 7) + 7) % 7;
  const down = rng.float() < 0.55; // a calm piece falls more often than it rises
  return (((prevDegree + (down ? -move : move)) % 7) + 7) % 7;
}

/** Shape weights per flavour: open voicings dominate, richer ones appear as the
 *  piece opens up. */
export function shapeWeights(flavour: string): Partial<Record<ShapeName, number>> {
  switch (flavour) {
    case 'dark':
    case 'unstable':
      return { sus2: 2.6, sus4: 2.4, quartal: 1.8, add9: 1.2, triad: 1.0, seventh: 1.0, ninth: 0.5, eleventh: 0.3, sixth: 0.3 };
    case 'shimmering':
      return { sus2: 1.6, sus4: 1.4, add9: 2.2, ninth: 1.8, eleventh: 1.2, seventh: 1.2, triad: 0.9, sixth: 0.8, quartal: 1.1 };
    case 'wistful':
    case 'melancholy':
      return { sus2: 2.0, sus4: 1.8, add9: 1.6, seventh: 1.7, ninth: 1.3, eleventh: 0.8, triad: 1.0, sixth: 0.5, quartal: 1.0 };
    default:
      return { sus2: 1.6, sus4: 1.4, add9: 1.8, seventh: 1.4, ninth: 1.6, eleventh: 0.9, triad: 1.1, sixth: 0.9, quartal: 1.0 };
  }
}

export function pickShape(
  rng: Rng,
  flavour: string,
  weights: Partial<Record<ShapeName, number>> = shapeWeights(flavour),
): ShapeName {
  let total = 0;
  for (const name of SHAPE_NAMES) total += weights[name] ?? 0;
  let r = rng.float() * total;
  for (const name of SHAPE_NAMES) {
    r -= weights[name] ?? 0;
    if (r <= 0) return name;
  }
  return 'sus2';
}

const MODULATION_STEPS = [5, 7, 2, -3, 3, -5, 10, -2];

/** A new key at a section boundary: usually a fourth or fifth away, sometimes
 *  a fresh mode over the same root. */
export function modulate(rng: Rng, { rootPc, modeName }: Key): Key {
  if (rng.chance(0.28)) {
    const others = MODE_NAMES.filter((m) => m !== modeName);
    return { rootPc, modeName: rng.pick(others) };
  }
  const step_ = rng.pick(MODULATION_STEPS);
  return {
    rootPc: (((rootPc + step_) % 12) + 12) % 12,
    modeName: rng.chance(0.35) ? rng.pick(MODE_NAMES) : modeName,
  };
}

export function keyName({ rootPc, modeName }: Key): string {
  return `${pcName(rootPc, modeName)} ${modeName}`;
}
