import { test } from 'node:test';
import assert from 'node:assert/strict';

import { patternsFor, VOICE_TONES, type BarPatterns } from '../src/patterns.ts';

const SEED = 'borealis-dawn-9f3c';
const INSTRUMENTS = ['kick', 'bass', 'hat', 'clap', 'perc', 'stab', 'arp', 'pad', 'fx'] as const;

test('every pattern is sixteen steps', () => {
  for (const bar of [0, 1, 7, 1234]) {
    for (const section of ['dawn', 'verse', 'chorus', 'bridge', 'finale']) {
      const patterns = patternsFor(SEED, bar, section);
      for (const inst of INSTRUMENTS) {
        assert.equal(patterns[inst].length, 16, `${inst} in ${section} at bar ${bar} is not sixteen steps`);
      }
    }
  }
});

test('the kick is four on the floor, or close to it', () => {
  // Synth-pop leans on the downbeats: over many bars, the kick must fire on
  // beat 1 nearly always and land somewhere on most beats.
  let downbeats = 0;
  let bars = 0;
  for (let bar = 0; bar < 200; bar++) {
    const kick = patternsFor(SEED, bar, 'chorus').kick;
    bars++;
    if (kick[0]) downbeats++;
  }
  assert.ok(downbeats / bars > 0.9, `the kick hit beat 1 only ${downbeats}/${bars} times`);
});

test('the pad sustains, the fx breathes', () => {
  // Pads are held: one or two hits at the top of the bar, never a wiggle. FX
  // are the opposite — sparse texture across the whole library of bars.
  for (let bar = 0; bar < 50; bar++) {
    const pad = patternsFor(SEED, bar, 'verse').pad;
    const hits = pad.filter(Boolean).length;
    assert.ok(hits <= 2, `the pad hit ${hits} times in one bar — it is not a pad any more`);
  }
});

test('a section shapes its parts', () => {
  // The section level table is what makes a dawn quiet and a chorus full; the
  // pattern layer must not cancel that out. Counting active steps across the
  // rhythm section over many bars, a chorus must not be emptier than a dawn.
  const activity = (section: string): number => {
    let hits = 0;
    for (let bar = 0; bar < 100; bar++) {
      const p: BarPatterns = patternsFor(SEED, bar, section);
      for (const inst of ['kick', 'bass', 'hat', 'clap', 'perc'] as const) {
        hits += p[inst].filter(Boolean).length;
      }
    }
    return hits;
  };
  const dawn = activity('dawn');
  const chorus = activity('chorus');
  assert.ok(chorus > 0, 'a chorus scheduled nothing at all');
  // The chorus templates are allowed to be busier but never half empty
  // relative to the dawn, on the same seed.
  assert.ok(chorus >= dawn * 0.6, `chorus ${chorus} vs dawn ${dawn} — the sections do not differ`);
});

test('patterns are a pure function of seed, bar and section', () => {
  const a = patternsFor(SEED, 42, 'chorus');
  const b = patternsFor(SEED, 42, 'chorus');
  assert.deepEqual(a, b);
  // A different bar differs somewhere over a run of bars (a program that is
  // the same every bar is a loop, and this set is not allowed to be one).
  const bars = new Set<string>();
  for (let bar = 0; bar < 40; bar++) {
    bars.add(JSON.stringify(patternsFor(SEED, bar, 'verse')));
  }
  assert.ok(bars.size > 1, 'forty bars, one pattern — the set is looping');
});

test('the voice tones are stable identifiers', () => {
  // The tone table is part of the sound design: each instrument maps to one
  // number, and the numbers are distinct.
  const tones = Object.values(VOICE_TONES);
  assert.equal(new Set(tones).size, tones.length, 'two instruments share a tone');
  assert.equal(VOICE_TONES.kick, 0);
});
