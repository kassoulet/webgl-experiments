import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Rng } from '@fractal-rave/shared';
import {
  MODES,
  MODE_NAMES,
  bassNote,
  buildChord,
  chordName,
  keyLabel,
  midiToHz,
  nextDegree,
  pickKey,
  placeNotes,
  spellsFlat,
} from '../src/harmony.ts';

test('every mode has seven intervals inside an octave', () => {
  for (const name of MODE_NAMES) {
    const mode = MODES[name];
    assert.ok(mode, `unknown mode ${name}`);
    assert.equal(mode?.intervals.length, 7, `${name} is not a seven-note scale`);
    assert.equal(mode?.intervals[0], 0, `${name} does not start on the root`);
    for (const interval of mode?.intervals ?? []) {
      assert.ok(interval >= 0 && interval <= 11, `${name} has interval ${interval}`);
    }
    for (let i = 1; i < (mode?.intervals.length ?? 0); i++) {
      assert.ok(
        (mode?.intervals[i] as number) > (mode?.intervals[i - 1] as number),
        `${name} is not ascending`,
      );
    }
  }
});

test('midiToHz anchors on A440', () => {
  assert.ok(Math.abs(midiToHz(69) - 440) < 1e-9);
  assert.ok(Math.abs(midiToHz(81) - 880) < 1e-9);
  assert.ok(Math.abs(midiToHz(57) - 220) < 1e-9);
});

test('a chord is a triad of the mode, with a seventh when the scale has one', () => {
  for (const modeName of MODE_NAMES) {
    for (let degree = 0; degree < 7; degree++) {
      const chord = buildChord({ rootPc: 0, modeName, degree });
      assert.ok(chord.pcs.length === 3 || chord.pcs.length === 4, `${chord.name} is neither a triad nor a seventh`);
      assert.equal(chord.pcs[0], chord.rootPc, `${modeName} degree ${degree} does not start on its root`);
      for (const pc of chord.pcs) assert.ok(pc >= 0 && pc < 12, `pitch class ${pc} out of range`);
      // Every chord tone is a note of the key's scale: a techno chord that left
      // the key would make the whole set sound like it had lost the plot. Note
      // that this is the *scale*, not the chord's own root — a ii° in aeolian
      // is a diminished triad, and its diminished fifth is still in the key.
      for (const pc of chord.pcs) {
        const inScale = MODES[modeName]?.intervals.some((i) => i === pc);
        assert.ok(inScale, `${chord.name} has pitch class ${pc}, which is not in ${modeName}`);
      }
      assert.equal(new Set(chord.pcs).size, chord.pcs.length, `${chord.name} repeats a pitch class`);
    }
  }
});

test('degrees keep their name across the scale', () => {
  const i = buildChord({ rootPc: 0, modeName: 'aeolian', degree: 0 });
  const iv = buildChord({ rootPc: 0, modeName: 'aeolian', degree: 3 });
  const vi = buildChord({ rootPc: 0, modeName: 'aeolian', degree: 5 });
  assert.equal(i.name, 'C i');
  assert.equal(iv.name, 'F iv');
  assert.equal(vi.name, 'G# VI');
  assert.notEqual(i.rootPc, iv.rootPc);
  assert.notEqual(iv.rootPc, vi.rootPc);
  assert.equal(chordName(0, 0, 'aeolian'), 'C i');
});

test('phrygian and harmonic minor spell flats, the others sharps', () => {
  assert.equal(spellsFlat('phrygian'), true);
  assert.equal(spellsFlat('harmonicMinor'), true);
  assert.equal(spellsFlat('aeolian'), false);
  assert.equal(chordName(1, 0, 'phrygian'), 'Db i');
  assert.equal(chordName(1, 0, 'aeolian'), 'C# i');
});

test('the bass root sits in the register a sub-bass line lives in', () => {
  for (let pc = 0; pc < 12; pc++) {
    const note = bassNote(pc);
    assert.ok(note >= 28 && note < 40, `root ${pc} landed on MIDI ${note}`);
  }
  assert.equal(bassNote(0), 28);
  assert.equal(bassNote(3), 31);
});

test('placeNotes puts a chord in one register, and keeps it in the key', () => {
  const chord = buildChord({ rootPc: 7, modeName: 'dorian', degree: 0 });
  const tight = placeNotes(chord.pcs, 64, 0);
  const wide = placeNotes(chord.pcs, 55, 12);
  for (const notes of [tight, wide]) {
    assert.equal(notes.length, chord.pcs.length);
    assert.ok(Math.max(...notes) - Math.min(...notes) <= 24, 'a voicing wider than two octaves is a mistake');
    for (const note of notes) {
      assert.ok(Number.isInteger(note));
      assert.ok(Math.abs(note - 55) <= 24, `note ${note} is nowhere near the centre`);
    }
  }
  // The same chord, spread out: same pitch classes, an octave wider.
  assert.deepEqual(
    tight.map((n) => ((n % 12) + 12) % 12).sort(),
    wide.map((n) => ((n % 12) + 12) % 12).sort(),
  );
  assert.ok(Math.max(...wide) >= Math.max(...tight));
});

test('placeNotes on an empty chord is empty, not undefined', () => {
  assert.deepEqual(placeNotes([], 60, 0), []);
});

test('nextDegree stays on the scale and mostly moves by a step', () => {
  const rng = new Rng('degrees');
  let small = 0;
  const total = 2000;
  for (let i = 0; i < total; i++) {
    const from = rng.int(7);
    const to = nextDegree(rng, from);
    assert.ok(Number.isInteger(to) && to >= 0 && to < 7, `degree ${to} is off the scale`);
    const step = Math.min((to - from + 7) % 7, (from - to + 7) % 7);
    if (step <= 2) small++;
  }
  // A bass line that leaps a fourth every bar is not a bass line: most moves
  // are to a neighbouring degree, and the rest are the occasional fourth.
  assert.ok(small / total > 0.68, `only ${((small / total) * 100).toFixed(0)}% of moves were small`);
});

test('pickKey is seeded, weighted towards the dark modes, and always valid', () => {
  const seen = new Set<string>();
  let dark = 0;
  let total = 0;
  for (let i = 0; i < 400; i++) {
    const key = pickKey(new Rng(`key-${i}`));
    assert.ok(key.rootPc >= 0 && key.rootPc < 12);
    assert.ok(MODES[key.modeName], `unknown mode ${key.modeName}`);
    seen.add(`${key.rootPc}:${key.modeName}`);
    total++;
    if (key.modeName === 'aeolian' || key.modeName === 'phrygian' || key.modeName === 'harmonicMinor') dark++;
  }
  // Twelve roots times five modes: 400 rolls should reach nearly all of them.
  assert.ok(seen.size >= 50, `only ${seen.size} distinct keys from 400 rolls`);
  assert.ok(dark / total > 0.5, `only ${((dark / total) * 100).toFixed(0)}% of keys were dark`);
});

test('pickKey is a function of its rng', () => {
  const a = pickKey(new Rng('same-key'));
  const b = pickKey(new Rng('same-key'));
  assert.deepEqual(a, b);
  assert.match(keyLabel(a), /^(C|C#|Db|D|D#|E|Eb|F|F#|Gb|G|G#|Ab|A|A#|Bb|B) \w+$/);
});
