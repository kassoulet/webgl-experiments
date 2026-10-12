// Reading a soak: what the journal means. Deliberately free of the browser, the
// filesystem and the clock, so the conclusions an eight-hour run draws are
// themselves testable — `tests/soak.test.ts` feeds this synthetic journals
// (a leak, a stall, a silence, a machine that slept) and asserts what it
// concludes, which is the only way to trust a report nobody can re-run cheaply.
//
// The journal is append-only JSONL, one record per line, written as the soak
// goes. That is the whole point: a run killed at hour six still has six hours of
// evidence on disk, and `tools/soak-report.ts` renders it.
//
// `tools/soak.ts` is the writer; this is everything that reads what it wrote.

/**
 * The journal's format version. Bump it when a record's shape changes in a way
 * that older readers would misread, so a report never silently mixes versions.
 */
export const JOURNAL_VERSION = 1;

// --- the journal -------------------------------------------------------------

export interface SoakStartRecord {
  kind: 'start';
  version: number;
  /** When the run began, as an ISO wall-clock timestamp. */
  at: string;
  seed: string;
  /** Seconds between samples. */
  interval: number;
  /** How long the run intends to last, or null for open-ended. */
  plannedSeconds: number | null;
  /** The viewport the launch asked for. */
  windowSize: string;
  /** Where the build being soaked came from. */
  site: string;
}

/** One look at the running piece. Every field is read from the page. */
export interface SoakSampleRecord {
  kind: 'sample';
  /** Which browser session produced it (0 for the first; a relaunch increments). */
  seg: number;
  /** Host seconds since the run began — survives a relaunch, which `wall` does not. */
  at: number;
  /** The page's own wall clock, `performance.now()/1000`; resets with the page. */
  wall: number;
  /** The journey clock. It *is* the audio context's clock (main.ts). */
  clock: number;
  /** Cumulative loudness messages from the meter worklet: the audio thread is
   *  processing, not merely that the device clock is moving. */
  messages: number;
  /** Cumulative voices started: the scheduler is still producing. */
  voices: number;
  /** Bars scheduled and not yet played. Zero would mean the schedule ran dry,
   *  which is a different failure from the clock simply not moving. */
  barsQueued: number;
  /** Live short-term loudness, null until the meter has heard enough. */
  lufs: number | null;
  truePeakDb: number | null;
  trimDb: number | null;
  heapMb: number;
  nodes: number | null;
  listeners: number | null;
  frames: number;
  fps: number;
  scale: number;
  iterations: number;
}

/** A gap: the browser died or stopped answering, and the soak came back. */
export interface SoakOutageRecord {
  kind: 'outage';
  /** The session that ended. */
  seg: number;
  at: number;
  /** How long the run was blind, in seconds. */
  seconds: number;
  reason: string;
}

/** A fresh offline render of the piece, measured. The anchor for loudness. */
export interface SoakLoudnessRecord {
  kind: 'loudness';
  seg: number;
  at: number;
  /** Seconds of the piece rendered, and how long the render took. */
  seconds: number;
  tookMs: number;
  lufs: number;
  truePeakDb: number;
  rms: number;
  peak: number;
}

/** Something the page or the browser said, kept because a soak cannot ask later. */
export interface SoakNoteRecord {
  kind: 'note';
  seg: number;
  at: number;
  level: string;
  text: string;
}

export interface SoakEndRecord {
  kind: 'end';
  at: number;
  reason: 'planned' | 'failed' | 'stopped';
  message?: string;
}

export type JournalRecord =
  | SoakStartRecord
  | SoakSampleRecord
  | SoakOutageRecord
  | SoakLoudnessRecord
  | SoakNoteRecord
  | SoakEndRecord;

/** One line of the journal. The writer appends exactly this. */
export function serialiseRecord(record: JournalRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * Parse a journal. A torn final line is expected, not an error: the process can
 * be killed between the write and the flush. Anything unparseable is counted and
 * skipped rather than throwing, because losing the last line must not lose the
 * run.
 */
export function parseJournal(text: string): { records: JournalRecord[]; torn: number } {
  const records: JournalRecord[] = [];
  let torn = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as JournalRecord);
    } catch {
      torn++;
    }
  }
  return { records, torn };
}

// --- folding it back into the run -------------------------------------------

/** Samples from one browser session. A relaunch starts a new segment, because
 *  the page's clocks restart with it and continuity must be judged within one. */
export interface SoakSegment {
  index: number;
  samples: SoakSampleRecord[];
  /** Host seconds, from the first sample to the last. */
  from: number;
  to: number;
  /** The outage that ended this session, or null for the session still running. */
  outage: SoakOutageRecord | null;
}

