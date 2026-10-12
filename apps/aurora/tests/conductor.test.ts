import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Conductor, SECTIONS } from '../src/conductor.ts';
import { midiToHz } from '../src/harmony.ts';
import type { SectionName } from '../src/types.ts';

const SEED = 'borealis-dawn-9f3c';

/** A conductor asked for nothing but one moment, for comparison. */
function describeAt(seed: string, t: number): string {
  return JSON.stringify(new Conductor(seed).stateAt(t));
}

test('a seed describes the same set an hour in, in a fresh conductor', () => {
  const conductor = new Conductor(SEED);
  conductor.ensure(7200);
  const probes = [0, 137.5, 900, 3600, 7200].map((t) => JSON.stringify(conductor.stateAt(t)));
  const fresh = [0, 137.5, 900, 3600, 7200].map((t) => describeAt(SEED, t));
  assert.deepEqual(fresh, probes);
});

test('another seed describes another set', () => {
  const a = [0, 600, 1800].map((t) => describeAt(SEED, t));
  const b = [0, 600, 1800].map((t) => describeAt('other-sky', t));
  assert.notDeepEqual(a, b);
});

test('queries never consume randomness', () => {
  // The rule that makes the whole design work: `stateAt`, `chordAt`,
  // `gridAt` and friends may be called in any order, any number of times,
  // ahead or behind, and must not move the set.
  const conductor = new Conductor(SEED);
  const quiet = [10, 20, 30].map((t) => JSON.stringify(conductor.stateAt(t)));
  // Now do all the awkward things: go far forward, come back, ask twice, ask
  // out of order, ask the sub-queries directly.
  conductor.ensure(4000);
  conductor.stateAt(3900);
  conductor.chordAt(50);
  conductor.gridAt(12);
  conductor.drift(99);
  conductor.stateAt(20);
  conductor.stateAt(10);
  conductor.stateAt(10);
  conductor.ensure(40);
  const noisy = [10, 20, 30].map((t) => JSON.stringify(conductor.stateAt(t)));
  assert.deepEqual(noisy, quiet);
});

test('every query reaches the same answer on a fresh conductor', () => {
  const conductor = new Conductor(SEED);
  const t = 1234.5;
  const reference = {
    chord: JSON.stringify(conductor.chordAt(t)),
    grid: JSON.stringify(conductor.gridAt(t)),
    drift: JSON.stringify(conductor.drift(t)),
    blend: JSON.stringify(conductor.sectionBlend(t)),
  };
  const other = new Conductor(SEED);
  other.ensure(9000);
  assert.equal(JSON.stringify(other.chordAt(t)), reference.chord);
  assert.equal(JSON.stringify(other.gridAt(t)), reference.grid);
  assert.equal(JSON.stringify(other.drift(t)), reference.drift);
  assert.equal(JSON.stringify(other.sectionBlend(t)), reference.blend);
});

test('sections run in order, without gaps or overlaps', () => {
  const conductor = new Conductor(SEED);
  conductor.ensure(1800);
  let expectedBar = 0;
  let previous: (typeof conductor.sections)[number] | null = null;
  for (const entry of conductor.sections) {
    assert.equal(entry.bar, expectedBar, `section ${entry.section.name} starts at bar ${entry.bar}`);
    if (previous) {
      assert.equal(entry.t, previous.t + previous.hold, 'a section does not start where the last one ended');
    } else {
      assert.equal(entry.t, 0, 'the set does not start at zero');
    }
    assert.equal(Math.round(entry.hold / entry.barSeconds), entry.bars, 'the hold does not match the bar count');
    assert.ok(entry.bars >= 8 && entry.bars <= 48, `${entry.bars} bars is not a passage`);
    assert.ok(entry.bpm >= 108 && entry.bpm <= 128, `${entry.bpm} bpm is out of synth-pop range`);
    assert.ok(SECTIONS[entry.section.name], `unknown section ${entry.section.name}`);
    previous = entry;
    expectedBar += entry.bars;
  }
});

test('the set opens with a dawn and reaches a chorus', () => {
  const conductor = new Conductor(SEED);
  conductor.ensure(3600);
  assert.equal(conductor.sections[0]?.section.name, 'dawn');
  const names = new Set(conductor.sections.map((s) => s.section.name));
  assert.ok(names.has('chorus'), 'an hour in, there was never a chorus');
});

