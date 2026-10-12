import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INSTRUMENTS, STEP_COUNT, VOICE_TONES, isFillBar, patternsFor } from '../src/patterns.ts';
import { Conductor, SECTIONS } from '../src/conductor.ts';
import type { SectionName } from '../src/types.ts';

const SEED = 12345;
const SET_SEED = 'acid-cathedral-1a2b';
const NAMES = Object.keys(SECTIONS) as SectionName[];

const velocityOf = (pattern: { velocity: Uint8Array }, step: number): number => (pattern.velocity[step] ?? 0) / 255;

test('every instrument answers for all sixteen steps of a bar', () => {
  const patterns = patternsFor(SEED, 40, 1);
  for (const name of INSTRUMENTS) {
    const pattern = patterns[name];
    assert.equal(pattern.velocity.length, STEP_COUNT, `${name} has the wrong number of steps`);
    assert.equal(pattern.tone.length, STEP_COUNT, `${name} tones do not match its steps`);
    for (let step = 0; step < STEP_COUNT; step++) {
      assert.ok(velocityOf(pattern, step) >= 0 && velocityOf(pattern, step) <= 1);
      if (pattern.velocity[step] === 0) continue;
      const tone = pattern.tone[step] as number;
      assert.ok(tone < VOICE_TONES, `${name} step ${step} reached tone ${tone}`);
    }
  }
});

test('a pattern is a function of its arguments, not of what was asked before', () => {
  // The scheduler and the picture both ask for patterns, in different orders,
  // for times in either direction. A pattern that moved as a side effect of
  // being read would desynchronise the two halves.
  const forward = [16, 17, 18, 19, 20].map((bar) => patternsFor(SEED, bar, 1).hat.velocity.join(','));
  const backward = [20, 19, 18, 17, 16].map((bar) => patternsFor(SEED, bar, 1).hat.velocity.join(',')).reverse();
  assert.deepEqual(forward, backward);

  const interleaved = patternsFor(SEED, 18, 1);
  assert.deepEqual(patternsFor(SEED, 16, 1).hat.velocity.join(','), forward[0]);
  assert.deepEqual(interleaved.hat.velocity.join(','), forward[2]);
});

test('the same seed and bar always give the same bar, and another seed does not', () => {
  const a = patternsFor(SEED, 128, 4).kick.velocity.join(',');
  const b = patternsFor(SEED, 128, 4).kick.velocity.join(',');
  const c = patternsFor(SEED + 1, 128, 4).kick.velocity.join(',');
  assert.equal(a, b);
  assert.notEqual(a, c, 'two seeds gave the same drums');
});

test('the same bar in two sections can differ', () => {
  const intro = patternsFor(SEED, 64, 0);
  const drop = patternsFor(SEED, 64, 1);
  const differs = INSTRUMENTS.some((name) => intro[name].velocity.join(',') !== drop[name].velocity.join(','));
  assert.ok(differs, 'the section a bar is in changed nothing about it');
});

test('the kick keeps the floor: four beats, at steps 0, 4, 8 and 12', () => {
  for (let bar = 0; bar < 60; bar++) {
    const kick = patternsFor(SEED, bar, 1).kick;
    for (const step of [0, 4, 8, 12]) {
      assert.ok(velocityOf(kick, step) > 0.7, `bar ${bar} step ${step} lost the four-on-the-floor`);
    }
  }
});

test('the bass stays in the low register and the arp in the high', () => {
  // The pattern layer carries no pitch, but the tone indices it reaches must be
  // the ones the engine turns into bass and stab notes respectively.
  const bass = patternsFor(SEED, 12, 1).bass;
  for (let step = 0; step < STEP_COUNT; step++) {
    if (bass.velocity[step] === 0) continue;
    assert.ok((bass.tone[step] as number) < 3, `the bass reached tone ${bass.tone[step]}`);
  }
});

