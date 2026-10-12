// The drums, as a function of (seed, bar, section) and nothing else.
//
// The claim under every one of these is that the pattern generator is *pure*:
// the audio scheduler asks for bars ahead of time, the picture asks for the bar
// it is drawing, and a smoke test reloads a page an hour later to check the
// seed link still describes the same set. Any state in here — a cursor, a
// "last bar asked for" — breaks all three at once, and breaks them quietly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  INSTRUMENTS,
  VOICE_TONES,
  contourFor,
  densityFor,
  isFillBar,
  patternsFor,
} from '../src/patterns.ts';
import { SECTIONS } from '../src/conductor.ts';
import type { SectionName } from '../src/types.ts';

const SEED = 20260930;
const NAMES = Object.keys(SECTIONS) as SectionName[];
/** A bar of sixteenths. Every bank in `patterns.ts` is written in them. */
const STEP_COUNT = 16;

const velocityOf = (pattern: { velocity: Uint8Array }, step: number): number =>
  (pattern.velocity[step] ?? 0) / 255;

test('every instrument answers for all sixteen steps of a bar', () => {
  for (const section of NAMES) {
    const patterns = patternsFor(SEED, 40, NAMES.indexOf(section), section);
    for (const name of INSTRUMENTS) {
      const pattern = patterns[name];
      assert.equal(pattern.velocity.length, STEP_COUNT, `${name} has the wrong number of steps`);
      assert.equal(pattern.tone.length, STEP_COUNT, `${name}'s tones do not match its steps`);
      for (let step = 0; step < STEP_COUNT; step++) {
        const v = velocityOf(pattern, step);
        assert.ok(v >= 0 && v <= 1, `${name} step ${step} has velocity ${v}`);
        if (pattern.velocity[step] === 0) continue;
        const tone = pattern.tone[step] as number;
        assert.ok(tone < VOICE_TONES, `${name} step ${step} reached tone ${tone}`);
      }
    }
  }
});

test('a pattern is a function of its arguments, not of what was asked before', () => {
  // The scheduler walks forward, the picture walks back, and the tests walk in
  // whatever order they like. A pattern that moved as a side effect of being
  // read would desynchronise the two halves of the app from each other.
  const at = (bar: number): string => patternsFor(SEED, bar, 1, 'groove').hat.velocity.join(',');
  const forward = [16, 17, 18, 19, 20].map(at);
  const backward = [20, 19, 18, 17, 16].map(at).reverse();
  assert.deepEqual(forward, backward);

  const interleaved = patternsFor(SEED, 18, 1, 'groove');
  assert.equal(patternsFor(SEED, 16, 1, 'groove').hat.velocity.join(','), forward[0]);
  assert.equal(interleaved.hat.velocity.join(','), forward[2]);
});

test('the same seed and bar always give the same bar, and another seed does not', () => {
  // Sixteen bars of hats rather than one kick: a single bar can land on the same
  // bank entry for two seeds by chance, and sixteen is the difference between
  // "these two seeds sound the same" and "this one bar happened to match".
  const bars = (seed: number): string =>
    Array.from({ length: 16 }, (_, i) => patternsFor(seed, 128 + i, 3, 'drop').hat.velocity.join(',')).join('|');
  assert.equal(bars(SEED), bars(SEED));
  assert.notEqual(bars(SEED), bars(SEED + 1), 'two seeds gave the same sixteen bars of hats');
});