export interface SoakRun {
  start: SoakStartRecord | null;
  samples: SoakSampleRecord[];
  loudness: SoakLoudnessRecord[];
  outages: SoakOutageRecord[];
  notes: SoakNoteRecord[];
  end: SoakEndRecord | null;
  segments: SoakSegment[];
  /** Lines that did not parse, kept so the report can say a run was cut mid-write. */
  torn: number;
}

/** Fold the journal's records into the run they describe. */
export function foldJournal(records: JournalRecord[]): SoakRun {
  const run: SoakRun = {
    start: null,
    samples: [],
    loudness: [],
    outages: [],
    notes: [],
    end: null,
    segments: [],
    torn: 0,
  };
  const bySegment = new Map<number, SoakSegment>();

  const segmentFor = (index: number, at: number): SoakSegment => {
    let segment = bySegment.get(index);
    if (!segment) {
      segment = { index, samples: [], from: at, to: at, outage: null };
      bySegment.set(index, segment);
      run.segments.push(segment);
    }
    return segment;
  };

  for (const record of records) {
    switch (record.kind) {
      case 'start':
        if (!run.start) run.start = record;
        break;
      case 'sample': {
        run.samples.push(record);
        const segment = segmentFor(record.seg, record.at);
        segment.samples.push(record);
        segment.to = record.at;
        break;
      }
      case 'outage': {
        run.outages.push(record);
        const segment = segmentFor(record.seg, record.at);
        segment.outage = record;
        break;
      }
      case 'loudness':
        run.loudness.push(record);
        segmentFor(record.seg, record.at);
        break;
      case 'note':
        run.notes.push(record);
        segmentFor(record.seg, record.at);
        break;
      case 'end':
        run.end = record;
        break;
    }
  }
  run.segments.sort((a, b) => a.index - b.index);
  return run;
}

// --- what the run has to say -------------------------------------------------

export interface SoakCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** One bucket of the timeline: an hour of an eight-hour run, readable at a glance. */
export interface SoakBucket {
  /** Hours into the run. */
  hour: number;
  samples: number;
  /** Frames drawn during the bucket, and the rate over the bucket's own span. */
  frames: number;
  fps: number;
  heapMb: number | null;
  /** Range of the live short-term loudness readings taken in this bucket. */
  lufs: [number, number] | null;
  /** Range of the leveller's trim in this bucket. */
  trimDb: [number, number] | null;
}

/** The two captures the soak took, if it got as far as taking them. */
export interface SoakPicture {
  /** Mean luminance of the first and last frames, and their difference per pixel. */
  firstMean: number;
  lastMean: number;
  lastMax: number;
  differing: number;
}

export interface SoakReport {
  seed: string;
  startedAt: string | null;
  /** Seconds the run was asked to last, or null if open-ended. */
  plannedSeconds: number | null;
  /** Seconds from the start of the run to the last look taken. */
  ranSeconds: number;
  /** How long the page took to come up and start playing before the first look. */
  startupSeconds: number;
  /** Seconds actually covered by samples, i.e. excluding outages. */
  uptimeSeconds: number;
  downSeconds: number;
  segments: number;
  samples: number;
  frames: number;
  fps: number;
  /** The worst interval-to-interval pause in the page's own wall clock: a
   *  throttle, a suspend, or a machine that slept. */
  worstPause: { at: number; seconds: number } | null;
  /** Pause time in total, across the run. */
  pausedSeconds: number;
  heap: { min: number; max: number; last: number } | null;
  /** Median heap of the settled half's first and last tenth: the slow-leak test. */
  heapTrend: { firstMb: number; lastMb: number; deltaMb: number } | null;
  nodes: { from: number; to: number } | null;
  listeners: { from: number; to: number } | null;
  trim: { min: number; max: number; settledRange: number; readings: number } | null;
  liveLufs: { min: number; max: number; readings: number } | null;
  loudness: SoakLoudnessRecord[];
  outages: SoakOutageRecord[];
  errors: SoakNoteRecord[];
  timeline: SoakBucket[];
  checks: SoakCheck[];
  /** Whether the journal ends with a proper `end` record. */
  complete: boolean;
  /** True when the run has too little of it to say anything about drift. */
  tooShort: boolean;
  /** True when the run asked for a length and did not reach it. */
  short: boolean;
}

