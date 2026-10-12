import test from 'node:test';
import assert from 'node:assert/strict';

import { Rng } from '../src/rng.ts';
import {
  MODES,
  MODE_NAMES,
  buildChord,
  midiToHz,
  modulate,
  nextDegree,
  pickShape,
  scalePitchClasses,
  voiceLead,
  DEFAULT_REGISTER,
  DRONE_REGISTER,
} from '../src/harmony.ts';

const pcSet = (a: number[]): number[] => [...new Set(a)].sort((x, y) => x - y);

test('modes are the scales they claim to be', () => {
  assert.deepEqual(scalePitchClasses(0, 'aeolian'), [0, 2, 3, 5, 7, 8, 10]);
  assert.deepEqual(scalePitchClasses(0, 'dorian'), [0, 2, 3, 5, 7, 9, 10]);
  assert.deepEqual(scalePitchClasses(0, 'lydian'), [0, 2, 4, 6, 7, 9, 11]);
  assert.deepEqual(scalePitchClasses(9, 'aeolian'), [9, 11, 0, 2, 4, 5, 7]);
});

test('diatonic chords come out with the right thirds and fifths', () => {
  // C aeolian: i, ii°, III, iv, v, VI, VII.
  const expected = ['Cm', 'Ddim', 'Eb', 'Fm', 'Gm', 'Ab', 'Bb'];
  for (let degree = 0; degree < 7; degree++) {
    const chord = buildChord({ rootPc: 0, modeName: 'aeolian', degree, shape: 'triad' });
    assert.equal(chord.name, expected[degree], `degree ${degree}`);
  }
});

test('sevenths and ninths are named for what they are', () => {
  const c7 = buildChord({ rootPc: 0, modeName: 'aeolian', degree: 0, shape: 'seventh' });
  assert.equal(c7.name, 'Cm7');
  const g7 = buildChord({ rootPc: 0, modeName: 'aeolian', degree: 4, shape: 'seventh' });
  assert.equal(g7.name, 'Gm7');
  // Gm7 in C aeolian: G, Bb, D, F.
  assert.deepEqual([...new Set(g7.pcs)].sort((a, b) => a - b), [2, 5, 7, 10]);
  const ionian = buildChord({ rootPc: 0, modeName: 'ionian', degree: 0, shape: 'ninth' });
  assert.equal(ionian.name, 'Cmaj9');
  const d9 = buildChord({ rootPc: 0, modeName: 'ionian', degree: 1, shape: 'ninth' });
  assert.equal(d9.name, 'Dm9');
});

test('suspended and added shapes drop or add the right notes', () => {
  const sus2 = buildChord({ rootPc: 0, modeName: 'aeolian', degree: 0, shape: 'sus2' });
  assert.equal(sus2.name, 'Csus2');
  assert.equal(sus2.pcs.length, 3);
  assert.deepEqual(pcSet(sus2.pcs), pcSet([0, 2, 7]));
  const sus4 = buildChord({ rootPc: 0, modeName: 'aeolian', degree: 0, shape: 'sus4' });
  assert.deepEqual(pcSet(sus4.pcs), pcSet([0, 5, 7]));
  const add9 = buildChord({ rootPc: 0, modeName: 'aeolian', degree: 0, shape: 'add9' });
  assert.deepEqual(pcSet(add9.pcs), pcSet([0, 3, 7, 2]));
});

test('every chord stays inside the key', () => {
  for (const modeName of MODE_NAMES) {
    const scale = new Set(scalePitchClasses(3, modeName));
    for (let degree = 0; degree < 7; degree++) {
      for (const shape of ['sus2', 'sus4', 'triad', 'seventh', 'ninth', 'add9', 'sixth', 'quartal', 'eleventh'] as const) {
        const chord = buildChord({ rootPc: 3, modeName, degree, shape });
        assert.ok(chord.pcs.length >= 3, `${modeName} ${degree} ${shape}`);
        for (const pc of chord.pcs) {
          assert.ok(scale.has(pc), `${modeName} degree ${degree} shape ${shape}: pc ${pc} is outside the key`);
        }
      }
    }
  }
});

