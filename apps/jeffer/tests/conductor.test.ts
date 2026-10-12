// The conductor: the set itself, as a pure function of a seed and a time.
//
// Everything here is a claim about time. The scheduler asks for events twelve
// seconds ahead, the picture asks for the bar it is drawing, a seed link has to
// describe the same set in a fresh page an hour later, and the skip key has to
// be able to cut a passage short without the schedule disagreeing with itself.
// A conductor that is not a function of time breaks all four, quietly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Conductor, SECTIONS } from '../src/conductor.ts';
import { FLASH_DEPTH } from '../src/profile.ts';
import type { DescribedPiece, SectionName } from '../src/types.ts';

const SEED = 'tape-head-1';
const NAMES = Object.keys(SECTIONS) as SectionName[];

const conductor = (): Conductor => new Conductor(SEED);

test('the set starts at zero, in a passage, on the grid', () => {
  const c = conductor();
  const at = c.sectionAt(0);
  assert.equal(at.entry.bar, 0);
  assert.ok(at.entry.bpm >= 120 && at.entry.bpm <= 134, `${at.entry.bpm} bpm is outside the reference's tempo`);
  assert.ok(at.entry.bars % 4 === 0, `a passage of ${at.entry.bars} bars is not whole phrases`);
  const grid = c.gridAt(0);
  assert.equal(grid.bar, 0);
  assert.equal(grid.beat, 0);
  assert.equal(grid.bpm, at.entry.bpm);
});

test('a passage runs for the bars it says it does, and the next one starts on the line', () => {
  const c = conductor();
  c.ensure(600);
  let t = 0;
  for (let i = 0; i < c.sections.length - 1; i++) {
    const entry = c.sections[i]!;
    const next = c.sections[i + 1]!;
    assert.equal(next.bar, entry.bar + entry.bars, `section ${i} ends and ${next.section.name} does not begin on its bar line`);
    assert.equal(next.t, entry.t + entry.hold, `section ${i}'s hold does not reach the next section`);
    assert.ok(entry.hold > 0, 'a passage of no length');
    // The last bar of every passage is a fill bar, which is the reason the
    // counts are multiples of four.
    assert.ok((entry.bar + entry.bars) % 4 === 0, `section ${i} does not end on a phrase boundary`);
    t = next.t;
  }
  assert.ok(t > 60, `ten passages only reached ${t.toFixed(1)}s`);
});

test('a passage only goes where it says it goes', () => {
  const c = conductor();
  c.ensure(1800);
  for (let i = 0; i < c.sections.length - 1; i++) {
    const entry = c.sections[i]!;
    const next = c.sections[i + 1]!;
    const allowed: SectionName[] = entry.section.next;
    assert.ok(
      allowed.includes(next.section.name),
      `${entry.section.name} went to ${next.section.name}, which is not one of ${allowed.join('/')}`,
    );
  }
});

test('every passage in the set is one this app knows about', () => {
  const c = conductor();
  c.ensure(1800);
  const seen = new Set(c.sections.map((entry) => entry.section.name));
  for (const name of seen) {
    assert.ok(NAMES.includes(name as SectionName), `${name} is not a passage`);
    assert.ok(SECTIONS[name as SectionName], `${name} has no section entry`);
  }
  // And a set that only ever plays one passage is not a set. Six passages, an
  // hour and a half, and every one of them has to have been reached.
  assert.ok(seen.size >= 4, `half an hour only reached ${[...seen].join(', ')}`);
});

test('the grid reads the same bar the schedule wrote', () => {
  // `timeOfBar` and `gridAt` are the two halves of every bar in the app: the
  // scheduler places events with the first, the picture flashes with the second.
  // A half-bar disagreement between them is a kick that is a 16th late and a
  // flash that is a 16th early, and neither looks like a bug.
  const c = conductor();
  for (const bar of [0, 1, 4, 7, 16, 33, 64, 128]) {
    const t = c.timeOfBar(bar);
    assert.equal(c.gridAt(t + 1e-6).bar, bar, `bar ${bar} reads back as ${c.gridAt(t + 1e-6).bar}`);
    if (bar > 0) {
      assert.equal(c.gridAt(t - 0.001).bar, bar - 1, `just before bar ${bar} is not bar ${bar - 1}`);
    }
  }
  // Within a bar, the phases run 0..1 and wrap in the right order.
  const t = c.timeOfBar(8);
  const bar = c.gridAt(t).barSeconds;
  const quarter = c.gridAt(t + bar * 0.25).beat;
  const half = c.gridAt(t + bar * 0.5).beat;
  assert.equal(quarter, 1);
  assert.equal(half, 2);
  assert.ok(c.gridAt(t).barPhase < 0.01, 'a bar does not start at its own beginning');
  assert.ok(c.gridAt(t + bar * 0.99).barPhase > 0.9, 'the end of a bar is not near its end');
});