// Thresholds. Each is a decision, so each is named and explained rather than
// buried in a comparison.
//
// The heap: a run is watched for growth that never comes back, not for a
// constant. Twelve megabytes of wander over eight hours is allocator noise; more
// is a leak worth looking at. The trend is the sensitive one and so is tighter:
// it compares medians, so a single allocation spike cannot move it, and a heap
// that ends a few megabytes above where it started is growing. Three megabytes
// over the settled half is roughly three times the noise a forced collection
// leaves behind (the six-minute run wandered 0.3M), and it catches the slowest
// leak worth naming: a megabyte an hour, eight megabytes a day, in a piece built
// to be left open.
//
// Both are measured from the *second half* of the run. The opening minutes are
// not a leak, they are the app allocating what it needs — the reverb impulse,
// the convolution's buffers, the meter's arrays — and a soak that called that
// growth would fail every healthy run it ever made. The full range is still
// reported; it is only the verdict that waits for the piece to settle.
const HEAP_SPREAD_MB = 12;
const HEAP_TREND_MB = 3;
// The DOM: the HUD builds nodes and listeners for toasts and the controls. A
// piece that keeps them is leaking; a piece that reuses them is not.
const NODE_GROWTH = 200;
const LISTENER_GROWTH = 50;
// The leveller: its trim may move all it likes — that is the point of a leveller
// — but it must settle, and never run to its own rails.
const TRIM_SETTLED_RANGE_DB = 6;
const TRIM_RAIL_DB = 20;
// Loudness: spec §2's "around −18 to −16 LUFS" with headroom, and the region a
// report is willing to call the piece. Wide on purpose: it asks whether the
// master is the piece at all, not whether it is on target to a tenth.
const LUFS_FLOOR = -24;
const LUFS_CEILING = -10;
const LUFS_SPREAD = 6;
// Per interval: the clock may not lose more than this against the page's own
// wall clock, or the audio thread stopped keeping up. One second is far below
// the interval, so a stall hides nowhere.
const CLOCK_DEFICIT_S = 1;
// A pause longer than this in the page's wall clock is the browser (or the
// machine) having stopped running the page, not a slow frame.
const PAUSE_S = 5;
// Below this, the run has not run long enough for drift or leaks to mean much.
const MIN_MEANINGFUL_S = 600;
// A run that asked for a length must come within this much of it.
const COMPLETION = 0.98;

/** Summarise a set of numbers, or null if there are none. */
function range(values: number[]): [number, number] | null {
  if (!values.length) return null;
  return [Math.min(...values), Math.max(...values)];
}

function median(values: number[]): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? Number.NaN;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Judge a run. `picture` is optional because a run that was killed has no
 * captures; every check that needs one is simply not made rather than passed.
 */