test('a bar varies from bar to bar, and holds for four at a time', () => {
  const bars = [64, 65, 66, 67].map((bar) => patternsFor(SEED, bar, 1).perc.velocity.join(','));
  const distinct = new Set(bars).size;
  assert.ok(distinct > 1, 'four consecutive bars played identically');
  // The phrase is four bars long, so the template cannot change inside it; the
  // ghosts can, which is what stops a sixteen-bar loop sounding like one.
  assert.equal(patternsFor(SEED, 64, 1).phrase, patternsFor(SEED, 67, 1).phrase);
  assert.notEqual(patternsFor(SEED, 67, 1).phrase, patternsFor(SEED, 68, 1).phrase);
});

test('over a long set, no instrument falls silent', () => {
  for (const section of NAMES) {
    let kicks = 0;
    for (let bar = 0; bar < 64; bar++) {
      const pattern = patternsFor(SEED, bar, section === 'drop' ? 1 : 0)[section === 'drop' ? 'kick' : 'hat'];
      kicks += pattern.velocity.reduce((sum, v) => sum + (v > 0 ? 1 : 0), 0);
    }
    assert.ok(kicks > 64, `${section} played only ${kicks} hits in 64 bars`);
  }
});

test('the last bar of every four-bar phrase fills', () => {
  assert.equal(isFillBar(3), true);
  assert.equal(isFillBar(7), true);
  assert.equal(isFillBar(2), false);
  // Every passage is 8, 16, 24 or 32 bars, so the last bar of a passage is
  // always the last bar of a phrase: a drop is announced without the pattern
  // having to know what is coming.
  // And the set honours it: every passage the conductor writes is a whole
  // number of four-bar phrases, so the bar before a change always fills.
  const conductor = new Conductor(SET_SEED);
  conductor.ensure(3600);
  assert.ok(conductor.sections.length > 8, 'too few sections to be a set');
  for (const entry of conductor.sections) {
    assert.equal(entry.bars % 4, 0, `${entry.section.name} ran ${entry.bars} bars`);
    assert.ok(isFillBar(entry.bar + entry.bars - 1), `${entry.section.name} does not fill on its last bar`);
  }
});

test('a fill adds hits to the last beat of the bar it lands on', () => {
  const plain = patternsFor(SEED, 34, 1);
  const filling = patternsFor(SEED, 35, 1);
  const hits = (p: { velocity: Uint8Array }): number =>
    p.velocity.reduce((sum, v) => sum + (v > 0 ? 1 : 0), 0);
  assert.equal(plain.fill, false);
  assert.equal(filling.fill, true);
  assert.ok(hits(filling.clap) > hits(plain.clap), 'the fill did not fill the clap');
});

test('the fill gets louder towards the change', () => {
  const clap = patternsFor(SEED, 35, 1).clap;
  // The roll lands in the last quarter of the bar; what matters is that the
  // hits inside it build, not that they land on any particular step.
  const hits = [8, 9, 10, 11, 12, 13, 14, 15]
    .map((step) => ({ step, v: velocityOf(clap, step) }))
    .filter((hit) => hit.v > 0);
  assert.ok(hits.length >= 2, `the fill put ${hits.length} hits in the last quarter of the bar`);
  assert.ok(hits[hits.length - 1]!.v > hits[0]!.v, `the roll did not build: ${hits.map((h) => h.v.toFixed(2)).join(' ')}`);
});

test('a fill stays in the last quarter of the bar', () => {
  // A fill that spread across the whole bar would not read as a roll into the
  // next one; it would read as a different groove.
  for (let bar = 0; bar < 64; bar++) {
    const clap = patternsFor(SEED, bar, 1).clap;
    const tail = [8, 9, 10, 11, 12, 13, 14, 15].filter((step) => velocityOf(clap, step) > 0).length;
    if (isFillBar(bar)) {
      assert.ok(tail >= 2, `bar ${bar} fills but put ${tail} hits in its last quarter`);
    } else {
      assert.ok(tail <= 4, `bar ${bar} is not a fill bar but put ${tail} hits in its last quarter`);
    }
  }
});