test('the set is a function of its seed and its time, and of nothing else', () => {
  // Asked forwards, backwards, in a fresh conductor, or an hour in: the same
  // answers. This is the seed link's whole promise, and it is checked here
  // rather than in the browser.
  const a = conductor();
  const b = conductor();
  const probes = [0, 7, 61, 600, 3600];
  const describe = (c: Conductor, t: number): string => JSON.stringify(c.describe(t));
  const first = probes.map((t) => describe(a, t));
  assert.deepEqual(probes.map((t) => describe(b, t)), first);
  assert.deepEqual([...probes].reverse().map((t) => describe(a, t)), [...first].reverse());
  // Asking about a far-future time first must not change the near ones.
  const c = conductor();
  const early = describe(c, 12);
  c.ensure(7200);
  assert.equal(describe(c, 12), early);
  // And the set is not the same set twice over. (This is the check that catches a
  // hash which quietly returns zero: every seed would describe the same set, and
  // a seed link would be a link to nothing in particular.)
  for (const seed of ['another-seed', 'zzz', 'tape-head-2']) {
    assert.notEqual(describe(new Conductor(seed), 0), first[0], `${seed} played the same set`);
  }
});

test('a set describes itself as something worth listening to', () => {
  const c = conductor();
  c.ensure(3600);
  const moments: DescribedPiece[] = [0, 30, 120, 400, 900, 3600].map((t) => c.describe(t));
  for (const piece of moments) {
    assert.ok(NAMES.includes(piece.section as SectionName), `${piece.section} is not a passage`);
    assert.ok(piece.chord.length > 0 && piece.next.length > 0, 'a moment with no harmony');
    assert.ok(piece.key.length > 0, 'a moment with no key');
    assert.ok(piece.palette.length > 0, 'a moment with no colour');
    assert.ok(piece.bpm >= 120 && piece.bpm <= 134, `${piece.bpm} bpm`);
  }
  assert.ok(new Set(moments.map((p) => `${p.section}/${p.chord}`)).size >= 3, 'six moments, one idea');
});

test('the transitions arrive in time order, in the window asked for, once each', () => {
  // The conductor's own events are the set's punctuation — an impact and a crash
  // on a drop, a siren somewhere inside a long one, a sweep in a break — not its
  // notes. The notes are the engine's, read off the grid; what is scheduled here
  // is the handful of things a bar of sixteenths cannot say.
  const c = conductor();
  c.ensure(600);
  // `eventsBetween(from, to]` is (from, to] on purpose: the scheduler asks for
  // "everything since I last looked", and a boundary event handed over twice is
  // a doubled crash.
  let from = 0;
  const seen: string[] = [];
  for (let to = 5; to <= 600; to += 5) {
    const events = c.eventsBetween(from, to);
    for (let i = 1; i < events.length; i++) {
      assert.ok((events[i] as { t: number }).t >= (events[i - 1] as { t: number }).t, 'events are out of order');
    }
    for (const event of events) {
      assert.ok(event.t > from && event.t <= to, `an event at ${event.t} in the window (${from}, ${to}]`);
      assert.ok(['riser', 'impact', 'sweep', 'siren', 'crash', 'zap'].includes(event.type), `a ${event.type} in the schedule`);
      assert.ok(event.hold > 0, `an event at ${event.t} holds for nothing`);
      // A drop opens with two things at once — an impact and a crash — so the
      // identity of an event is its type *and* its time, not its time alone.
      seen.push(`${event.type}@${event.t}`);
    }
    from = to;
  }
  assert.ok(seen.length >= 20, `ten minutes of a set scheduled ${seen.length} transitions`);
  assert.equal(new Set(seen).size, seen.length, 'the same event was handed over twice');
  // Every drop opens with its impact, on the bar line, at the top of the
  // passage. A drop that arrives without one is a drop nobody heard arrive.
  const drops = c.sections.filter((entry) => entry.section.name === 'drop');
  assert.ok(drops.length >= 2, `ten minutes of a set only reached ${drops.length} drops`);
  for (const drop of drops) {
    const opening = c.eventsBetween(drop.t - 0.001, drop.t + 0.001);
    assert.ok(opening.some((e) => e.type === 'impact'), `the drop at ${drop.t.toFixed(1)}s opens with nothing`);
  }
  // Asking again for the same window gives the same answer, and asking for an
  // old window after a later one still works — the list is a schedule, not a
  // cursor.
  const again = c.eventsBetween(0, 5).map((e) => `${e.type}@${e.t}`);
  assert.deepEqual(again, c.eventsBetween(0, 5).map((e) => e.t));
});