test('voice leading keeps common tones and moves the rest as little as possible', () => {
  const c = [48, 51, 55]; // Cm
  const eb = buildChord({ rootPc: 0, modeName: 'aeolian', degree: 2, shape: 'triad' }).pcs; // Eb
  const voiced = voiceLead(c, eb);
  assert.ok(voiced.length >= 3);
  // Eb and Bb share the fifth and the minor third: they should stay put.
  const common = c.filter((m) => voiced.includes(m));
  assert.ok(common.length >= 2, `expected mostly common tones, got ${voiced} from ${c}`);
  for (const m of voiced) {
    assert.ok(DEFAULT_REGISTER.lo <= m && m <= DEFAULT_REGISTER.hi);
  }
});

test('voice leading stays in a tight register and drifts no further over a progression', () => {
  const rng = new Rng('progression');
  let voicing: number[] = [];
  let worstMove = 0;
  let totalMove = 0;
  let steps = 0;
  let degree = 0;
  for (let i = 0; i < 60; i++) {
    degree = nextDegree(rng, degree);
    const chord = buildChord({ rootPc: 5, modeName: 'dorian', degree, shape: pickShape(rng, 'wistful') });
    const next = voiceLead(voicing, chord.pcs);
    if (voicing.length === next.length) {
      for (let v = 0; v < next.length; v++) {
        const move = Math.abs(next[v] - voicing[v]);
        worstMove = Math.max(worstMove, move);
        totalMove += move;
        steps++;
      }
      const width = next[next.length - 1] - next[0];
      assert.ok(width <= DEFAULT_REGISTER.span, `voicing spread ${width}`);
    }
    voicing = next;
  }
  assert.ok(worstMove <= 9, `a voice jumped ${worstMove} semitones`);
  assert.ok(totalMove / steps < 3.5, `average movement ${totalMove / steps} too large`);
});

test('drones live in a lower register than the pads', () => {
  const chord = buildChord({ rootPc: 0, modeName: 'dorian', degree: 0, shape: 'triad' });
  const drone = voiceLead([], [chord.pcs[0], chord.pcs[2]], DRONE_REGISTER);
  assert.ok(drone.every((m) => m <= DRONE_REGISTER.hi));
  assert.ok(drone[0] <= 40, `drone root too high: ${drone}`);
});

test('nextDegree stays on the scale and does move', () => {
  const rng = new Rng('degrees');
  const seen = new Set();
  let degree = 0;
  for (let i = 0; i < 400; i++) {
    degree = nextDegree(rng, degree);
    assert.ok(Number.isInteger(degree) && degree >= 0 && degree <= 6);
    seen.add(degree);
  }
  assert.ok(seen.size >= 6, `only visited ${seen.size} degrees`);
});

test('modulation stays in range and changes something', () => {
  const rng = new Rng('keys');
  let key = { rootPc: 0, modeName: 'aeolian' };
  let changes = 0;
  for (let i = 0; i < 100; i++) {
    const next = modulate(rng, key);
    assert.ok(next.rootPc >= 0 && next.rootPc < 12);
    assert.ok(MODE_NAMES.includes(next.modeName));
    if (next.rootPc !== key.rootPc || next.modeName !== key.modeName) changes++;
    key = next;
  }
  assert.ok(changes > 40, `only ${changes} modulations in 100`);
});

test('midiToHz matches concert pitch', () => {
  assert.equal(Math.round(midiToHz(69)), 440);
  assert.ok(Math.abs(midiToHz(57) - 220) < 0.01);
  assert.ok(Math.abs(midiToHz(60) - 261.6255653) < 0.001);
});

test('every mode is usable', () => {
  for (const name of MODE_NAMES) {
    assert.equal(MODES[name].intervals.length, 7);
    assert.equal(MODES[name].intervals[0], 0);
  }
});
