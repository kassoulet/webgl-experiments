import test from 'node:test';
import assert from 'node:assert/strict';

import { Conductor, MOODS, EVENT_TYPES, moodByName } from '../src/conductor.ts';
import { DEFAULT_REGISTER } from '../src/harmony.ts';

const EIGHT_HOURS = 8 * 3600;

test('a seed reproduces the whole journey', () => {
  const a = new Conductor('endless-night');
  const b = new Conductor('endless-night');
  a.ensure(EIGHT_HOURS);
  b.ensure(EIGHT_HOURS);
  assert.deepEqual(a.chords, b.chords);
  assert.deepEqual(a.sections, b.sections);
  assert.deepEqual(a.events, b.events);
  assert.deepEqual(a.key, b.key);
});

test('different seeds take different journeys', () => {
  const a = new Conductor('one');
  const b = new Conductor('two');
  a.ensure(7200);
  b.ensure(7200);
  assert.notDeepEqual(a.chords.map((c) => c.chord.name), b.chords.map((c) => c.chord.name));
});

test('queries do not consume randomness or change the schedule', () => {
  const conductor = new Conductor('stable');
  conductor.ensure(6000);
  const snapshot = JSON.stringify({ chords: conductor.chords, events: conductor.events, sections: conductor.sections });

  // Ask in a deliberately shuffled order, ahead and behind.
  const times = [0, 999, 12, 5400, 3.5, 2300, 480, 5999, 1, 4000];
  const first = times.map((t) => JSON.stringify(conductor.stateAt(t)));
  const second = [...times].reverse().map((t) => JSON.stringify(conductor.stateAt(t)));
  for (let i = 0; i < times.length; i++) {
    assert.equal(first[i], second[times.length - 1 - i], `stateAt(${times[i]}) is not stable`);
  }
  assert.equal(
    JSON.stringify({ chords: conductor.chords, events: conductor.events, sections: conductor.sections }),
    snapshot,
    'querying mutated the schedule',
  );
});

test('stateAt works walking forward in real time without a schedule jump', () => {
  const conductor = new Conductor('walking');
  let last = null;
  for (let t = 0; t < 4000; t += 0.25) {
    const state = conductor.stateAt(t);
    assert.ok(Number.isFinite(state.chord.pcs[0]));
    assert.ok(state.chord.pcs.length >= 3);
    assert.ok(state.voicing.length >= 3);
    if (last) {
      // Continuity: no parameter may jump between two nearby frames.
      assert.ok(Math.abs(state.drift.brightness - last.drift.brightness) < 0.05);
      assert.ok(Math.abs(state.palette.hot[0] - last.palette.hot[0]) < 0.2);
    }
    last = state;
  }
});

test('chords change on the scale the spec asks for: 20-90 seconds', () => {
  const conductor = new Conductor('cadence');
  conductor.ensure(EIGHT_HOURS);
  assert.ok(conductor.chords.length > 200, `only ${conductor.chords.length} chords in 8 h`);
  for (const chord of conductor.chords) {
    assert.ok(chord.hold >= 20 && chord.hold <= 90, `hold ${chord.hold}`);
  }
});

test('sections last minutes, not seconds', () => {
  const conductor = new Conductor('weather');
  conductor.ensure(EIGHT_HOURS);
  for (const section of conductor.sections) {
    assert.ok(section.hold >= 180 && section.hold <= 620, `section hold ${section.hold}`);
  }
  // And the weather does move within a long night.
  const names = new Set(conductor.sections.map((s) => s.mood.name));
  assert.ok(names.size >= 3, `only ${names.size} moods in 8 h`);
});

test('a journey never repeats: no identical 8-bar-scale phrase', () => {
  const conductor = new Conductor('never-twice');
  conductor.ensure(EIGHT_HOURS);
  const windows = [];
  for (let i = 0; i + 8 <= conductor.chords.length; i += 8) {
    windows.push(conductor.chords.slice(i, i + 8).map((c) => c.chord.name).join(' '));
  }
  assert.ok(windows.length > 20);
  assert.equal(new Set(windows).size, windows.length, 'a phrase came back');
});

