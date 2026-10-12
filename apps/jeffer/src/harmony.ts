// Modes, degrees and the chords they make. Pure, seeded, and the only place in
// the app that decides what a note is (spec §2).
//
// Electro is not a harmonic genre, which is exactly why this is short: a bass
// line that moves every eight bars over a flat minor, and not much else. The
// temptation with a mode system is to reach for more; the measured reference
// sits in one minor for four minutes, and the set is better for it.

import { Rng } from './rng.ts';
import type { Chord, ChordName, Key, KeyName, ModeName } from './types.ts';

/** The modes the set draws from, and their semitone sets. Electro lives in the
 *  flat end: the reference is Aeolian, and Dorian and Phrygian are its two
 *  neighbours. Mixolydian is here because a bright one in a dark record reads
 *  as a lift rather than as a different song. */
export const MODES: Record<ModeName, { steps: number[]; label: string }> = {
  aeolian: { steps: [0, 2, 3, 5, 7, 8, 10], label: 'aeolian' },
  dorian: { steps: [0, 2, 3, 5, 7, 9, 10], label: 'dorian' },
  phrygian: { steps: [0, 1, 3, 5, 7, 8, 10], label: 'phrygian' },
  mixolydian: { steps: [0, 2, 4, 5, 7, 9, 10], label: 'mixolydian' },
};

/** Weights, not a uniform pick: the reference's root is minor, and a set that
 *  wanders into Phrygian as often as Aeolian does not sound like one record. */
const MODE_WEIGHTS: ModeName[] = [
  'aeolian', 'aeolian', 'aeolian', 'aeolian',
  'dorian', 'dorian',
  'phrygian',
  'mixolydian',
];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** The key a seed plays in. */
export function pickKey(rng: Rng): Key {
  const rootPc = rng.int(12);
  const modeName = rng.pick(MODE_WEIGHTS);
  return {
    rootPc,
    modeName,
    name: `${NOTE_NAMES[rootPc]} ${MODES[modeName].label}` as KeyName,
  };
}

/** The degree above the root for a chord on `degree`, 0..6. */
export function degreeStep(modeName: ModeName, degree: number): number {
  const steps = MODES[modeName].steps;
  return steps[((degree % 7) + 7) % 7] as number;
}

/**
 * The next degree, as a *move* rather than a destination: a bass line steps to
 * a neighbour far more often than it leaps, and a line that only leaps sounds
 * like a chord sequence rather than a bass.
 */
export function nextDegree(rng: Rng, from: number): number {
  const roll = rng.float();
  if (roll < 0.34) return (from + 1) % 7;
  if (roll < 0.62) return (from + 6) % 7;
  if (roll < 0.82) return (from + 2) % 7;
  if (roll < 0.93) return (from + 5) % 7;
  return (from + 3 + rng.int(2)) % 7;
}

/** Chord qualities by scale degree, as semitone sets above the chord root. */
const QUALITIES: number[][][] = [
  // aeolian
  [[0, 3, 7], [2, 5, 8], [3, 7, 10], [5, 8, 12], [7, 10, 14], [8, 12, 15], [10, 14, 17]],
  // dorian
  [[0, 3, 7], [2, 5, 9], [3, 7, 10], [5, 9, 12], [7, 10, 14], [9, 12, 16], [10, 14, 17]],
  // phrygian
  [[0, 3, 7], [1, 4, 8], [3, 6, 10], [5, 8, 12], [7, 10, 14], [8, 11, 15], [10, 14, 17]],
  // mixolydian
  [[0, 4, 7], [2, 5, 9], [4, 7, 11], [5, 9, 12], [7, 11, 14], [9, 12, 16], [10, 14, 17]],
];

const MODE_ORDER: ModeName[] = ['aeolian', 'dorian', 'phrygian', 'mixolydian'];

/** The chord on `degree` of `key`. */
export function buildChord({ rootPc, modeName, degree }: { rootPc: number; modeName: ModeName; degree: number }): Chord {
  const d = ((degree % 7) + 7) % 7;
  const chordRoot = (rootPc + degreeStep(modeName, d)) % 12;
  const quality = (QUALITIES[MODE_ORDER.indexOf(modeName)] ?? QUALITIES[0]) as number[][];
  const intervals = quality[d] as number[];
  const pcs = intervals.map((i) => (chordRoot + i) % 12);
  return {
    name: chordName(chordRoot, intervals),
    degree: d,
    pcs,
    bassPc: chordRoot,
    quality: intervals,
  };
}

/** `F#m`, `C`, `G# VII` — the degree in roman where it says something. */
function chordName(root: number, intervals: number[]): ChordName {
  const base = NOTE_NAMES[root] as string;
  const third = (intervals[1] ?? 4) % 12;
  const quality = third === 3 ? 'm' : third === 4 ? '' : '°';
  return `${base}${quality}` as ChordName;
}

/** A pitch name, for the HUD. */
export function keyLabel(key: Key): KeyName {
  return key.name;
}

/** MIDI note number to frequency, A4 = 69 = 440 Hz. */
export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** The bass note a chord plays, in the register the bass voice wants. */
export function bassNote(rootPc: number, octave: number): number {
  return 12 * (octave + 1) + rootPc;
}

/**
 * Spread `count` notes from a chord's pitch classes into one octave, starting at
 * `root` and wrapping, so a stab has a shape rather than a cluster.
 */
export function placeNotes(pcs: readonly number[], root: number, count: number): number[] {
  const notes: number[] = [];
  const degrees = pcs.length > 0 ? pcs : [0];
  for (let i = 0; i < count; i++) {
    const pc = degrees[i % degrees.length] as number;
    const octave = Math.floor(i / degrees.length);
    notes.push(root + ((pc - root) % 12 + 12) % 12 + octave * 12);
  }
  return notes;
}
