// Harmony: the key a set is in, the chords it moves through, and the bass that
// walks them.
//
// Electro is not a scale and it is not a chord progression either — it is a bass
// line that keeps landing on the same two or three notes. So the claims here are
// about *steps* rather than leaps, and about the chord tones being the ones the
// mode says they are.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MODES,
  bassNote,
  buildChord,
  degreeStep,
  keyLabel,
  midiToHz,
  nextDegree,
  pickKey,
  placeNotes,
} from '../src/harmony.ts';
import { Rng } from '../src/rng.ts';
import type { ModeName } from '../src/types.ts';

const MODES_NAMES = Object.keys(MODES) as ModeName[];

test('a key is a root and a mode, and its name says both', () => {
  const key = pickKey(new Rng('smoke-test'));
  assert.ok(key.rootPc >= 0 && key.rootPc < 12, `root ${key.rootPc}`);
  assert.ok(MODES_NAMES.includes(key.modeName));
  assert.equal(key.name, keyLabel(key));
  assert.match(key.name, /^[A-G]#? [a-z]+$/);
  // Two seeds do not always share a key, and the same seed always does.
  assert.deepEqual(pickKey(new Rng('a')), pickKey(new Rng('a')));
});

test('every mode has seven steps, all inside an octave, and no repeats', () => {
  for (const name of MODES_NAMES) {
    const { steps, label } = MODES[name];
    assert.equal(steps.length, 7, `${name} has ${steps.length} steps`);
    assert.ok(label.length > 0);
    const sorted = [...steps].sort((x, y) => x - y);
    assert.deepEqual(sorted, steps, `${name}'s steps are not in order`);
    for (const step of steps) {
      assert.ok(Number.isInteger(step) && step >= 0 && step <= 11, `${name} has a step at ${step}`);
    }
    assert.equal(new Set(steps).size, 7, `${name} repeats a semitone`);
    assert.equal(steps[0], 0, `${name} does not start on the root`);
  }
});

test('a degree is looked up by pitch class, and wraps', () => {
  for (const name of MODES_NAMES) {
    for (let degree = 0; degree < 7; degree++) {
      const step = degreeStep(name, degree);
      assert.ok(step >= 0 && step <= 11);
      assert.equal(degreeStep(name, degree + 7), step, `${name} degree ${degree} does not wrap`);
      assert.equal(degreeStep(name, degree - 7), step, `${name} degree ${degree} does not wrap backwards`);
    }
  }
});

test('a chord is the mode’s triad on that degree', () => {
  for (const name of MODES_NAMES) {
    const rootPc = 4;
    for (let degree = 0; degree < 7; degree++) {
      const chord = buildChord({ rootPc, modeName: name, degree });
      const root = (rootPc + degreeStep(name, degree)) % 12;
      assert.equal(chord.bassPc, root, `${name} degree ${degree} has the wrong bass`);
      assert.equal(chord.degree, degree);
      assert.equal(chord.pcs.length, 3, `${name} degree ${degree} is not a triad`);
      for (let i = 0; i < 3; i++) {
        assert.equal(chord.pcs[i], (chord.bassPc + (chord.quality[i] as number)) % 12);
      }
      // Stacked thirds, or the closest thing this mode has to one: the intervals
      // have to climb, and a triad whose top note is below its middle note is a
      // chord spelled the wrong way round.
      assert.ok((chord.quality[0] as number) < (chord.quality[1] as number), `${name} degree ${degree}`);
      assert.ok((chord.quality[1] as number) < (chord.quality[2] as number), `${name} degree ${degree}`);
      // A diminished fifth is the seventh degree of the modes that have one,
      // and it is named with the degree sign rather than called a minor chord.
      if (name === 'aeolian' && degree === 6) {
        assert.deepEqual(chord.quality, [10, 14, 17], 'aeolian’s seventh degree is not the subtonic triad');
      }
      if (name === 'aeolian' && degree === 0) {
        assert.deepEqual(chord.quality, [0, 3, 7], 'aeolian’s first degree is not a minor triad');
      }
    }
  }
});

test('the same chord twice is the same chord, and a degree out of range wraps', () => {
  const once = buildChord({ rootPc: 9, modeName: 'dorian', degree: 3 });
  const again = buildChord({ rootPc: 9, modeName: 'dorian', degree: 3 });
  assert.deepEqual(once, again);
  assert.deepEqual(buildChord({ rootPc: 9, modeName: 'dorian', degree: 10 }), once);
  assert.deepEqual(buildChord({ rootPc: 9, modeName: 'dorian', degree: -4 }), once);
});

test('a bass line mostly steps, and never leaves the scale', () => {
  // The claim the arrangement rests on: a bass that only leaps sounds like a
  // chord sequence rather than a bass. Over a long walk, steps must dominate —
  // and every destination has to be a degree of the key.
  const rng = new Rng('bass');
  let degree = 0;
  const moves: number[] = [];
  for (let i = 0; i < 4000; i++) {
    const to = nextDegree(rng, degree);
    assert.ok(Number.isInteger(to) && to >= 0 && to < 7, `degree ${to} is not in the key`);
    moves.push(Math.min(Math.abs(to - degree), 7 - Math.abs(to - degree)));
    degree = to;
  }
  const steps = moves.filter((m) => m === 1).length;
  const leaps = moves.filter((m) => m >= 3).length;
  assert.ok(steps / moves.length > 0.6, `only ${steps}/${moves.length} bass moves were steps`);
  assert.ok(leaps / moves.length < 0.2, `${leaps}/${moves.length} bass moves were leaps`);
  // And the line visits the whole key, or it is stuck on one note.
  assert.equal(new Set(moves).size >= 3, true);
});

test('notes are placed in order, one octave apart, from a chord', () => {
  const chord = buildChord({ rootPc: 2, modeName: 'mixolydian', degree: 0 });
  const notes = placeNotes(chord.pcs, 48, 7);
  assert.equal(notes.length, 7);
  for (let i = 1; i < notes.length; i++) {
    assert.ok((notes[i] as number) > (notes[i - 1] as number), `note ${i} is not above note ${i - 1}`);
  }
  // Every note is one of the chord's own pitch classes, and a seven-note stab
  // climbs two octaves from its root rather than running off the top of one.
  const octaves = Math.ceil(7 / chord.pcs.length);
  for (const note of notes) {
    assert.ok(chord.pcs.includes(((note as number) % 12 + 12) % 12), `${note} is not a chord tone`);
    assert.ok((note as number) >= 48 && (note as number) < 48 + 11 + octaves * 12, `${note} is outside the stab's range`);
  }
  // An empty chord still places something, rather than returning nothing and
  // leaving a stab silent: with no pitch classes to walk it climbs in octaves.
  assert.deepEqual(placeNotes([], 48, 3), [48, 60, 72]);
  assert.deepEqual(placeNotes(chord.pcs, 48, 0), []);
});

test('pitch and register are where the equal-tempered scale says they are', () => {
  assert.equal(midiToHz(69), 440);
  assert.ok(Math.abs(midiToHz(81) - 880) < 1e-9, 'an octave up is not an octave up');
  assert.ok(Math.abs(midiToHz(57) - 220) < 1e-9, 'an octave down is not an octave down');
  // A semitone is 2^(1/12), and the bass register this app plays in is low
  // enough that a mistake here is audible rather than academic.
  assert.ok(Math.abs(midiToHz(60) / midiToHz(59) - Math.pow(2, 1 / 12)) < 1e-9);
  for (let octave = 1; octave <= 3; octave++) {
    const note = bassNote(0, octave);
    assert.equal(note % 12, 0, `bassNote(0, ${octave}) is not a C`);
    assert.ok(midiToHz(note) >= 30 && midiToHz(note) <= 300, `C${octave} is out of the bass register`);
  }
});
