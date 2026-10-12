#!/usr/bin/env node
// A real-browser smoke test, headless: load the page over HTTP, click "Begin"
// like a person would, let it run, then check what actually happened — script
// errors, WebGL2, frames drawn, the clock advancing, the flash cap holding,
// and a screenshot that is decoded here and measured. A clean log proves
// nothing about a picture; a decoded PNG does.
//
// Aurora's shape differs from the sibling apps' (there is no skip key and the
// sleep timer arms through the diagnostic hook), so the checks are aurora's:
// the dawn opening is quiet and the chorus is a different, brighter picture,
// found by asking the conductor rather than by waiting for it.
//
//   npm run smoke            (which compiles tools/ and runs the build)
//   ... [--seconds 8] [--seed other] [--keep]
//
// Exits non-zero if a hard check fails.

import { promises as fs, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { launchChrome, type Chrome, type Harness } from './chrome.ts';
import { decodePng, analyse, regionMean } from './png.ts';

// The package root, whether this file is running from `tools/` (a node with
// TypeScript support) or from `tools-dist/tools/` (one without): same depth, so
// stripping the build directory off the end gives the same answer either way.
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url))).replace(/\/tools-dist$/, '');
const ARTIFACTS = join(ROOT, '.smoke');
/** The smoke test runs the *build*, not the sources: this is what ships. */
const SITE = join(ROOT, 'dist');

const args = process.argv.slice(2);
const seconds = Number(readArg('--seconds') ?? 8);
const keep = args.includes('--keep');
// A fixed seed by default: two runs of the smoke test then render the same
// moment of the same set, which is what makes its numbers comparable.
const seed = readArg('--seed') ?? 'smoke-test';

