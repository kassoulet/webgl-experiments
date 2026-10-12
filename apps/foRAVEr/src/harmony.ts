// Harmony for a minor-key set: modes, the degrees a techno bass line walks,
// and the registers each synth voice plays in. Pure, seeded, no DOM.
//
// Techno harmony is not Singularity's: it moves slowly and it moves *low*. A
// chord here is a bass root plus a couple of upper notes that a stab can hit,
// and a change of chord happens every eight bars or so — the drama is in the
// drums and the filter, not in the notes.

import { Rng } from '@fractal-rave/shared';
import type { Chord, Key, Mode, Seed } from './types.ts';

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const NOTE_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

/**
 * Modes a set can be in. All of them work over a four-on-the-floor kick; the
 * darker ones (phrygian, harmonic minor) are chosen more often, which is what
 * a seeded key roll has to express if the music should lean that way.
 */
export const MODES: Record<string, Mode> = {
  aeolian: { name: 'aeolian', intervals: [0, 2, 3, 5, 7, 8, 10], flavour: 'dark' },
  phrygian: { name: 'phrygian', intervals: [0, 1, 3, 5, 7, 8, 10], flavour: 'spanish' },
  dorian: { name: 'dorian', intervals: [0, 2, 3, 5, 7, 9, 10], flavour: 'funk' },
  harmonicMinor: { name: 'harmonicMinor', intervals: [0, 2, 3, 5, 7, 8, 11], flavour: 'tense' },
  mixolydian: { name: 'mixolydian', intervals: [0, 2, 4, 5, 7, 9, 10], flavour: 'bright' },
};

export const MODE_NAMES = Object.keys(MODES);

/** How likely each mode is to be rolled, so darker modes dominate. */
const MODE_WEIGHTS: Record<string, number> = {
  aeolian: 4,
  phrygian: 3,
  dorian: 2,
  harmonicMinor: 2,
  mixolydian: 1,
};

/** Roman-numeral labels for the seven degrees, minor-key convention. */
const DEGREE_NAMES = ['i', 'ii', 'III', 'iv', 'v', 'VI', 'VII'];

export function spellsFlat(modeName: string): boolean {
  return modeName === 'phrygian' || modeName === 'harmonicMinor';
}

export function modeByName(modeName: string): Mode {
  return MODES[modeName] ?? (MODES.aeolian as Mode);
}

export function modeName(key: Key): string {
  const flats = spellsFlat(key.modeName);
  return (flats ? NOTE_NAMES_FLAT : NOTE_NAMES)[key.rootPc % 12] as string;
}

export function keyLabel(key: Key): string {
  return `${modeName(key)} ${key.modeName}`;
}

/** MIDI note number → frequency in Hz (A4 = 69 = 440 Hz). */
export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Pick a key for the set. Weighted, so the same seed tends toward the darker
 * modes but still reaches the bright one now and then.
 */
export function pickKey(rng: Rng): Key {
  const total = MODE_NAMES.reduce((sum, name) => sum + (MODE_WEIGHTS[name] ?? 1), 0);
  let roll = rng.float() * total;
  let modeName = MODE_NAMES[0] as string;
  for (const name of MODE_NAMES) {
    roll -= MODE_WEIGHTS[name] ?? 1;
    if (roll <= 0) {
      modeName = name;
      break;
    }
  }
  return { rootPc: rng.int(12), modeName };
}

/**
 * The chord on `degree` of the mode: a triad with an added seventh when the
 * mode has one under that root. Techno chords are triads and sevenths; there is
 * no room in a four-on-the-floor mix for anything wider.
 */
export function buildChord({ rootPc, modeName: mode, degree }: { rootPc: number; modeName: string; degree: number }): Chord {
  const scale = modeByName(mode).intervals;
  const at = (step: number): number => (rootPc + (scale[((degree + step) % scale.length + scale.length) % scale.length] as number)) % 12;
  const d = ((degree % scale.length) + scale.length) % scale.length;
  const root = at(0);
  // Third, fifth, and the seventh when the scale carries one a seventh above.
  const pcs = [root, at(2), at(4)];
  const seventh = at(6);
  if (seventh !== root) pcs.push(seventh);
  return { degree: d, rootPc: root, modeName: mode, pcs, name: chordName(root, d, mode) };
}

export function chordName(rootPc: number, degree: number, mode: string): string {
  const flats = spellsFlat(mode);
  const letter = (flats ? NOTE_NAMES_FLAT : NOTE_NAMES)[rootPc % 12] as string;
  return `${letter} ${DEGREE_NAMES[degree % 7] as string}`;
}

/**
 * The next degree. Techno steps by small intervals far more often than it
 * leaps: a root moving by a fourth or a fifth is a bass line, a root moving by
 * a tritone is a mistake.
 */
export function nextDegree(rng: Rng, previous: number): number {
  const roll = rng.float();
  if (roll < 0.42) return (previous + (rng.chance(0.5) ? 1 : -1) + 7) % 7;
  if (roll < 0.72) return (previous + (rng.chance(0.5) ? 2 : -2) + 7) % 7;
  if (roll < 0.9) return (previous + (rng.chance(0.5) ? 3 : -3) + 7) % 7;
  return (previous + 4) % 7; // the subdominant, the one big move
}

/**
 * Put a chord's pitch classes into a register, keeping them close together so
 * the result is a playable voicing rather than an arithmetic accident.
 *
 * `spread` widens the gap between the notes: the pad wants it wide, the stabs
 * want it tight, and the bass wants no spread at all (it is the root).
 */
export function placeNotes(pcs: number[], center: number, spreadSemitones: number): number[] {
  const notes = pcs
    .map((pc) => {
      let note = pc;
      while (note < center - 6) note += 12;
      while (note > center + 5) note -= 12;
      return note;
    })
    .sort((a, b) => a - b);
  // `spreadSemitones` lifts alternate notes up by that many semitones, which is
  // how a pad voicing opens out without leaving the key. Zero keeps them tight,
  // which is what a stab wants.
  const lift = Math.round(spreadSemitones);
  for (let i = 1; i < notes.length; i += 2) notes[i] = (notes[i] as number) + lift;
  return notes;
}

/** The root, in the register a sub-bass line lives in (E1..G2). */
export function bassNote(rootPc: number, octaveShift = 0): number {
  return 28 + ((rootPc + octaveShift * 12) % 12);
}

/** Everything the engine needs to know about the piece's key, from its seed. */
export function keyFromSeed(seed: Seed): Key {
  return pickKey(new Rng(seed).fork('key'));
}