test('a passage decides how busy it is, and which bank it plays from', () => {
  // Electro's sections are not the same rhythm at different volumes: a break
  // takes its hats from a sparse window and a drop from a busy one, and the
  // section's own levels are what keep a break's kick silent. Both halves are
  // asserted, because "the break has no kick" is a claim about the arrangement
  // and "the break is sparser" is a claim about the pattern bank, and only one
  // of them is true on its own.
  assert.equal(SECTIONS.break.kick, 0, 'a break plays a kick');
  assert.ok(SECTIONS.drop.kick > 0, 'a drop plays no kick');
  assert.ok(SECTIONS.break.pad > SECTIONS.drop.pad, 'a break has less in it than a drop');
  const hits = (p: { velocity: Uint8Array }): number => p.velocity.reduce((sum, v) => sum + (v > 0 ? 1 : 0), 0);
  let sparse = 0;
  let busy = 0;
  for (let bar = 0; bar < 64; bar++) {
    sparse += hits(patternsFor(SEED, bar, NAMES.indexOf('break'), 'break').hat);
    busy += hits(patternsFor(SEED, bar, NAMES.indexOf('drop'), 'drop').hat);
  }
  assert.ok(busy > sparse, `64 bars of drop hats (${busy}) are no busier than 64 of break (${sparse})`);
  // And the two sections are not playing the same line: at least one bar differs.
  const same = Array.from({ length: 64 }, (_, bar) =>
    patternsFor(SEED, bar, NAMES.indexOf('break'), 'break').hat.velocity.join(',') ===
    patternsFor(SEED, bar, NAMES.indexOf('drop'), 'drop').hat.velocity.join(','),
  ).filter(Boolean).length;
  assert.ok(same < 64, 'every bar of a break is the same hat line as the drop');
});

test('a fill is in front of a change, and only there', () => {
  // Every passage is a whole number of four-bar phrases, so the last bar of a
  // phrase is the last bar of a passage. That is the whole reason the conductor
  // rounds its bar counts: without it a drop can arrive with nothing before it.
  for (let bar = 0; bar < 64; bar++) {
    assert.equal(isFillBar(bar), bar % 4 === 3, `bar ${bar}`);
  }
  for (const section of NAMES) {
    for (const bar of [3, 7, 11, 19]) {
      const patterns = patternsFor(SEED, bar, NAMES.indexOf(section), section);
      assert.equal(patterns.fill, isFillBar(bar), `${section} bar ${bar}`);
      assert.equal(patterns.phrase, Math.floor(bar / 4));
    }
  }
  // And a fill adds hits rather than taking them away: the last beat of the bar
  // is busier than the same beat in an ordinary bar.
  const ordinary = patternsFor(SEED, 40, 2, 'drop');
  const fill = patternsFor(SEED, 43, 2, 'drop');
  const lastBeat = (p: { velocity: Uint8Array }): number =>
    p.velocity.slice(12).reduce((sum, v) => sum + (v > 0 ? 1 : 0), 0);
  assert.ok(
    lastBeat(fill.perc) + lastBeat(fill.hat) >= lastBeat(ordinary.perc) + lastBeat(ordinary.hat),
    'the fill bar is quieter on the last beat than the bar before it',
  );
});

test('density rises towards the drop and falls away in the break', () => {
  // The density window is the arrangement's claim about how busy a passage is,
  // and the HUD reads it. A break that is as dense as its drop is a section
  // table that was filled in without listening to the reference.
  const breakDensity = densityFor('break');
  const dropDensity = densityFor('drop');
  assert.ok(
    breakDensity[1] < dropDensity[1],
    `break ${breakDensity.join('-')} is not sparser than drop ${dropDensity.join('-')}`,
  );
  for (const section of NAMES) {
    const [lo, hi] = densityFor(section);
    assert.ok(lo >= 0 && hi >= lo, `${section}'s density window runs backwards`);
  }
});

test('a contour is a shape, not a sweep, and it is a function of its phrase', () => {
  // Electro stabs are two notes, a gap, a third — and that is exactly what the
  // engine asks for: a contour of two. A contour that walked the chord tones in
  // order would be an arpeggio, which is a different instrument.
  for (let phrase = 0; phrase < 32; phrase++) {
    const contour = contourFor(SEED, 1, phrase, 2);
    assert.equal(contour.length, 2);
    for (const tone of contour) {
      assert.ok(tone >= 0 && tone < 3, `phrase ${phrase} reached chord tone ${tone}`);
    }
    assert.ok(Math.max(...contour) - Math.min(...contour) <= 1, `phrase ${phrase}'s pair is a sweep`);
    assert.deepEqual(contour, contourFor(SEED, 1, phrase, 2), `phrase ${phrase} is not reproducible`);
  }
  // A count of one is still a note, and a count of zero is nothing at all rather
  // than a crash.
  assert.deepEqual(contourFor(SEED, 1, 0, 1), [0]);
  assert.deepEqual(contourFor(SEED, 1, 0, 0), []);
});