test('every event is one of the kinds the spec allows, and they stay sparse', () => {
  const conductor = new Conductor('events');
  conductor.ensure(EIGHT_HOURS);
  assert.ok(conductor.events.length > 40, `only ${conductor.events.length} events in 8 h`);
  for (const event of conductor.events) {
    assert.ok(EVENT_TYPES.includes(event.type));
    assert.ok(event.params.duration > 0);
  }
  const gaps = conductor.events.slice(1).map((e, i) => e.t - conductor.events[i].t);
  for (const gap of gaps) assert.ok(gap >= 35, `two events only ${gap}s apart`);
});

test('eventsBetween returns exactly the window asked for', () => {
  const conductor = new Conductor('windows');
  conductor.ensure(EIGHT_HOURS);
  const window = conductor.eventsBetween(1000, 2000);
  assert.ok(window.length > 0);
  for (const e of window) assert.ok(e.t > 1000 && e.t <= 2000);
  const expected = conductor.events.filter((e) => e.t > 1000 && e.t <= 2000).length;
  assert.equal(window.length, expected);
  // Consuming the window must not consume it twice (the audio scheduler retries).
  assert.deepEqual(conductor.eventsBetween(1000, 2000), conductor.eventsBetween(1000, 2000));
});

test('a far-away event lights one star, and it fades rather than flashing', () => {
  const conductor = new Conductor('flares');
  conductor.ensure(EIGHT_HOURS);
  const events = conductor.events.filter((e) => e.t < 5000);
  assert.ok(events.length >= 20, `only ${events.length} events to check`);

  // One star at a time: the schedule leaves quiet between events so a lit star
  // is always done fading before the next one comes up.
  let litAt = [-1, -1];
  for (const event of events) {
    assert.ok(event.t > litAt[1], `events at ${litAt[0]} and ${event.t} overlap`);
    litAt = [event.t, event.t + event.params.duration];
  }

  let worstStep = 0;
  let worstPeak = 0;
  for (const event of events) {
    const { duration, level } = event.params;
    // The instant it starts, nothing is lit: the sky answers over seconds.
    assert.equal(conductor.flareAt(event.t)?.level ?? 0, 0, `a star flashed at ${event.t}`);
    let peak = 0;
    let previous = 0;
    for (let age = 0; age <= duration; age += 0.25) {
      const flare = conductor.flareAt(event.t + age);
      const now = flare ? flare.level : 0;
      if (flare) {
        assert.ok(now > 0 && now <= 1, `level ${now}`);
        assert.ok(now <= level + 1e-9, 'a star is brighter than the event that lit it');
        const [x, y, z] = flare.dir;
        assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 1e-9, 'the lit star is not on the sky');
      }
      worstStep = Math.max(worstStep, Math.abs(now - previous));
      peak = Math.max(peak, now);
      previous = now;
    }
    assert.ok(peak > 0.3, `an event only reached ${peak.toFixed(3)}`);
    worstPeak = Math.max(worstPeak, peak);
    // And it is out again by the time the event is over.
    assert.equal(conductor.flareAt(event.t + duration)?.level ?? 0, 0, 'a star stayed lit after its event');
  }
  // Nothing here is a flash: no step between two quarter-seconds is large.
  assert.ok(worstStep < 0.15, `a flare jumped ${worstStep.toFixed(3)} in a quarter second`);
  assert.ok(worstPeak <= 1);
});

test('the sky is unlit between events, and asks nothing of the schedule', () => {
  const conductor = new Conductor('flares');
  conductor.ensure(3000);
  // The quiet between the first two events.
  const [first, second] = conductor.events;
  const quiet = (first.t + first.params.duration + second.t) / 2;
  assert.ok(quiet < second.t);
  assert.equal(conductor.flareAt(quiet), null);
  // Asking for a flare anywhere does not extend or change the schedule.
  const before = JSON.stringify({ events: conductor.events, chords: conductor.chords });
  for (const t of [0, 500, 1234.5, 2999]) conductor.flareAt(t);
  assert.equal(JSON.stringify({ events: conductor.events, chords: conductor.chords }), before);
});

