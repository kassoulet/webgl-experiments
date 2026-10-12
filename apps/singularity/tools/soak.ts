#!/usr/bin/env node
// The long soak: the things only time shows. Spec §6 asks for audio continuity
// over eight hours with no dropout, and for the piece to stay inside a loudness
// band while the harmony moves under it. This runs the real build in a real
// browser and writes down what it saw, once every interval:
//
//   * the journey clock against the page's own wall clock — and, per interval,
//     how much time the audio thread lost, which is what a dropout looks like;
//   * the meter's message count, which proves the audio thread is *processing*
//     and not merely that the device clock is moving (a graph rendering silence
//     still advances the clock, so the two failures need two signals);
//   * grains scheduled and chords playing, so a scheduler that quietly stopped
//     producing shows up as a flat line;
//   * the frame count, the JS heap and the DOM counters, for stalls and leaks;
//   * the master's loudness, from the engine's own leveller and from fresh
//     offline renders spread across the run;
//   * the picture at the start and at the end, to check it is still a picture.
//
//   npm run soak -- --hours 8                 # the eight hours of spec §7
//   npm run soak -- --minutes 3 --interval 15 # a short run, for a change
//   npm run soak -- --hours 8 --detach        # survive the shell that started it
//   npm run soak -- --report-only             # render the newest journal, no browser
//
// Three things make it safe to leave alone:
//
//   * **The journal is append-only JSONL, written per sample.** A run killed at
//     hour six still has six hours of evidence, and the report is built by
//     reading the journal back — so a partial run reports on itself.
//   * **It recovers from the browser dying.** The page stops answering, so the
//     soak records an outage, relaunches and carries on: the question is whether
//     the *piece* survives eight hours. Every outage is counted, timed and
//     reported in the checks — never hidden in a gap.
//   * **`--detach` survives the shell that started it.** It re-executes itself
//     in its own session with its output in a log beside the journal, and prints
//     where all three are.
//
// What it cannot show is a real device, a real GPU, or Safari — the report says
// so on every run rather than leaving it implied. Exits non-zero if a check fails.

import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { launchChrome, type Chrome, type Harness } from './chrome.js';
import { analyse as analyseCapture, decodePng, meanDifference, type PNGImage } from './png.js';
import {
  JOURNAL_VERSION,
  analyse,
  foldJournal,
  parseJournal,
  renderReport,
  serialiseRecord,
  type JournalRecord,
  type SoakPicture,
  type SoakSampleRecord,
} from './soak-analysis.js';
import type { OfflineMeasurement } from '../src/offline.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url))).replace(/\/tools-dist$/, '');
const SITE = join(ROOT, 'dist');

const args = process.argv.slice(2);
const readArg = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const hoursArg = readArg('--hours');
const hours = hoursArg == null ? null : Number(hoursArg);
const minutes = hours != null ? hours * 60 : Number(readArg('--minutes') ?? 3);
const interval = Number(readArg('--interval') ?? 15);
const seed = readArg('--seed') ?? 'soak';
const outRoot = resolve(ROOT, readArg('--out') ?? join('.smoke', 'soak'));
const keep = args.includes('--keep');
const detach = args.includes('--detach');
/** Minutes between offline loudness renders; one is always taken at each end,
 *  so a run that is killed still has a loudness anchor on disk. */
const loudnessEveryMinutes = Number(readArg('--loudness-every') ?? 60);
/** How many times the browser may die before the run gives up. */
const maxOutages = Number(readArg('--max-outages') ?? 2);
const windowSize = readArg('--window-size') ?? '1280,720';

const totalSeconds = Math.max(30, Math.round(minutes * 60));

/**
 * A run gets its own files, named for when it started. The soak never deletes or
 * overwrites another run's journal: eight hours is too expensive to lose to a
 * mistyped command, and the report tool can read any of them.
 */
const stamp = readArg('--stamp') ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const journalPath = join(outRoot, `${stamp}-${seed.replace(/[^\w-]/g, '_')}.jsonl`);
const reportPath = journalPath.replace(/\.jsonl$/, '.md');
const logPath = journalPath.replace(/\.jsonl$/, '.log');
const lastFramePath = journalPath.replace(/\.jsonl$/, '-last.png');
const firstFramePath = journalPath.replace(/\.jsonl$/, '-first.png');