test('the flash peaks on the beat, and never past the cap', () => {
  // The picture flashes off the kick envelope and the kick envelope comes off
  // the grid, so this is the check that the scope and the drums are reading the
  // same clock. A flash that peaked between the beats would be a strobe on
  // nobody's downbeat, which on a picture that is two-thirds black is exactly
  // the wrong thing to do.
  const c = conductor();
  c.ensure(60);
  const bar = c.timeOfBar(8);
  const barSeconds = c.gridAt(bar).barSeconds;
  const at = (fraction: number): number => c.stateAt(bar + barSeconds * fraction).pulse;
  for (let beat = 0; beat < 4; beat++) {
    const onBeat = at(beat / 4);
    const beforeBeat = at(beat / 4 + 0.9 / 16);
    assert.ok(onBeat > beforeBeat, `beat ${beat + 1} is dimmer than the step before it`);
    assert.ok(onBeat <= FLASH_DEPTH.soft + 1e-9, `beat ${beat + 1} flashed at ${onBeat}, past the soft cap`);
  }
  // The loudest flash in the bar is on a beat, not between two of them.
  let best = 0;
  let bestAt = 0;
  for (let i = 0; i < 400; i++) {
    const pulse = at(i / 400);
    if (pulse > best) {
      best = pulse;
      bestAt = i / 400;
    }
  }
  const beat = bestAt * 4;
  assert.ok(Math.abs(beat - Math.round(beat)) < 0.05, `the brightest moment was ${(beat * 100).toFixed(0)}% into the bar`);
  // A different passage may flash harder, but the cap is a property of the mode
  // and not of the arrangement: 'full' is the opt-in, and it is higher.
  assert.ok(FLASH_DEPTH.full > FLASH_DEPTH.soft);
  assert.ok(c.stateAt(bar, 'full').pulse <= FLASH_DEPTH.full + 1e-9);
});

test('a forced change cuts the passage short and the set carries on', () => {
  // The skip key. Three claims: the cut lands soon (it is a button, not a
  // scheduled event), it lands on a phrase boundary with music in front of it,
  // and the set keeps its own shape afterwards — the passage after the cut is a
  // real passage, chosen from the one that was playing.
  const c = conductor();
  const at = 20;
  c.ensure(at + 5);
  const before = c.sectionAt(at).entry;
  const forced = c.forceNextSection(at);

  assert.ok(forced.lead > 0, `the cut is ${forced.lead.toFixed(2)}s away`);
  assert.ok(forced.lead < 12, `the cut is ${forced.lead.toFixed(2)}s away, which is not a button`);
  assert.ok(NAMES.includes(forced.name as SectionName), `${forced.name} is not a passage`);
  assert.ok(before.section.next.includes(forced.name as SectionName), `${before.section.name} forced its way to ${forced.name}`);
  assert.equal(forced.bar % 4, 0, `the cut landed on bar ${forced.bar}, which is not a phrase boundary`);
  // The passage being cut really does end at the cut.
  assert.equal(before.bars, forced.bar - before.bar);
  assert.ok(Math.abs(before.hold - (forced.at - before.t)) < 1e-9);
  // The passage being cut really does play until then.
  assert.equal(c.sectionAt(forced.at - 0.01).entry.bar, before.bar);
  assert.equal(c.sectionAt(forced.at + 0.01).entry.bar, forced.bar);
  // And the bar clock has not been wound back: the set is further along than it
  // was, not restarted.
  assert.ok(c.gridAt(forced.at + 1).bar >= forced.bar);
  assert.ok(c.gridAt(forced.at + 20).bar > forced.bar, 'the set stopped after the cut');
  // Everything after the cut is a real schedule, in order, with nothing left
  // over from the abandoned passage.
  assert.ok(c.events.every((e) => e.t >= 0), 'a negative event time');
  for (let i = 1; i < c.events.length; i++) {
    assert.ok((c.events[i] as { t: number }).t >= (c.events[i - 1] as { t: number }).t);
  }
});

test('a forced change is not seed-deterministic, and everything before it is', () => {
  // Said out loud in the code and asserted here: a set someone has skipped
  // through is not the set the seed alone would have played. What *is* promised
  // is that the part already heard is untouched, which is what keeps the audio,
  // the picture and the HUD agreeing about it. `next` is left out of the
  // comparison on purpose: the chord a passage is *heading* for is planned past
  // the cut, and re-planning it is the cut doing its job.
  const heard = (c: Conductor): string =>
    JSON.stringify([0, 5, 10].map((t) => {
      const { key, chord, section, bpm, bar } = c.describe(t);
      return { key, chord, section, bpm, bar };
    }));
  const a = conductor();
  const b = conductor();
  const before = heard(a);
  a.forceNextSection(12);
  b.forceNextSection(12);
  assert.equal(heard(a), before, 'the cut changed the part of the set already heard');
  assert.equal(heard(b), before, 'the cut changed the part of the set already heard');
  // Two conductors that cut at the same moment land on the same passage, so the
  // key is repeatable even though a cut is not seed-deterministic on its own.
  assert.equal(a.describe(30).section, b.describe(30).section);
});