test('moods crossfade instead of switching', () => {
  const conductor = new Conductor('fades');
  conductor.ensure(4000);
  const second = conductor.sections[1];
  const justBefore = conductor.moodBlend(second.t - 0.01);
  const justAfter = conductor.moodBlend(second.t + 0.01);
  assert.equal(justAfter.mood, second.mood);
  assert.equal(justAfter.previous, justBefore.mood);
  assert.ok(justAfter.fade < 0.01, 'the new mood starts at zero');
  // Well inside the section (they last minutes), the fade is complete.
  assert.ok(second.hold > 60);
  assert.equal(conductor.moodBlend(second.t + 30).fade, 1);
});

test('voicings stay in register and move gently for a whole night', () => {
  const conductor = new Conductor('smooth');
  conductor.ensure(EIGHT_HOURS);
  let previous = null;
  let worst = 0;
  for (const { voicing } of conductor.chords) {
    assert.ok(
      voicing.every((m) => m >= DEFAULT_REGISTER.lo && m <= DEFAULT_REGISTER.hi),
      `voicing out of register: ${voicing}`,
    );
    if (previous && previous.length === voicing.length) {
      for (let i = 0; i < voicing.length; i++) worst = Math.max(worst, Math.abs(voicing[i] - previous[i]));
    }
    previous = voicing;
  }
  assert.ok(worst <= 10, `a voice jumped ${worst} semitones`);
});

test('the camera drifts continuously and slowly', () => {
  const conductor = new Conductor('camera');
  const dt = 0.25;
  let last = conductor.cameraAt(0);
  for (let t = dt; t < 3000; t += dt) {
    const now = conductor.cameraAt(t);
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(Math.abs(now.position[axis] - last.position[axis]) < 0.05, `camera jumped at ${t}`);
    }
    assert.ok(Math.abs(now.yaw - last.yaw) < 0.03, `yaw jumped at ${t}`);
    assert.ok(Math.abs(now.pitch - last.pitch) < 0.02, `pitch jumped at ${t}`);
    last = now;
  }
  const far = conductor.cameraAt(600);
  const near = conductor.cameraAt(0);
  const travelled = Math.hypot(...far.position.map((p, i) => p - near.position[i]));
  assert.ok(travelled > 0.05, 'the camera never moves over ten minutes');
});

test('the palette follows the harmony and stays in range', () => {
  const conductor = new Conductor('colors');
  const seen = new Set();
  for (let t = 0; t < 6000; t += 3.3) {
    const { palette } = conductor.stateAt(t);
    seen.add(palette.name);
    for (const key of ['deep', 'mid', 'hot'] as const) {
      for (const c of palette[key]) {
        assert.ok(Number.isFinite(c) && c >= 0 && c <= 1.6, `${key} channel ${c}`);
      }
    }
  }
  assert.ok(seen.size >= 2, 'the palette never changed over 100 minutes');
});

test('state carries everything both halves need', () => {
  const conductor = new Conductor('api');
  const state = conductor.stateAt(3600);
  for (const field of ['t', 'seed', 'key', 'chord', 'nextChord', 'voicing', 'droneHz', 'mood', 'drift', 'palette', 'levels', 'flare']) {
    assert.ok(field in state, `state is missing ${field}`);
  }
  assert.equal(state.droneHz.length, 2);
  assert.ok(state.droneHz.every((hz) => hz > 20 && hz < 300));
  const line = conductor.describe(3600);
  assert.ok(line.key.length > 0 && line.chord.length > 0 && line.mood.length > 0);
  assert.ok(MOODS.includes(state.mood));
  assert.equal(state.mood, moodByName(state.mood.name));
});

test('an eight-hour horizon is cheap to schedule', () => {
  const conductor = new Conductor('budget');
  const started = Date.now();
  conductor.ensure(EIGHT_HOURS);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `scheduling 8 h took ${elapsed} ms`);
  assert.ok(conductor.scheduled >= EIGHT_HOURS);
});