/** Fold a journal on disk into a report, and write the markdown beside it. */
function reportFrom(journal: string): { failed: number; total: number; torn: number } {
  const { records, torn } = parseJournal(readFileSync(journal, 'utf8'));
  const run = foldJournal(records);
  const picture = readPicture(journal);
  const built = analyse(run, picture ?? undefined);
  const frame = journal.replace(/\.jsonl$/, '-last.png');
  const markdown = renderReport(built, {
    journal,
    log: journal.replace(/\.jsonl$/, '.log'),
    lastFrame: existsSync(frame) ? frame : undefined,
  });
  writeFileSync(journal.replace(/\.jsonl$/, '.md'), markdown);
  return { failed: built.checks.filter((c) => !c.ok).length, total: built.checks.length, torn };
}

/**
 * The picture check needs the captures, which are not in the journal (they are
 * megabytes, not numbers). They are read back from disk if the run got far
 * enough to write them; a killed run simply has no picture check.
 */
function readPicture(journal: string): SoakPicture | null {
  const lastPath = journal.replace(/\.jsonl$/, '-last.png');
  const firstPath = journal.replace(/\.jsonl$/, '-first.png');
  if (!existsSync(lastPath) || !existsSync(firstPath)) return null;
  try {
    const first: PNGImage = decodePng(readFileSync(firstPath));
    const last: PNGImage = decodePng(readFileSync(lastPath));
    const a = analyseCapture(first);
    const b = analyseCapture(last);
    return {
      firstMean: a.mean,
      lastMean: b.mean,
      lastMax: b.max,
      differing: meanDifference(first, last),
    };
  } catch {
    return null;
  }
}

// --- --report-only: read the newest journal without starting anything -------

if (args.includes('--report-only')) {
  const requested = readArg('--journal');
  const newest =
    requested ??
    (existsSync(outRoot)
      ? readdirSync(outRoot)
          .filter((name) => name.endsWith('.jsonl'))
          .sort()
          .pop()
      : undefined);
  if (!newest) {
    console.error(`no journal in ${outRoot}`);
    process.exit(2);
  }
  const path = requested ? resolve(ROOT, requested) : join(outRoot, newest);
  const { failed, total, torn } = reportFrom(path);
  console.log(readFileSync(path.replace(/\.jsonl$/, '.md'), 'utf8'));
  console.log(`\n  ${total - failed}/${total} checks passed${torn ? `, ${torn} torn line(s)` : ''}`);
  process.exit(failed ? 1 : 0);
}

// --- --detach: hand the run to its own session ------------------------------

if (detach) {
  mkdirSync(outRoot, { recursive: true });
  const log = openSync(logPath, 'a');
  const child = spawn(
    process.execPath,
    [
      ...process.execArgv,
      fileURLToPath(import.meta.url),
      ...args.filter((a) => a !== '--detach'),
      '--stamp',
      stamp,
    ],
    { detached: true, stdio: ['ignore', log, log] },
  );
  child.unref();
  console.log(`\n  soaking ${(totalSeconds / 3600).toFixed(2)}h in the background, seed "${seed}"`);
  console.log(`  log      ${logPath}`);
  console.log(`  journal  ${journalPath}`);
  console.log(`  report   ${reportPath}`);
  console.log('  all three are written as it goes, so any of them is readable at any point');
  console.log('  read it now or tomorrow with:  npm run soak:report\n');
  process.exit(0);
}

// --- the run ----------------------------------------------------------------

/** Seconds since the host run began. Survives a relaunch; nothing else does. */
let hostStart = Date.now();
const hostNow = (): number => (Date.now() - hostStart) / 1000;

/** Append one record. Synchronous on purpose: the whole value of the journal is
 *  that it is on disk before the thing it describes goes wrong, and at one
 *  record per interval the cost is nothing. */
function journal(record: JournalRecord): void {
  appendFileSync(journalPath, serialiseRecord(record));
}

/** One look at the running piece, as it is read from the page. */
type Reading = Omit<SoakSampleRecord, 'kind' | 'seg' | 'at'>;

const sampleScript = `JSON.stringify((() => {
  const s = __singularity.stats();
  const num = (v) => (Number.isFinite(v) ? v : null);
  return {
    wall: performance.now() / 1000,
    clock: s.clock,
    messages: s.audio.messages,
    grains: s.audio.grains,
    chords: s.audio.chords,
    lufs: num(s.audio.lufs), truePeakDb: num(s.audio.truePeakDb), trimDb: num(s.audio.trimDb),
    frames: s.frames, fps: s.render.fps, scale: s.render.scale, steps: s.render.steps,
  };
})())`;