test('a section only goes where its own recipe says it can', () => {
  const conductor = new Conductor(SEED);
  conductor.ensure(3600);
  for (let i = 0; i < conductor.sections.length - 1; i++) {
    const entry = conductor.sections[i];
    const next = conductor.sections[i + 1];
    const allowed = SECTIONS[entry!.section.name].next;
    assert.ok(allowed.includes(next!.section.name), `${entry!.section.name} went to ${next!.section.name}`);
  }
});

test('the bar clock is exact, and tempo changes land on section boundaries', () => {
  const conductor = new Conductor(SEED);
  conductor.ensure(1200);
  for (const entry of conductor.sections) {
    for (let bar = entry.bar; bar < entry.bar + entry.bars; bar += 3) {
      const t = conductor.timeOfBar(bar);
      assert.equal(conductor.gridAt(t).bar, bar, `bar ${bar} does not start where it says`);
      assert.equal(conductor.timeOfBar(bar), t, `bar ${bar} moved between two calls`);
    }
  }
});

test('the grid counts four beats to the bar', () => {
  const conductor = new Conductor(SEED);
  conductor.ensure(600);
  const t = conductor.timeOfBar(20);
  const grid = conductor.gridAt(t + 0.001);
  assert.equal(grid.bar, 20);
  assert.equal(grid.beat, 0);
  assert.ok(grid.beatPhase >= 0 && grid.beatPhase < 1);
  const quarter = conductor.gridAt(t + conductor.gridAt(t).barSeconds / 4);
  assert.equal(quarter.beat, 1);
  const half = conductor.gridAt(t + conductor.gridAt(t).barSeconds / 2);
  assert.equal(half.beat, 2);
  const three = conductor.gridAt(t + (conductor.gridAt(t).barSeconds * 3) / 4);
  assert.equal(three.beat, 3);
});

test('chords land on bars and in the key', () => {
  const conductor = new Conductor(SEED);
  conductor.ensure(1800);
  assert.ok(conductor.chords.length > 3);
  for (let i = 0; i < conductor.chords.length; i++) {
    const chord = conductor.chords[i];
    assert.ok(chord, `chord ${i} missing`);
    assert.ok(Math.abs(conductor.timeOfBar(chord!.bar) - (chord?.t as number)) < 1e-6, `chord ${i} is off the grid`);
    if (i > 0) {
      const previous = conductor.chords[i - 1];
      assert.ok((chord?.bar as number) > (previous?.bar as number), 'chords do not move forward');
      assert.ok((chord?.bar as number) - (previous?.bar as number) >= 8, 'the bass line moved faster than eight bars');
    }
    // The bass notes sit in the low register (32..43 by bassNote's contract)
    // and are audible frequencies.
    assert.ok((chord?.bassNotes[0] as number) >= 32 && (chord?.bassNotes[0] as number) < 44);
    assert.ok(Math.abs(midiToHz(chord?.bassNotes[0] as number)) > 20);
  }
});

test('events run in increasing time order', () => {
  const conductor = new Conductor(SEED);
  conductor.ensure(1800);
  let previous = -1;
  for (const event of conductor.events) {
    assert.ok(event.t >= previous, `an event at ${event.t} is behind one at ${previous}`);
    previous = event.t;
    assert.ok(event.params.duration > 0);
    assert.ok(event.params.level > 0 && event.params.level <= 1.2);
    assert.ok(event.params.pan >= -1 && event.params.pan <= 1);
  }
});

test('a chorus is announced: a swell arrives in the passage before it', () => {
  const conductor = new Conductor(SEED);
  conductor.ensure(2400);
  const sections = conductor.sections;
  let choruses = 0;
  let swells = 0;
  for (let i = 1; i < sections.length; i++) {
    const entry = sections[i]!;
    if (entry.section.name !== 'chorus') continue;
    choruses++;
    // The swell belongs to the passage *before* the chorus, in its last bars:
    // a transition announced inside the chorus itself would be too late to hear.
    const before = sections[i - 1]!;
    const window = conductor.eventsBetween(before.t + before.hold - 2.5 * before.barSeconds, entry.t + 0.001);
    if (window.some((e) => e.type === 'swell')) swells++;
  }
  assert.ok(choruses > 0, 'there was never a chorus in forty minutes');
  assert.ok(swells > 0, 'no chorus arrived on a swell');
});

