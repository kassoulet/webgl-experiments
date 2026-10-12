import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyse,
  foldJournal,
  formatSeconds,
  parseJournal,
  renderReport,
  serialiseRecord,
  type JournalRecord,
  type SoakSampleRecord,
} from '../tools/soak-analysis.ts';

// The soak's conclusions are the one part of the app that cannot be re-derived
// cheaply: an eight-hour run is eight hours. So its arithmetic is exercised here
// against journals built by hand — first a healthy one that must pass every
// check, then one per way a long run can go wrong, each of which must fail its
// own check and leave the others alone. Without that second half, a threshold
// that fails everything would look like a strict test.

interface Fixture {
  /** Seconds between samples. */
  interval?: number;
  /** How long the run lasts, in seconds. */
  seconds?: number;
  /** How long it was asked to last (defaults to the same). */
  plannedSeconds?: number | null;
  /** Extra megabytes of heap on top of the flat baseline. */
  heapAt?: (at: number) => number;
  /** Frame advance per interval; 0 stops the renderer. */
  framesPerInterval?: number;
  /** Set false to kill the audio thread: no metering, no grains, no sound. */
  audio?: boolean;
  /** When the page is silent, with the audio thread still alive. */
  silentFrom?: number;
  /** When the journey clock stops keeping up with the page's wall clock. */
  clockLosesFrom?: number;
  /** Dom nodes added per interval. */
  nodesPerInterval?: number;
  /** Listeners added per interval. */
  listenersPerInterval?: number;
  /** Trim reported, as a function of the sample index. */
  trimDbAt?: (index: number) => number;
  /** Offline renders to record at these seconds; the default is each end. */
  loudnessAt?: number[];
  /** Outage: the page stops at this second and a new session begins. */
  outageAt?: number;
  /** Whether to write the closing `end` record at all. */
  complete?: boolean;
  /** Whether the run's samples end early, as a kill would. */
  truncateAt?: number;
}

function build(fixture: Fixture = {}): JournalRecord[] {
  const interval = fixture.interval ?? 15;
  const seconds = fixture.seconds ?? 3600;
  const plannedSeconds = fixture.plannedSeconds === undefined ? seconds : fixture.plannedSeconds;
  const records: JournalRecord[] = [
    {
      kind: 'start',
      version: 1,
      at: '2026-09-24T00:00:00.000Z',
      seed: 'test',
      interval,
      plannedSeconds,
      windowSize: '1280,720',
      site: '/dist',
    },
  ];

  // Per-session counters: a relaunch resets every one of them, which is the
  // whole reason the analysis groups samples by session.
  let segment = 0;
  let frames = 0;
  let grains = 0;
  let messages = 0;
  let lost = 0;
  let index = 0;
  let outageWritten = false;

  for (let at = 0; at <= seconds; at += interval, index++) {
    if (fixture.outageAt != null && at > fixture.outageAt && !outageWritten) {
      records.push({
        kind: 'outage',
        seg: segment,
        at: fixture.outageAt,
        seconds: 30,
        reason: 'the browser died',
      });
      outageWritten = true;
      segment++;
      // A new page: every counter starts again.
      frames = 0;
      grains = 0;
      messages = 0;
      lost = 0;
    }
    // Time on the page's own clock, restarting with a relaunch.
    const wall = at - (outageWritten ? fixture.outageAt ?? 0 : 0);
    if (fixture.clockLosesFrom != null && at > fixture.clockLosesFrom) lost += interval * 0.5;
    const clock = wall - lost;

    if (fixture.audio === false) {
      // The audio thread stopped: no metering, no grains, no loudness.
      messages = 0;
      grains = 0;
    } else {
      messages += interval * 4;
      grains += interval * 30;
    }
    // At the real rate a software renderer manages, about a frame a minute —
    // but always at least one, or an interval would look like a stall.
    frames += fixture.framesPerInterval ?? Math.max(1, Math.round(interval / 60));
    // Healthy unless asked otherwise: `audio: false` is the only way to kill
    // the thread, and the meter needs a moment at the start before it speaks.
    const silent =
      fixture.audio === false || (fixture.silentFrom != null && at >= fixture.silentFrom) || at < 30;

    const sample: SoakSampleRecord = {
      kind: 'sample',
      seg: segment,
      at,
      wall,
      clock,
      messages,
      grains,
      chords: fixture.audio === false ? 0 : 3,
      lufs: silent ? null : -17.5,
      truePeakDb: silent ? null : -4.5,
      // A settled leveller by default: a healthy run reports a trim, and one
      // that wanders a little is exactly what settling means.
      trimDb: fixture.trimDbAt?.(index) ?? -4.2 + Math.sin(index / 40) * 0.3,
      heapMb: 10 + (fixture.heapAt?.(at) ?? 0),
      nodes: 243 + (fixture.nodesPerInterval ?? 0) * index,
      listeners: 19 + (fixture.listenersPerInterval ?? 0) * index,
      frames,
      fps: 1,
      scale: 1,
      steps: 32,
    };
    if (fixture.truncateAt != null && at > fixture.truncateAt) break;
    records.push(sample);

    // The default: one render at each end, as a real run always takes.
    if ((fixture.loudnessAt ?? [0, seconds]).includes(at)) {
      records.push({
        kind: 'loudness',
        seg: segment,
        at,
        seconds: 30,
        tookMs: 4000,
        lufs: -17.5,
        truePeakDb: -5.2,
        rms: 0.13,
        peak: 0.5,
      });
    }
  }

  if (fixture.complete !== false) {
    records.push({ kind: 'end', at: seconds, reason: 'planned' });
  }
  return records;
}

