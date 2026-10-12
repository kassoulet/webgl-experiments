// Harmony for synth-pop: brighter modes, major leanings, lush pads.

import { Rng } from '@fractal-rave/shared';
import type { Chord, Key, Mode, Seed } from './types.ts';

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const NOTE_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

export const MODES: Record<string, Mode> = {
  ionian: { name: 'ionian', intervals: [0, 2, 4, 5, 7, 9, 11], flavour: 'bright' },
  lydian: { name: 'lydian', intervals: [0, 2, 4, 6, 7, 9, 11], flavour: 'dreamy' },
  mixolydian: { name: 'mixolydian', intervals: [0, 2, 4, 5, 7, 9, 10], flavour: 'groovy' },
  aeolian: { name: 'aeolian', intervals: [0, 2, 3, 5, 7, 8, 10], flavour: 'melancholy' },
  dorian: { name: 'dorian', intervals: [0, 2, 3, 5, 7, 9, 10], flavour: 'wistful' },
};

export const MODE_NAMES = Object.keys(MODES);

const MODE_WEIGHTS: Record<string, number> = {
  ionian: 3,
  lydian: 3,
  mixolydian: 2,
  aeolian: 1,
  dorian: 1,
};

const DEGREE_NAMES = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'];

export function spellsFlat(modeName: string): boolean {
  return modeName === 'aeolian' || modeName === 'dorian';
}

export function modeByName(modeName: string): Mode {
  return MODES[modeName] ?? (MODES.ionian as Mode);
}

export function modeName(key: Key): string {
  const flats = spellsFlat(key.modeName);
  return (flats ? NOTE_NAMES_FLAT : NOTE_NAMES)[key.rootPc % 12] as string;
}

export function keyLabel(key: Key): string {
  return `${modeName(key)} ${key.modeName}`;
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

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

export function buildChord({ rootPc, modeName: mode, degree }: { rootPc: number; modeName: string; degree: number }): Chord {
  const scale = modeByName(mode).intervals;
  const at = (step: number): number => (rootPc + (scale[((degree + step) % scale.length + scale.length) % scale.length] as number)) % 12;
  const d = ((degree % scale.length) + scale.length) % scale.length;
  const root = at(0);
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

export function nextDegree(rng: Rng, previous: number): number {
  const roll = rng.float();
  const up = rng.chance(0.5);
  const span = roll < 0.35 ? 1 : roll < 0.65 ? 2 : roll < 0.85 ? 3 : roll < 0.95 ? 4 : 5;
  // Clamped, not wrapped: a "leap" from degree 6 back to 0 is not a fourth, it
  // is a wrong chord. And the line always moves — pinned at an edge, it turns
  // around and steps back inside rather than repeating the same chord.
  let next = Math.min(6, Math.max(0, previous + (up ? span : -span)));
  if (next === previous) next = previous + (up ? -1 : 1);
  return next;
}

export function placeNotes(pcs: number[], center: number, spreadSemitones: number): number[] {
  const notes = pcs
    .map((pc) => {
      let note = pc;
      while (note < center - 6) note += 12;
      while (note > center + 5) note -= 12;
      return note;
    })
    .sort((a, b) => a - b);
  const lift = Math.round(spreadSemitones);
  for (let i = 1; i < notes.length; i += 2) notes[i] = (notes[i] as number) + lift;
  return notes;
}

export function bassNote(rootPc: number, octaveShift = 0): number {
  // 32..43 for the twelve pitch classes, one octave per shift — the shift must
  // survive the reduction, so it is applied after the pitch class is found.
  return 32 + ((rootPc % 12) + 12) % 12 + octaveShift * 12;
}

export function keyFromSeed(seed: Seed): Key {
  return pickKey(new Rng(seed).fork('key'));
}