const fmt = (value: number | null, digits: number): string =>
  value == null ? '—' : value.toFixed(digits);

async function main(): Promise<void> {
  mkdirSync(outRoot, { recursive: true });
  hostStart = Date.now();

  journal({
    kind: 'start',
    version: JOURNAL_VERSION,
    at: new Date().toISOString(),
    seed,
    interval,
    plannedSeconds: totalSeconds,
    windowSize,
    site: SITE,
  });

  console.log(
    `\n  seed "${seed}", ${(totalSeconds / 3600).toFixed(2)}h planned, sampling every ${interval}s`,
  );
  console.log(`  journal  ${journalPath}`);

  const deadline = hostStart + totalSeconds * 1000;
  let harness = await open();
  let segment = 0;
  let outages = 0;
  let loudnessDue = hostNow();

  console.log('\n     at     clock      fps   frames    heap    nodes  trim     lufs (live)');

  try {
    while (Date.now() < deadline) {
      await delay(interval * 1000);
      if (Date.now() >= deadline) break;

      let reading: Reading;
      try {
        reading = await read(harness.chrome);
      } catch (error) {
        // The page stopped answering. That is an outage, and the run is only
        // worth continuing if it will say so plainly.
        const reason = (error as Error).message.slice(0, 200);
        outages++;
        console.log(`\n  the browser stopped answering: ${reason}`);
        await harness.close().catch(() => undefined);
        if (outages > maxOutages) {
          journal({ kind: 'outage', seg: segment, at: hostNow(), seconds: 0, reason });
          throw new Error(`the browser died ${outages} times; giving up`);
        }
        console.log(`  relaunching (outage ${outages} of ${maxOutages} allowed)`);
        const before = hostNow();
        harness = await open();
        segment++;
        // The new page restarts the journey at 0 with the same seed — the same
        // journey from the beginning, which is the property the seed-link tests
        // already cover. The downtime is recorded, not hidden in a gap.
        journal({
          kind: 'outage',
          seg: segment - 1,
          at: before,
          seconds: hostNow() - before,
          reason,
        });
        continue;
      }

      const at = hostNow();
      journal({ kind: 'sample', seg: segment, at, ...reading });
      console.log(
        `  ${String(Math.round(at)).padStart(5)}s ${reading.clock.toFixed(1).padStart(8)}s ` +
          `${String(reading.fps).padStart(5)} ${String(reading.frames).padStart(7)} ` +
          `${reading.heapMb.toFixed(1).padStart(6)}M ${String(reading.nodes ?? '-').padStart(7)} ` +
          `${fmt(reading.trimDb, 1).padStart(6)}dB ${fmt(reading.lufs, 2).padStart(7)}`,
      );

      if (at >= loudnessDue) {
        await measureLoudness(harness.chrome, segment, at);
        loudnessDue = at + loudnessEveryMinutes * 60;
      }
    }

    // --- the end of the run ---------------------------------------------------
    // A last look and a last loudness render, so the tail is recorded even when
    // the loop above ran out of time mid-interval.
    const last = await read(harness.chrome).catch(() => null);
    if (last) journal({ kind: 'sample', seg: segment, at: hostNow(), ...last });
    await measureLoudness(harness.chrome, segment, hostNow());
    const shot = await harness.chrome.screenshot().catch(() => null);
    if (shot) writeFileSync(lastFramePath, shot);
    journal({ kind: 'end', at: hostNow(), reason: 'planned' });
  } catch (error) {
    // Reached only when the run did not get to write its own end record: the
    // planned write is the last thing the try does, and the give-up path above
    // throws before writing one.
    journal({ kind: 'end', at: hostNow(), reason: 'failed', message: (error as Error).message });
    console.error(`\n  soak error: ${(error as Error).message}`);
  } finally {
    await harness.close().catch(() => undefined);
  }

  // The report is built by reading the journal back rather than from anything
  // held in memory: it then describes what was written, which is what a later
  // reader sees — and a bug in the writer cannot hide behind a second copy of
  // the same arithmetic. It owns every check, so nothing is decided twice.
  const { failed, total, torn } = reportFrom(journalPath);
  console.log(readFileSync(reportPath, 'utf8'));
  console.log(
    `\n  ${total - failed}/${total} checks passed${torn ? `, ${torn} torn journal line(s)` : ''}`,
  );
  console.log(`  report  ${reportPath}`);
  console.log(`  journal ${journalPath}`);
  if (existsSync(lastFramePath)) console.log(`  last frame ${lastFramePath}`);
  process.exit(failed ? 1 : 0);

  // --- helpers ---------------------------------------------------------------

  /** Launch, load and start the piece; returns once it is actually playing. */
  async function open(): Promise<Harness> {
    const fresh = await launchChrome({
      site: SITE,
      artifacts: outRoot,
      keepProfile: keep,
      windowSize,
    });
    await fresh.go(seed);
    if (!(await fresh.loaded(20000))) throw new Error('the app never came up');
    const box = await fresh.chrome.centreOf('enter-button');
    await fresh.chrome.click(box.x, box.y);
    if (!(await fresh.waitFor('__singularity.stats().started === true', 20000))) {
      throw new Error('the app never started playing');
    }
    // The HUD and the enter overlay fade out; capturing through them would
    // measure a half-faded panel instead of the picture.
    await fresh.waitFor(
      `['hud', 'toast', 'enter'].every((id) => {
         const el = document.getElementById(id);
         return !el || getComputedStyle(el).opacity === '0';
       })`,
      20000,
    );
    // The very first capture of the whole run, kept across a relaunch so the
    // end-to-end comparison is against the run's beginning and not a restart.
    if (!existsSync(firstFramePath)) {
      writeFileSync(firstFramePath, await fresh.chrome.screenshot());
    }
    return fresh;
  }

  /** Everything else in the log is noise unless the picture is up. */
  async function read(chrome: Chrome): Promise<Reading> {
    const stats = JSON.parse(await chrome.evaluate<string>(sampleScript)) as Omit<
      Reading,
      'heapMb' | 'nodes' | 'listeners'
    >;
    // Collect before reading the heap: what a soak looks for is memory the piece
    // is *holding*, and garbage nobody has swept is not that. (The offline
    // renders allocate tens of megabytes of audio buffers apiece, so without
    // this the number would measure this tool.)
    await chrome.send('HeapProfiler.collectGarbage').catch(() => undefined);
    const heapMb = JSON.parse(
      await chrome.evaluate<string>(
        'JSON.stringify((performance.memory?.usedJSHeapSize ?? 0) / 1048576)',
      ),
    ) as number;
    // The DOM counters come from the browser, not the page: nodes and listeners
    // that only ever go up are a leak the JS heap does not show.
    const counters = await chrome
      .send<{ nodes: number; jsEventListeners: number }>('Memory.getDOMCounters')
      .catch(() => null);
    return {
      ...stats,
      heapMb,
      nodes: counters?.nodes ?? null,
      listeners: counters?.jsEventListeners ?? null,
    };
  }

  /** Render the real engine offline and measure the master (src/offline.ts). */
  async function measureLoudness(chrome: Chrome, seg: number, at: number): Promise<void> {
    const started = Date.now();
    try {
      const measured = await chrome.evaluate<OfflineMeasurement>(
        `__singularity.offline({ seed: ${JSON.stringify(`${seed}-loud-${Math.round(at)}`)}, seconds: 30, measureFrom: 15 })`,
      );
      journal({
        kind: 'loudness',
        seg,
        at,
        seconds: measured.seconds,
        tookMs: Date.now() - started,
        lufs: measured.lufs,
        truePeakDb: measured.truePeakDb,
        rms: measured.rms,
        peak: measured.peak,
      });
      console.log(
        `         loudness render: ${measured.lufs.toFixed(2)} LUFS, ` +
          `${measured.truePeakDb.toFixed(2)} dBTP, ${measured.trimDb.toFixed(1)} dB trim ` +
          `(${((Date.now() - started) / 1000).toFixed(1)}s)`,
      );
    } catch (error) {
      // A failed render is worth knowing about but not worth stopping for: the
      // live meter in the table above is the run's other loudness evidence.
      const text = `offline render failed: ${(error as Error).message}`;
      journal({ kind: 'note', seg, at, level: 'error', text });
      console.log(`         ${text}`);
    }
  }
}

await main().catch((error) => {
  console.error(`\n  soak error: ${(error as Error).message}`);
  process.exit(2);
});