/** The checks a journal failed, by name. */
function failing(records: JournalRecord[]): string[] {
  const run = foldJournal(records);
  return analyse(run).checks.filter((c) => !c.ok).map((c) => c.name);
}

test('a healthy hour passes every check', () => {
  const run = foldJournal(build({ seconds: 3600 }));
  const report = analyse(run);
  assert.deepEqual(
    report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`),
    [],
    'expected no failures',
  );
  assert.equal(report.checks.length >= 10, true, 'the checks themselves went missing');
  assert.equal(report.outages.length, 0);
  assert.equal(report.complete, true);
  assert.equal(report.tooShort, false);
});

test('an eight-hour run is reported as eight hours, hour by hour', () => {
  const run = foldJournal(build({ seconds: 8 * 3600, interval: 60 }));
  const report = analyse(run);
  assert.equal(formatSeconds(report.ranSeconds), '8h00m');
  assert.equal(report.timeline.length, 8, 'the timeline should have one row per hour');
  assert.equal(report.checks.every((c) => c.ok), true);
});

test('a heap that climbs for hours fails the leak check and nothing else', () => {
  // One megabyte an hour for eight hours: 8M in total, which a spread over the
  // whole run might forgive as allocator noise. The trend over the settled half
  // is what must catch it.
  const records = build({
    seconds: 8 * 3600,
    interval: 60,
    heapAt: (at) => at / 3600,
  });
  const failures = failing(records);
  assert.deepEqual(failures, ['the JS heap does not grow without bound']);

  const report = analyse(foldJournal(records));
  assert.notEqual(report.heapTrend, null);
  assert.ok(
    report.heapTrend!.deltaMb > HEAP_TREND,
    `the trend should see the climb, saw ${report.heapTrend!.deltaMb}`,
  );
});

/** The threshold the leak test is written against, named here so they stay in step. */
const HEAP_TREND = 3;

test('a heap that stops growing after its startup allocation passes', () => {
  // What the short run actually did: 10M when the audio started, 30M once the
  // reverb impulse and the convolution's buffers existed, then flat for as long
  // as anyone watched. A soak that called that a leak would fail every healthy
  // run it ever made.
  const records = build({
    seconds: 3600,
    interval: 15,
    heapAt: (at) => (at < 120 ? 0 : 20),
  });
  assert.deepEqual(failing(records), []);
});

test('a renderer that stops drawing fails the render check and nothing else', () => {
  const failures = failing(build({ seconds: 3600, framesPerInterval: 0 }));
  assert.deepEqual(failures, ['the renderer never stopped drawing']);
});

test('an audio thread that stops processing fails the audio check', () => {
  // The frame loop and the clock are healthy; only the sound is gone. This is
  // the case the journey clock cannot see, because the context keeps running.
  const failures = failing(build({ seconds: 3600, audio: false }));
  assert.deepEqual(failures, ['the audio never dropped out']);
});

test('a stream that falls silent mid-run fails the audio check', () => {
  // The thread still meters; the music is what stopped. Distinct from above.
  const records = build({ seconds: 3600, silentFrom: 1800 });
  const failures = failing(records);
  assert.deepEqual(failures, ['the audio never dropped out']);
  assert.match(
    analyse(foldJournal(records)).checks.find((c) => !c.ok)!.detail,
    /went silent/,
  );
});

test('a clock that loses half of every interval fails the clock check', () => {
  const failures = failing(build({ seconds: 3600, clockLosesFrom: 600 }));
  assert.deepEqual(failures, ['the journey clock kept time with the world']);
});

test('a leveller that never settles fails its own check', () => {
  // A trim still swinging 10 dB a sample, an hour in: the feedback is not
  // converging, which is what "settles" is for.
  const records = build({
    seconds: 3600,
    trimDbAt: (index) => (index % 2 === 0 ? 0 : 10),
  });
  const failures = failing(records);
  assert.deepEqual(failures, ['the leveller settles and stays inside its range']);
});

test('a master that drifts out of the region fails on the renders, not the live meter', () => {
  const records = build({
    seconds: 3600,
    loudnessAt: [0],
  });
  for (const record of records) {
    if (record.kind === 'loudness') record.lufs = -30;
  }
  const failures = failing(records);
  assert.deepEqual(failures, ['the master lands in the loudness region, journey after journey']);
});

test('an outage is reported as an interruption, and the clock check survives it', () => {
  // The important half: a relaunch restarts the page's clocks, so a check that
  // compared the first sample with the last would fail a run that was perfectly
  // healthy apart from the browser dying. It must be judged per session.
  const records = build({ seconds: 3600, outageAt: 1800 });
  const report = analyse(foldJournal(records));
  assert.equal(report.segments, 2);
  assert.equal(report.outages.length, 1);
  assert.equal(report.downSeconds, 30);
  assert.deepEqual(
    report.checks.filter((c) => !c.ok).map((c) => c.name),
    ['the piece ran without interruption'],
    'the relaunch should not look like a clock fault',
  );
  assert.deepEqual(
    report.checks.filter((c) => c.ok).map((c) => c.name).includes('the journey clock kept time with the world'),
    true,
  );
});

test('a run killed before its time is reported as short and incomplete', () => {
  // No `end` record and no samples after hour two of a planned eight: exactly
  // what a machine rebooting overnight leaves on disk.
  const records = build({
    seconds: 8 * 3600,
    interval: 60,
    truncateAt: 2 * 3600,
    complete: false,
  });
  const report = analyse(foldJournal(records));
  assert.equal(report.complete, false);
  assert.equal(report.short, true);
  assert.equal(report.plannedSeconds, 8 * 3600);
  assert.ok(report.ranSeconds > 7100 && report.ranSeconds < 7300);
  const markdown = renderReport(report);
  assert.match(markdown, /no end record/);
  assert.match(markdown, /killed, is still going/);
});

test('a run that has not finished yet is not reported as a failure', () => {
  // `soak:report` is meant to be read while the eight hours are still running,
  // so a journal with no end record must not fail the length check: the run has
  // not finished, which is not the same as a run that came up short.
  const running = build({ seconds: 3600, interval: 60, plannedSeconds: 8 * 3600, complete: false });
  const report = analyse(foldJournal(running));
  assert.equal(report.short, true, 'it has plainly not reached eight hours');
  assert.equal(report.complete, false);
  assert.deepEqual(
    report.checks.filter((c) => !c.ok).map((c) => c.name),
    [],
    'an unfinished run is not a failed one',
  );
  assert.match(
    report.checks.find((c) => c.name === 'the run reached the length it was asked for')!.detail,
    /no end record yet/,
  );
});

test('a run too short to judge says so, without blunting the checks', () => {
  // Two minutes is not enough to conclude anything about drift or leaks, and
  // the report says so — but a dead audio thread is visible in two minutes, so
  // the caveat must not turn a real failure into a pass.
  const healthy = analyse(foldJournal(build({ seconds: 120, interval: 15 })));
  assert.equal(healthy.tooShort, true);
  assert.deepEqual(healthy.checks.filter((c) => !c.ok).map((c) => c.name), []);
  assert.match(renderReport(healthy), /too short to conclude/);

  const broken = analyse(foldJournal(build({ seconds: 120, interval: 15, audio: false })));
  assert.deepEqual(
    broken.checks.filter((c) => !c.ok).map((c) => c.name),
    ['the audio never dropped out'],
  );
});

test('an empty journal does not throw', () => {
  const report = analyse(foldJournal([]));
  assert.equal(report.samples, 0);
  assert.equal(report.checks.length > 0, true);
  assert.doesNotThrow(() => renderReport(report));
});

test('a journal is read back line by line, and a torn last line is skipped', () => {
  const records = build({ seconds: 300, interval: 60 });
  const text = records.map(serialiseRecord).join('');
  const whole = parseJournal(text);
  assert.equal(whole.records.length, records.length);
  assert.equal(whole.torn, 0);

  // A process killed mid-write leaves a half-written line. It must cost the
  // last record and nothing else.
  const torn = parseJournal(`${text}{"kind":"sample","seg":0,"at":36`);
  assert.equal(torn.records.length, records.length);
  assert.equal(torn.torn, 1);
  assert.equal(analyse(foldJournal(torn.records)).samples, records.filter((r) => r.kind === 'sample').length);
});

test('the report says what it cannot prove, every time', () => {
  const markdown = renderReport(analyse(foldJournal(build({ seconds: 3600 }))), {
    journal: '/tmp/soak.jsonl',
    log: '/tmp/soak.log',
  });
  assert.match(markdown, /## What this run cannot prove/);
  assert.match(markdown, /SwiftShader/);
  assert.match(markdown, /null sink/);
  assert.match(markdown, /## Checks/);
  assert.match(markdown, /## Headline numbers/);
  assert.match(markdown, /journal `\/tmp\/soak\.jsonl`/);
});

test('a check that failed is the first thing in the report', () => {
  const markdown = renderReport(analyse(foldJournal(build({ seconds: 3600, framesPerInterval: 0 }))));
  assert.match(markdown, /\*\*1 check\(s\) failed\*\*/);
  assert.match(markdown, /\| \*\*FAIL\*\* \|/);
});