test('sectionBlend ramps: it starts at the old levels and ends at the new ones', () => {
  const conductor = new Conductor(SEED);
  conductor.ensure(1800);
  const change = conductor.sections.findIndex((s, i) => i > 0 && s.section.name !== conductor.sections[i - 1]?.section.name);
  assert.ok(change > 0, 'no section change in thirty minutes');
  const entry = conductor.sections[change]!;
  const atStart = conductor.sectionBlend(entry.t);
  const long = entry.bars * entry.barSeconds;
  const atEnd = conductor.sectionBlend(entry.t + long - 0.001);
  assert.ok(Math.abs(atStart.fade) < 1e-9, 'the blend jumped at the change');
  assert.ok(atEnd.fade > 0.999, `the blend had not landed after a whole section (${atEnd.fade})`);
  const before = conductor.sectionBlend(entry.t - 0.001);
  assert.ok(Math.abs(before.fade - 1) < 1e-9, 'the old section had not finished arriving');
  assert.ok(
    Math.abs(atEnd.levels.kick - entry.section.kick) < 1e-9,
    'the levels did not arrive at the section own values',
  );
  // And the picture never overshoots on the way.
  for (let t = entry.t; t < entry.t + long; t += long / 40) {
    const f = conductor.sectionBlend(t).fade;
    assert.ok(f >= 0 && f <= 1, `the blend left its range: ${f}`);
    assert.ok(conductor.sectionBlend(t).levels.kick <= Math.max(entry.previous.kick, entry.section.kick) + 1e-9);
  }
});

test('the visual mix blends between sections without leaving its range', () => {
  const conductor = new Conductor(SEED);
  conductor.ensure(1800);
  for (let t = 0; t < 1800; t += 7) {
    const blend = conductor.sectionBlend(t);
    for (const [key, value] of Object.entries(blend.visualMix)) {
      assert.ok(
        Number.isFinite(value) && value >= 0 && value <= 1,
        `visual ${key} at ${value} out of range at t=${t}`,
      );
    }
  }
});

test('the flash cap holds: a soft picture cannot gain more than a fifth of its light', () => {
  // This is the photosensitivity rule, and it is asserted here rather than in
  // the shader because the number is decided here.
  const conductor = new Conductor(SEED);
  conductor.ensure(3600);
  let worstSoft = 0;
  let worstFull = 0;
  for (let t = 0; t < 3600; t += 0.25) {
    const state = conductor.stateAt(t, 'soft');
    const loud = conductor.stateAt(t, 'full');
    assert.ok(state.pulse >= 0 && state.pulse <= 1, `pulse ${state.pulse} out of range`);
    assert.ok(loud.pulse >= state.pulse - 1e-12, 'full flash mode gave less than soft');
    worstSoft = Math.max(worstSoft, state.pulse);
    worstFull = Math.max(worstFull, loud.pulse);
  }
  assert.ok(worstSoft > 0.05, 'the picture never pulses at all, which is not what soft means');
  assert.ok(worstSoft <= 0.2201, `a soft picture reached ${worstSoft.toFixed(3)}, above the cap`);
  assert.ok(worstFull > worstSoft, 'full flash mode is not louder than soft');
});

test('the pulse peaks on the beat, not between it', () => {
  const conductor = new Conductor(SEED);
  conductor.ensure(600);
  const t = conductor.timeOfBar(30);
  const blend = conductor.sectionBlend(t);
  const onBeat = conductor.pulseAt(t + 0.001, 'full', blend);
  const between = conductor.pulseAt(t + conductor.gridAt(t).barSeconds / 8, 'full', blend);
  assert.ok(onBeat > between, `the flash is not on the beat (${onBeat.toFixed(3)} vs ${between.toFixed(3)})`);
});