export function analyse(run: SoakRun, picture?: SoakPicture): SoakReport {
  const samples = run.samples;
  const checks: SoakCheck[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  const first = samples[0];
  const last = samples[samples.length - 1];
  // The run lasts from the start record to the last look taken. Measuring from
  // the first *sample* would report a two-minute run as one minute, because the
  // browser spends the opening seconds loading, compiling shaders and starting
  // the audio — and then blame the run for not reaching its planned length.
  const ranSeconds = last ? last.at : (run.end?.at ?? 0);
  /** How long the page took to come up and start playing before the first look. */
  const startupSeconds = first?.at ?? 0;
  const tooShort = ranSeconds < MIN_MEANINGFUL_S || samples.length < 3;

  // --- intervals: the run is judged pair by pair, within one session --------
  let worstDeficit = 0;
  let worstDeficitAt = 0;
  let stalledClock = 0;
  let stalledRender = 0;
  const stallsAt: number[] = [];
  let silentAfterStart = 0;
  const quietAt: number[] = [];
  let worstPause: { at: number; seconds: number } | null = null;
  let pausedSeconds = 0;
  let frames = 0;
  // The clock is judged within a session, never across one: a relaunch restarts
  // the page's clocks, so comparing the run's first sample with its last would
  // call a healthy interrupted run a clock failure.
  let worstSkewRatio = 0;
  let worstSkew = 0;
  let worstSkewWall = 0;
  let worstSkewAt = 0;

  for (const segment of run.segments) {
    for (let i = 1; i < segment.samples.length; i++) {
      const before = segment.samples[i - 1];
      const now = segment.samples[i];
      if (!before || !now) continue;
      const wallGain = now.wall - before.wall;
      const hostGain = now.at - before.at;
      const clockGain = now.clock - before.clock;

      // The page was not scheduled: the host clock moved and the page's did not.
      const pause = hostGain - wallGain;
      if (pause > PAUSE_S) {
        pausedSeconds += pause;
        if (!worstPause || pause > worstPause.seconds) worstPause = { at: now.at, seconds: pause };
      }
      // ...and the audio thread lost time against the page's own clock.
      const deficit = wallGain - clockGain;
      if (deficit > worstDeficit) {
        worstDeficit = deficit;
        worstDeficitAt = now.at;
      }
      if (deficit > CLOCK_DEFICIT_S) stalledClock++;
      if (now.frames - before.frames <= 0) {
        stalledRender++;
        if (stallsAt.length < 8) stallsAt.push(now.at);
      }
      // A stream that has spoken must not fall silent: that is a dropout the
      // clock cannot show, because a context rendering silence still advances.
      if (before.lufs != null && now.lufs == null) {
        silentAfterStart++;
        if (quietAt.length < 8) quietAt.push(now.at);
      }
    }
    const end = segment.samples[segment.samples.length - 1];
    const start = segment.samples[0];
    if (start && end) {
      frames += end.frames - start.frames;
      const wall = end.wall - start.wall;
      const skew = Math.abs(end.clock - start.clock - wall);
      const ratio = skew / Math.max(1, wall);
      if (ratio > worstSkewRatio) {
        worstSkewRatio = ratio;
        worstSkew = skew;
        worstSkewWall = wall;
        worstSkewAt = end.at;
      }
    }
  }

  // --- the run's own shape --------------------------------------------------
  let uptimeSeconds = 0;
  for (const segment of run.segments) {
    const start = segment.samples[0];
    const end = segment.samples[segment.samples.length - 1];
    if (start && end) uptimeSeconds += end.at - start.at;
  }
  const downSeconds = run.outages.reduce((sum, o) => sum + o.seconds, 0);
  const fps = uptimeSeconds > 0 ? frames / uptimeSeconds : 0;  const plannedSeconds = run.start?.plannedSeconds ?? null;
  const short = plannedSeconds != null && ranSeconds < plannedSeconds * COMPLETION;
  const complete = run.end != null;

  // An unfinished run is not a failed one: a journal with no end record is a run
  // still going, or one that was killed — and `soak:report` is meant to be read
  // *while* the eight hours are still running. The fact that it has not reached
  // its length is reported either way; only a run that ended says so as a
  // verdict, and the header already says the journal has no end record.
  check(
    plannedSeconds != null ? 'the run reached the length it was asked for' : 'the run was open-ended',
    plannedSeconds == null || !complete || !short,
    plannedSeconds == null
      ? `ran ${formatSeconds(ranSeconds)} with no planned end`
      : `ran ${formatSeconds(ranSeconds)} of a planned ${formatSeconds(plannedSeconds)}` +
        `, the first look at ${formatSeconds(startupSeconds)}` +
        (!complete && short
          ? ` so far, and no end record yet`
          : short
            ? ` (${Math.round((ranSeconds / plannedSeconds) * 100)}% of it)`
            : ''),
  );

  // --- audio ----------------------------------------------------------------
  const messageDrops = countMessageDrops(run);
  const grainGrowth = samples.length
    ? (last?.voices ?? 0) - (first?.voices ?? 0)
    : 0;
  // Note what is *not* gated on `tooShort`: a dead audio thread, a stalled
  // renderer and a clock losing time are all visible in a few minutes, and
  // blunting them on a short run would let a broken one pass. `tooShort` adds a
  // caveat to the report instead — it never silences a measurement.
  // What the audio thread itself is doing: metering, sounding, producing. The
  // journey clock is deliberately *not* part of this — a clock that loses time
  // is one fault and is reported once, by the check below.
  check(
    'the audio never dropped out',
    samples.length >= 2 && messageDrops === 0 && silentAfterStart === 0 && grainGrowth > 0,
    samples.length < 2
      ? 'no samples to judge'
      : `${messageDrops} intervals with no metering, ${silentAfterStart} that went silent` +
        `${quietAt.length ? ` (from ${formatSeconds(quietAt[0] ?? 0)})` : ''}, ` +
        `${grainGrowth.toLocaleString('en')} voices started`,
  );

  // --- the clock ------------------------------------------------------------
  // Two questions, one subject: did the total drift, and did any single interval
  // lose time? The second is the sensitive one — a stall of a second inside a
  // fifteen-second interval hides completely in the total.
  check(
    'the journey clock kept time with the world',
    samples.length >= 2 &&
      (worstSkew < 2 || worstSkewRatio < 0.001) &&
      stalledClock === 0,
    samples.length < 2
      ? 'no samples to judge'
      : `worst drift ${worstSkew.toFixed(1)}s over ${formatSeconds(worstSkewWall)} of page time` +
        `${worstSkewAt ? ` (at ${formatSeconds(worstSkewAt)})` : ''}, ` +
        (stalledClock
          ? `${stalledClock} intervals lost more than a second ` +
            `(worst ${worstDeficit.toFixed(1)}s at ${formatSeconds(worstDeficitAt)})`
          : 'and no interval lost more than a second'),
  );

  // --- the picture ----------------------------------------------------------
  check(
    'the renderer never stopped drawing',
    samples.length >= 2 && stalledRender === 0 && frames > 0,
    samples.length < 2
      ? 'no samples to judge'
      : `${frames} frames in ${formatSeconds(uptimeSeconds)} (${fps.toFixed(2)} fps on a software renderer), ` +
        (stalledRender === 0
          ? 'every interval drew something'
          : `${stalledRender} intervals drew nothing (from ${stallsAt[0]}s)`),
  );
  if (picture) {
    check(
      'the picture is still a picture, not a frozen frame',
      picture.lastMean > 0.005 && picture.lastMax > 0.25 && picture.differing > 0.005,
      `mean ${picture.firstMean.toFixed(4)} → ${picture.lastMean.toFixed(4)}, ` +
        `max ${picture.lastMax.toFixed(3)}, differing from the first frame by ` +
        `${picture.differing.toFixed(4)} per pixel`,
    );
  }

  // --- memory ---------------------------------------------------------------
  const heaps = samples.map((s) => s.heapMb);
  const heapRange = range(heaps);
  const heap =
    heapRange && last ? { min: heapRange[0], max: heapRange[1], last: last.heapMb } : null;
  // The verdict looks at the settled half; the range above reports the whole run.
  const settledHeaps = heaps.slice(Math.floor(heaps.length / 2));
  const settledHeapsRange = range(settledHeaps);
  const heapTrend = trendOf(settledHeaps);
  check(
    'the JS heap does not grow without bound',
    settledHeapsRange != null &&
      settledHeapsRange[1] - settledHeapsRange[0] < HEAP_SPREAD_MB &&
      (!heapTrend || heapTrend.deltaMb < HEAP_TREND_MB),
    heaps.length
      ? `from ${(heapRange?.[0] ?? 0).toFixed(1)}M to ${(heapRange?.[1] ?? 0).toFixed(1)}M ` +
        `(last ${last?.heapMb.toFixed(1)}M), the settled half within ` +
        `${settledHeapsRange ? (settledHeapsRange[1] - settledHeapsRange[0]).toFixed(1) : '—'}M` +
        (heapTrend
          ? ` and trending ${heapTrend.deltaMb >= 0 ? '+' : ''}${heapTrend.deltaMb.toFixed(1)}M from its start to its end`
          : ' (too few samples to trend)')
      : 'no samples',
  );

  const nodeSeries = perSegmentDelta(run, (s) => s.nodes);
  const listenerSeries = perSegmentDelta(run, (s) => s.listeners);
  if (nodeSeries && listenerSeries) {
    check(
      'the page does not accumulate nodes or event listeners',
      nodeSeries.delta < NODE_GROWTH && listenerSeries.delta < LISTENER_GROWTH,
      `nodes ${nodeSeries.from} → ${nodeSeries.to}, listeners ${listenerSeries.from} → ${listenerSeries.to}` +
        (run.segments.length > 1 ? ` (largest change across ${run.segments.length} sessions)` : ''),
    );
  }

  // --- loudness -------------------------------------------------------------
  const trims = samples.map((s) => s.trimDb).filter((t): t is number => t != null);
  const settled = trims.slice(Math.floor(trims.length / 2));
  const settledRange = settled.length ? Math.max(...settled) - Math.min(...settled) : Number.NaN;
  const trimRange = range(trims);
  const trim =
    trimRange && trims.length
      ? { min: trimRange[0], max: trimRange[1], settledRange, readings: trims.length }
      : null;
  check(
    'the leveller settles and stays inside its range',
    trims.length >= 3 && settledRange < TRIM_SETTLED_RANGE_DB && trims.every((t) => Math.abs(t) < TRIM_RAIL_DB),
    trims.length
      ? `trim ${(trimRange?.[0] ?? 0).toFixed(1)}..${(trimRange?.[1] ?? 0).toFixed(1)} dB, ` +
        `within ${settledRange.toFixed(2)} dB over the second half` +
        // The check needs three readings before it can claim anything about
        // settling. A short run does not have them, and the range it prints for
        // the second half is then the range of nothing, which reads as a
        // perfect 0.00 dB rather than as the absence of a measurement.
        (trims.length < 3 ? ` (only ${trims.length} reading${trims.length === 1 ? '' : 's'}: too short a run to show settling)` : '')
      : 'the engine never reported a trim',
  );

  const lufsValues = run.loudness.map((l) => l.lufs);
  check(
    'the master lands in the loudness region, journey after journey',
    lufsValues.length > 0 &&
      lufsValues.every((l) => l > LUFS_FLOOR && l < LUFS_CEILING) &&
      Math.max(...lufsValues) - Math.min(...lufsValues) < LUFS_SPREAD,
    lufsValues.length
      ? `${lufsValues.length} renders: ${lufsValues.map((l) => l.toFixed(1)).join(', ')} LUFS ` +
        `(spread ${(Math.max(...lufsValues) - Math.min(...lufsValues)).toFixed(1)} LU)`
      : 'no render was made',
  );

  const liveLufs = range(samples.map((s) => s.lufs).filter((l): l is number => l != null));
  const livePeaks = samples.map((s) => s.truePeakDb).filter((p): p is number => p != null);
  check(
    'nothing clipped while it ran',
    run.loudness.every((l) => l.truePeakDb <= 0) && livePeaks.every((p) => p <= 0.5),
    run.loudness.length
      ? `worst true peak ${Math.max(...run.loudness.map((l) => l.truePeakDb)).toFixed(2)} dBTP ` +
        `across ${run.loudness.length} renders, ` +
        `${livePeaks.length ? `${Math.max(...livePeaks).toFixed(2)} dBTP live` : 'no live peak'}`
      : 'no render was made',
  );

  // --- errors and interruptions ---------------------------------------------
  const errors = run.notes.filter((n) => n.level === 'error');
  check(
    'no error was logged in all that time',
    errors.length === 0,
    errors.slice(0, 3).map((e) => e.text).join(' | ') || 'none',
  );
  check(
    'the piece ran without interruption',
    run.outages.length === 0 && run.end?.reason !== 'failed',
    run.outages.length === 0
      ? run.end?.reason === 'planned' || run.end == null
        ? 'the browser ran the whole time'
        : `the run ended ${run.end.reason}${run.end.message ? `: ${run.end.message}` : ''}`
      : run.outages
          .map((o) => `${formatSeconds(o.seconds)} at ${formatSeconds(o.at)} (${o.reason})`)
          .join('; '),
  );

  // --- the timeline ---------------------------------------------------------
  const timeline: SoakBucket[] = [];
  // Strictly inside the run: the sample that lands exactly on the hour belongs
  // to the hour it opens, not to one more bucket holding a single sample.
  for (let hour = 0; hour * 3600 < ranSeconds; hour++) {
    const inBucket = samples.filter(
      (s) => s.at >= hour * 3600 && s.at < (hour + 1) * 3600,
    );
    if (!inBucket.length) continue;
    const bucketFirst = inBucket[0];
    const bucketLast = inBucket[inBucket.length - 1];
    if (!bucketFirst || !bucketLast) continue;
    const span = bucketLast.at - bucketFirst.at;
    const drawn = bucketLast.frames - bucketFirst.frames;
    timeline.push({
      hour,
      samples: inBucket.length,
      frames: drawn,
      fps: span > 0 ? drawn / span : 0,
      heapMb: bucketLast.heapMb,
      lufs: range(inBucket.map((s) => s.lufs).filter((l): l is number => l != null)),
      trimDb: range(inBucket.map((s) => s.trimDb).filter((t): t is number => t != null)),
    });
  }

  return {
    seed: run.start?.seed ?? 'unknown',
    startedAt: run.start?.at ?? null,
    plannedSeconds,
    ranSeconds,
    startupSeconds,
    uptimeSeconds,
    downSeconds,
    segments: run.segments.length,
    samples: samples.length,
    frames,
    fps,
    worstPause,
    pausedSeconds,
    heap,
    heapTrend,
    nodes: nodeSeries ? { from: nodeSeries.from, to: nodeSeries.to } : null,
    listeners: listenerSeries ? { from: listenerSeries.from, to: listenerSeries.to } : null,
    trim,
    liveLufs: liveLufs ? { min: liveLufs[0], max: liveLufs[1], readings: samples.length } : null,
    loudness: run.loudness,
    outages: run.outages,
    errors,
    timeline,
    checks,
    complete,
    tooShort,
    short,
  };
}

/** Intervals where the meter stopped reporting: the audio thread stopped. */
function countMessageDrops(run: SoakRun): number {
  let drops = 0;
  for (const segment of run.segments) {
    for (let i = 1; i < segment.samples.length; i++) {
      const before = segment.samples[i - 1];
      const now = segment.samples[i];
      if (before && now && now.messages <= before.messages) drops++;
    }
  }
  return drops;
}

/** How the start and end of a series compare, by median tenth. */
function trendOf(values: number[]): { firstMb: number; lastMb: number; deltaMb: number } | null {
  if (values.length < 10) return null;
  const tenth = Math.max(1, Math.floor(values.length / 10));
  const firstMb = median(values.slice(0, tenth));
  const lastMb = median(values.slice(values.length - tenth));
  return { firstMb, lastMb, deltaMb: lastMb - firstMb };
}

/**
 * The change in a per-session reading, taken within each session and reported as
 * the largest. A relaunch resets the DOM counters to a lower number; comparing
 * across one would read as a shrink and hide a real growth in the other.
 */
function perSegmentDelta(
  run: SoakRun,
  read: (sample: SoakSampleRecord) => number | null,
): { from: number; to: number; delta: number } | null {
  let worst: { from: number; to: number; delta: number } | null = null;
  for (const segment of run.segments) {
    const values = segment.samples.map(read).filter((v): v is number => v != null);
    const from = values[0];
    const to = values[values.length - 1];
    if (from == null || to == null) continue;
    const delta = to - from;
    if (!worst || Math.abs(delta) > Math.abs(worst.delta)) {
      worst = { from, to, delta: Math.max(0, delta) };
    }
  }
  return worst;
}

export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  const sign = seconds < 0 ? '-' : '';
  const total = Math.abs(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) return `${sign}${hours}h${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${sign}${minutes}m${String(Math.floor(rest)).padStart(2, '0')}s`;
  return `${sign}${rest.toFixed(1)}s`;
}