function readArg(name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

// --- the run -----------------------------------------------------------------

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

interface AuroraStats {
  started: boolean;
  asleep: boolean;
  audioOnly: boolean;
  clock: number;
  frames: number;
  pulse: number;
  piece?: { section: string; bpm: number; bar: number; key: string; chord: string; palette: string };
}

async function main(): Promise<void> {
  if (!existsSync(join(SITE, 'index.html'))) {
    console.error(`no build in ${SITE}; run \`npm run build\` first (npm run smoke does it for you)`);
    process.exit(2);
  }

  let harness: Harness;
  try {
    harness = await launchChrome({ site: SITE, artifacts: ARTIFACTS, keepProfile: keep });
  } catch (error) {
    console.error(`could not start a browser: ${(error as Error).message}`);
    process.exit(2);
  }
  const client: Chrome = harness.chrome;
  const url = `${harness.origin}/#s=${encodeURIComponent(seed)}`;
  console.log(`serving ${ROOT} at ${url}`);

  try {
    await harness.go(seed);
    // Ready means loaded *and* the enter screen drawn: the diagnostic hook only
    // exists once main.ts has run.
    const ready = await harness.loaded();
    check('the page loads', ready);

    const before = await client.evaluate<string>(
      'JSON.stringify({ seed: __aurora.getSeed(), started: document.getElementById("hud").classList.contains("hidden") })',
    );
    check('it has a seed and is not playing yet', /"started":true/.test(before), before);

    // Click Begin the way a person does, so the browser sees a real gesture.
    const centre = await client.centreOf('start');
    await client.click(centre.x, centre.y);

    const readStats = async (): Promise<AuroraStats> =>
      JSON.parse(await client.evaluate<string>(
        'JSON.stringify((() => { const c = __aurora.conductor; const e = __aurora.engine; const r = __aurora.renderer;' +
        'const t = e.getStats().clock; return { started: document.getElementById("enter").classList.contains("hidden"),' +
        'asleep: e.asleepState(), clock: t, piece: __aurora.pieceAt(t), pulse: c.stateAt(t).pulse }; })())',
      )) as AuroraStats;

    // Software rendering (SwiftShader) is slow by nature, so wait for the
    // evidence we need (the clock running past a second) rather than a fixed
    // wall-clock. `--seconds` still sets the minimum settle time; the cap only
    // exists so a genuinely broken app fails instead of hanging.
    const settleUntil = Date.now() + seconds * 1000;
    const deadline = Date.now() + Math.max(seconds, 60) * 1000;
    let stats = await readStats();
    for (;;) {
      const settled = Date.now() >= settleUntil;
      const evidence = stats.clock > 1;
      if ((settled && evidence) || Date.now() >= deadline) break;
      await delay(500);
      stats = await readStats();
    }
    check('the app started and the audio clock is running', stats.started && stats.clock > 1, `clock ${stats.clock?.toFixed?.(2)}s`);
    const piece = stats.piece;
    check(
      'the set has a key, a chord, a section and a bar',
      Boolean(piece?.chord && piece.key && piece.section),
      JSON.stringify(piece),
    );
    check(
      'the set is synth-pop on its own grid',
      piece !== undefined &&
        /^(dawn|verse|chorus|bridge|finale)$/.test(piece.section) &&
        piece.bpm >= 108 &&
        piece.bpm <= 128 &&
        piece.bar >= 0,
      `${piece?.section} at ${piece?.bpm} bpm, bar ${piece?.bar}`,
    );
    check('no script errors on start', client.errors.length === 0, client.errors.slice(0, 3).join(' | '));

    // The picture itself.
    const buffer = await client.screenshot();
    await fs.mkdir(ARTIFACTS, { recursive: true });
    const shotPath = join(ARTIFACTS, 'smoke.png');
    await fs.writeFile(shotPath, buffer);
    const image = decodePng(buffer);
    const measured = analyse(image);
    check(
      'the screenshot is not black',
      measured.mean > 0.005 && measured.max > 0.25,
      `mean ${measured.mean.toFixed(4)}, max ${measured.max.toFixed(3)}, lit ${(measured.litFraction * 100).toFixed(1)}%`,
    );
    // An aurora picture is coloured by definition: a grey one is a shader that
    // fell over, and a flat one is a constant with a noise texture on top.
    check(
      'the picture is an aurora, not grey',
      measured.stdev > 0.02 && measured.colourFraction > 0.2,
      `stdev ${measured.stdev.toFixed(4)}, coloured ${(measured.colourFraction * 100).toFixed(1)}%`,
    );
    check(
      'the picture is not blown out',
      measured.mean < 0.75 && measured.max <= 1,
      `mean ${measured.mean.toFixed(4)}, max ${measured.max.toFixed(3)}`,
    );

    // A chorus is a different picture from a dawn: hotter, brighter, more of
    // every layer. The conductor is time-addressable, so the moment is found by
    // asking it rather than by waiting for it — and `draw({ time })` pins the
    // frame loop to that instant, so the capture cannot race a redraw.
    const chorusAt = await client.evaluate<number>(`(() => {
      for (let t = 0; t < 3600; t += 2) {
        if (__aurora.pieceAt(t).section !== 'chorus') continue;
        let end = t;
        while (__aurora.pieceAt(end + 2).section === 'chorus') end += 2;
        return (t + end) / 2;
      }
      return 90;
    })()`);
    const chorusDrawn = await client.evaluate<string>(
      `JSON.stringify(__aurora.draw({ time: ${chorusAt} }))`,
    );
    await delay(300);
    const chorusBuffer = await client.screenshot();
    await fs.writeFile(join(ARTIFACTS, 'chorus.png'), chorusBuffer);
    const chorusImage = decodePng(chorusBuffer);
    const chorusMeasured = analyse(chorusImage);
    check(
      'a chorus is a different picture from a dawn',
      chorusMeasured.mean > measured.mean * 1.05 && chorusMeasured.colourFraction > 0.2,
      `dawn mean ${measured.mean.toFixed(4)} -> chorus mean ${chorusMeasured.mean.toFixed(4)} at ${chorusAt.toFixed(0)}s (draw: ${chorusDrawn})`,
    );
    check(
      'a chorus is not blown out either',
      chorusMeasured.mean < 0.7 && chorusMeasured.max <= 1,
      `mean ${chorusMeasured.mean.toFixed(4)}, max ${chorusMeasured.max.toFixed(3)}`,
    );
    // Back to following the set, or everything measured after this is a picture
    // of a moment an hour old.
    await client.evaluate('__aurora.draw({})');

    // The pulse peaks on the beat and never past the cap: the photosensitivity
    // rule (the cap is decided in src/profile.ts and asserted here against the
    // real page, where a bug in the wiring would still show).
    const pulses = await samplePulse(client, 40);
    const peakPulse = Math.max(...pulses);
    check(
      'the picture pulses, and stays inside its range',
      peakPulse > 0.01 && peakPulse <= 1,
      `peak pulse ${peakPulse.toFixed(4)} over ${pulses.length} samples`,
    );

    // Audio, not just objects: the engine exposes real stats once running.
    const audio = JSON.parse(
      await client.evaluate<string>(
        'JSON.stringify((() => { const s = __aurora.engine.getStats();' +
          'return { lufs: s.lufs, peak: s.truePeakDb, voices: s.voices, bars: s.bars, meter: s.meterAvailable }; })())',
      ),
    ) as { lufs: number; peak: number; voices: number; bars: number; meter: boolean };
    check(
      'the engine schedules real music',
      audio.bars >= 1 && audio.voices > 0,
      `${audio.bars} bars, ${audio.voices} voices`,
    );
    check(
      'the loudness meter is alive',
      audio.meter === true || Number.isFinite(audio.lufs),
      `${audio.lufs?.toFixed?.(1)} LUFS, meter ${audio.meter}`,
    );

    // Sleep (main.ts's suspendForSleep). Arm a short timer through the hook —
    // the UI's smallest step is fifteen minutes — and watch the set suspend.
    await client.evaluate('__aurora.armSleep(6)');
    let asleep = await readStats();
    for (let attempt = 0; attempt < 40 && !asleep.asleep; attempt++) {
      await delay(500);
      asleep = await readStats();
    }
    check('the sleep timer suspends the set', asleep.asleep === true, `asleep ${asleep.asleep} at clock ${asleep.clock?.toFixed?.(2)}s`);

    check('the new paths left no errors behind', client.errors.length === 0, client.errors.slice(0, 3).join(' | '));

    if (client.logs.length) {
      console.log('\n  console:');
      for (const entry of client.logs.slice(0, 12)) console.log(`    [${entry.level}] ${entry.text.slice(0, 160)}`);
    }
    console.log(`\n  screenshots: ${join(ROOT, '.smoke', 'smoke.png')}, ${join(ROOT, '.smoke', 'chorus.png')}`);
  } catch (error) {
    console.error(`\n  smoke test error: ${(error as Error).message}`);
    for (const entry of client.logs.slice(0, 20)) console.error(`    [${entry.level}] ${entry.text.slice(0, 200)}`);
    for (const failure of client.errors.slice(0, 10)) console.error(`    [error] ${String(failure).slice(0, 400)}`);
    throw error;
  } finally {
    await harness.close();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

/**
 * Sample the flash budget over a few beats. The page runs on its own clock, so
 * this polls it rather than trying to catch a beat: what is asserted is the
 * *range*, which is the claim the cap makes.
 */
async function samplePulse(client: Chrome, samples: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < samples; i++) {
    out.push(await client.evaluate<number>(
      '__aurora.conductor.stateAt(__aurora.engine.getStats().clock).pulse',
    ));
    await delay(60);
  }
  return out;
}

await main().catch((error) => {
  console.error(error);
  process.exit(2);
});