test('the drift never jumps', () => {
  const conductor = new Conductor(SEED);
  const span = conductor.drift(0);
  for (const key of Object.keys(span) as (keyof typeof span)[]) {
    let previous = conductor.drift(0)[key] as number;
    for (let t = 0.05; t < 600; t += 0.05) {
      const value = conductor.drift(t)[key] as number;
      assert.ok(
        Math.abs(value - previous) < 0.2,
        `${key} jumped from ${previous} to ${value} at t=${t.toFixed(2)}`,
      );
      previous = value;
    }
  }
});

test('describe reads as a set, not as a mood', () => {
  const conductor = new Conductor(SEED);
  const piece = conductor.describe(90);
  assert.match(piece.section, /^(dawn|verse|chorus|bridge|finale)$/);
  assert.ok(piece.bpm >= 108 && piece.bpm <= 128);
  assert.ok(piece.bar >= 0);
  assert.match(piece.chord, /^[A-G][#b]? (I{1,3}|ii|iii|iv|v|vi|vii°)$/);
  assert.match(piece.key, /^[A-G][#b]? \w+$/);
  assert.ok(piece.palette.length > 0);
});

test('forcing a section change truncates the passage in progress', () => {
  const conductor = new Conductor(SEED);
  conductor.ensure(600);
  const before = conductor.sections.length;
  const playing = conductor.sectionAt(60).entry;
  const forced = conductor.forceNextSection(60);

  assert.ok(SECTIONS[forced.name as SectionName], `forcing produced ${forced.name}`);
  // The whole point of the key: the change lands on the passage being played,
  // not at the end of everything already scheduled.
  assert.ok(forced.at > 60, 'the forced change is in the past');
  assert.ok(forced.lead < 12, `the change is ${forced.lead.toFixed(1)}s away, not a skip`);
  // The passage in progress is cut short, not merely followed by another one.
  assert.equal(playing.bars, forced.bar - playing.bar, 'the passage was not truncated');
  assert.ok(Math.abs(playing.hold - (forced.at - playing.t)) < 1e-9, 'hold does not reach the change');
  // A whole number of phrases, so it still ends on a fill bar.
  assert.equal(playing.bars % 4, 0, `forced to a ${playing.bars}-bar passage`);
  // Everything planned after the change is gone, not left to contradict it.
  assert.ok(before > 4, `the test needs a horizon to truncate, got ${before} passages`);
  const kept = conductor.sections.filter((entry) => entry.t <= forced.at);
  assert.equal(conductor.sections.length, kept.length);
  assert.ok(conductor.sections.every((entry) => entry.t <= forced.at));
  assert.ok(conductor.chords.every((chord) => chord.t < forced.at), 'a chord survived the truncation');
  // Everything planned before the change is gone. What sits exactly on the
  // boundary is the new passage's own opening events (sparkle, flare), pushed
  // after the cut — no old event can land there: a swell is strictly before a
  // section start, and every other type is placed inside its own section.
  assert.ok(conductor.events.every((event) => event.t <= forced.at), 'an event from the old plan survived the truncation');
  // And the schedule is still answerable everywhere it was before.
  for (const t of [0, 30, 59, forced.at, forced.at + 5, 300]) {
    assert.ok(Number.isFinite(conductor.stateAt(t).grid.bpm), `state at ${t} is not a number`);
  }
  // Events stay in time order.
  const times = conductor.events.map((event) => event.t);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'the event list lost its order');
});

test('a forced change is a real change, and the set carries on after it', () => {
  const conductor = new Conductor(SEED);
  conductor.ensure(600);
  const forced = conductor.forceNextSection(60);
  const after = conductor.describe(forced.at + 2);
  assert.equal(after.section, forced.name, 'the new passage is not the one playing');
  // The set did not stop at the change: a long horizon still describes a set.
  const later = conductor.describe(900);
  assert.match(later.section, /^(dawn|verse|chorus|bridge|finale)$/);
  assert.ok(later.bar > forced.bar, 'the bar clock did not carry on');
});

test('the picture gets levels before there is any audio', () => {
  const conductor = new Conductor(SEED);
  const state = conductor.stateAt(30);
  for (const [key, value] of Object.entries(state.levels)) {
    assert.ok(Number.isFinite(value as number), `level ${key} is not a number`);
    assert.ok((value as number) >= 0 && (value as number) <= 1, `level ${key} is ${value}`);
  }
});