const num = (value: number | null | undefined, digits = 2): string =>
  value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits);

const span = (pair: [number, number] | null, digits = 1): string =>
  pair ? `${pair[0].toFixed(digits)}..${pair[1].toFixed(digits)}` : '—';

/** The report: markdown, because it is written to be read a day later. */
export function renderReport(
  report: SoakReport,
  provenance: { journal?: string; log?: string; lastFrame?: string } = {},
): string {
  const failed = report.checks.filter((c) => !c.ok);
  const lines: string[] = [];

  lines.push(`# Soak report — seed "${report.seed}"`);
  lines.push('');
  lines.push(
    `**${failed.length ? `${failed.length} check(s) failed` : 'All checks passed'}** — ` +
      `${report.checks.length - failed.length}/${report.checks.length} checks, ` +
      `${formatSeconds(report.ranSeconds)} of run in ${report.segments} browser session(s)` +
      `${report.outages.length ? `, **${report.outages.length} interruption(s)**` : ''}.`,
  );
  lines.push('');
  if (!report.complete) {
    lines.push(
      '> This journal has no end record: the run was killed, is still going, or never ' +
        'finished. Everything below is what it had written to disk when this was read.',
    );
    lines.push('');
  }
  if (report.tooShort) {
    lines.push(
      '> The run is too short to conclude anything about drift, leaks or dropouts. ' +
        'The numbers are reported; the verdict is not.',
    );
    lines.push('');
  }

  lines.push('## Headline numbers');
  lines.push('');
  lines.push('| | |');
  lines.push('| --- | --- |');

  const row = (label: string, value: string): void => {
    lines.push(`| ${label} | ${value} |`);
  };

  const planned =
    report.plannedSeconds == null ? '' : ` of ${formatSeconds(report.plannedSeconds)} planned`;
  const down = report.downSeconds ? `, ${formatSeconds(report.downSeconds)} of it down` : ', no gaps';
  const sessions = `${report.segments} session${report.segments === 1 ? '' : 's'}`;

  row('Started', report.startedAt ?? '—');
  row('Run length', `${formatSeconds(report.ranSeconds)}${planned}`);
  row(
    'Startup',
    report.startupSeconds
      ? `${formatSeconds(report.startupSeconds)} before the first look (loading, shaders, audio start)`
      : '—',
  );
  row('Sampled window', `${formatSeconds(report.uptimeSeconds)} covered by samples${down} (${sessions})`);
  row('Samples', String(report.samples));
  row('Frames', `${report.frames} (${report.fps.toFixed(2)} fps — software rendering)`);

  let heapText = report.heap
    ? `${num(report.heap.min, 1)}M .. ${num(report.heap.max, 1)}M, last ${num(report.heap.last, 1)}M`
    : '—';
  if (report.heapTrend) {
    const sign = report.heapTrend.deltaMb >= 0 ? '+' : '';
    heapText +=
      `, first tenth ${num(report.heapTrend.firstMb, 1)}M to last tenth ` +
      `${num(report.heapTrend.lastMb, 1)}M (${sign}${num(report.heapTrend.deltaMb, 1)}M)`;
  }
  row('JS heap', heapText);

  const nodeText = report.nodes ? `nodes ${report.nodes.from} to ${report.nodes.to}` : 'nodes —';
  const listenerText = report.listeners
    ? `listeners ${report.listeners.from} to ${report.listeners.to}`
    : 'listeners —';
  row('DOM', `${nodeText}, ${listenerText}`);

  const trimText = report.trim
    ? `${num(report.trim.min, 1)}..${num(report.trim.max, 1)} dB ` +
      `(settled to ${num(report.trim.settledRange, 2)} dB)`
    : '—';
  row('Leveller trim', trimText);

  const liveText = report.liveLufs
    ? `${num(report.liveLufs.min)}..${num(report.liveLufs.max)} LUFS over ` +
      `${report.liveLufs.readings} readings`
    : '—';
  row('Live loudness', liveText);

  const pauseText = report.worstPause
    ? `${report.pausedSeconds.toFixed(0)}s in total, worst ` +
      `${report.worstPause.seconds.toFixed(1)}s at ${formatSeconds(report.worstPause.at)}`
    : 'none over 5s';
  row('Page pauses', pauseText);
  lines.push('');

  lines.push('## Checks');
  lines.push('');
  lines.push('| Result | Check | What was measured |');
  lines.push('| --- | --- | --- |');
  for (const entry of report.checks) {
    lines.push(`| ${entry.ok ? 'ok' : '**FAIL**'} | ${entry.name} | ${entry.detail} |`);
  }
  lines.push('');

  if (report.timeline.length > 1) {
    lines.push('## Timeline');
    lines.push('');
    lines.push('| Hour | Samples | Frames | fps | Heap | Live LUFS | Trim |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const bucket of report.timeline) {
      lines.push(
        `| ${bucket.hour} | ${bucket.samples} | ${bucket.frames} | ${bucket.fps.toFixed(2)} | ` +
          `${num(bucket.heapMb, 1)}M | ${span(bucket.lufs)} | ${span(bucket.trimDb)} |`,
      );
    }
    lines.push('');
  }

  if (report.loudness.length) {
    lines.push('## Offline renders (the loudness anchor)');
    lines.push('');
    lines.push('| At | Rendered | LUFS | True peak | RMS | Took |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const render of report.loudness) {
      lines.push(
        `| ${formatSeconds(render.at)} | ${render.seconds}s | ${render.lufs.toFixed(2)} | ` +
          `${render.truePeakDb.toFixed(2)} dBTP | ${render.rms.toFixed(4)} | ` +
          `${(render.tookMs / 1000).toFixed(1)}s |`,
      );
    }
    lines.push('');
  }

  if (report.outages.length) {
    lines.push('## Interruptions');
    lines.push('');
    for (const outage of report.outages) {
      lines.push(
        `- at ${formatSeconds(outage.at)}, for ${formatSeconds(outage.seconds)}: ${outage.reason}`,
      );
    }
    lines.push('');
  }

  if (report.errors.length) {
    lines.push('## Errors logged');
    lines.push('');
    for (const error of report.errors.slice(0, 20)) {
      lines.push(`- at ${formatSeconds(error.at)}: ${error.text.slice(0, 400)}`);
    }
    lines.push('');
  }

  lines.push('## What this run cannot prove');
  lines.push('');
  lines.push(
    '- It ran headless, on **SwiftShader** — a software renderer. The frame rate here says ' +
      'nothing about a real GPU, and the dynamic resolution above it barely moves.',
  );
  lines.push(
    '- The audio device is Chrome\'s null sink: the graph is scheduled and metered for real, ' +
      'but nothing is heard, so this cannot speak for what it sounds like.',
  );
  lines.push(
    '- It is one tab on one machine. Spec §6 asks for Chrome, Firefox and Safari on a ' +
      'mid-range laptop; this is one of the three.',
  );
  lines.push('');

  const places = [
    provenance.journal && `journal \`${provenance.journal}\``,
    provenance.log && `log \`${provenance.log}\``,
    provenance.lastFrame && `last frame \`${provenance.lastFrame}\``,
  ].filter((line): line is string => Boolean(line));
  if (places.length) {
    lines.push('## Provenance');
    lines.push('');
    for (const place of places) lines.push(`- ${place}`);
    lines.push('');
  }

  return lines.join('\n');
}
