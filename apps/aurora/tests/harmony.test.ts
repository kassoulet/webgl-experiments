import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MODES,
  buildChord,
  chordName,
  keyFromSeed,
  keyLabel,
  midiToHz,
  nextDegree,
  pickKey,
  placeNotes,
  bassNote,
  spellsFlat,
} from '../src/harmony.ts';
import { Rng } from '@fractal-rave/shared';

test('the modes are the five synth-pop flavours, with seven notes each', () => {
  const names = Object.keys(MODES);
  assert.deepEqual(names.sort(), ['aeolian', 'dorian', 'ionian', 'lydian', 'mixolydian']);
  for (const mode of Object.values(MODES)) {
    assert.equal(mode.intervals.length, 7, `${mode.name} is not heptatonic`);
    assert.equal(new Set(mode.intervals).size, 7, `${mode.name} repeats a degree`);
  }
});

test('keys spell flats where they should, and never elsewhere', () => {
  assert.ok(spellsFlat('aeolian'));
  assert.ok(spellsFlat('dorian'));
  for (const mode of ['ionian', 'lydian', 'mixolydian']) {
    assert.ok(!spellsFlat(mode));
  }
});

test('pickKey is weighted towards the bright modes', () => {
  // Synth-pop leans major: over many draws, ionian+lydian must outdraw
  // aeolian+dorian clearly.
  let bright = 0;
  let dark = 0;
  const rng = new Rng('mode-weights');
  for (let i = 0; i < 4000; i++) {
    const key = pickKey(rng);
    if (key.modeName === 'ionian' || key.modeName === 'lydian') bright++;
    if (key.modeName === 'aeolian' || key.modeName === 'dorian') dark++;
  }
  assert.ok(bright > dark * 2, `bright ${bright} vs dark ${dark} — the weighting is not in`);
});

test('buildChord spells triads in the scale, with a seventh when it differs', () => {
  const ionian = buildChord({ rootPc: 0, modeName: 'ionian', degree: 0 });
  assert.equal(ionian.rootPc, 0);
  assert.deepEqual(ionian.pcs.slice(0, 3), [0, 4, 7]); // C major
  // The supertonic of C ionian is D minor: 2, 5, 9 mod 12 -> 2, 5, 9.
  const supertonic = buildChord({ rootPc: 0, modeName: 'ionian', degree: 1 });
  assert.deepEqual(supertonic.pcs.slice(0, 3), [2, 5, 9]);
  // Every chord tone is a scale tone.
  const scale = MODES.ionian!.intervals;
  for (const pc of supertonic.pcs) {
    assert.ok(scale.includes(((pc - 0) % 12 + 12) % 12) || scale.includes(pc), `${pc} is not in the scale`);
  }
});

test('chords are named for humans', () => {
  assert.equal(chordName(0, 0, 'ionian'), 'C I');
  assert.equal(chordName(9, 5, 'ionian'), 'A vi');
  assert.equal(chordName(2, 1, 'aeolian'), 'D ii'); // aeolian spells flats: D, not D#
  // Quality labels follow the ionian template (the sibling apps' convention);
  // the mode chooses the spelling of the letter, not the case of the numeral.
  assert.match(chordName(4, 4, 'aeolian'), /^[A-G]b? V$/);
});

test('keyLabel reads as "note mode"', () => {
  const key = keyFromSeed('borealis-dawn-9f3c');
  assert.match(keyLabel(key), /^[A-G][#b]? (ionian|lydian|mixolydian|aeolian|dorian)$/);
});

test('nextDegree moves by a step, a third or a fourth, and stays in the scale', () => {
  const rng = new Rng('degrees');
  for (let previous = 0; previous < 7; previous++) {
    for (let i = 0; i < 200; i++) {
      const next = nextDegree(rng, previous);
      assert.ok(next >= 0 && next < 7, `nextDegree left the scale: ${next}`);
      const step = Math.abs(next - previous);
      assert.ok([1, 2, 3, 4, 5].includes(step), `an implausible leap: ${previous} -> ${next}`);
    }
  }
});

test('placeNotes keeps a voicing inside its register', () => {
  const pcs = [0, 4, 7, 11];
  const stabs = placeNotes(pcs, 64, 2); // around middle C
  for (const note of stabs) {
    assert.ok(note >= 58 && note <= 74, `a stab at ${note} is outside the register`);
  }
  const pads = placeNotes(pcs, 52, 16);
  for (const note of pads) {
    assert.ok(note >= 46 && note <= 76, `a pad note at ${note} is outside the register`);
  }
  assert.ok(stabs.length >= pcs.length, 'the voicing lost notes');
});

test('bassNote sits at the bottom of the range, octave-shifted by twelves', () => {
  for (let pc = 0; pc < 12; pc++) {
    const low = bassNote(pc, 0);
    const high = bassNote(pc, 1);
    assert.ok(low >= 32 && low < 44, `bass ${low} out of range`);
    assert.equal(high - low, 12);
  }
  assert.ok(midiToHz(bassNote(0)) > 40 && midiToHz(bassNote(0)) < 100, 'the bass is not audible');
});
