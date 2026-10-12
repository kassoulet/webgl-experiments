#!/usr/bin/env node
// A real-browser smoke test, headless: load the page over HTTP, click "enter"
// like a person would, let it run, then check what actually happened — script
// errors, WebGL2, frames drawn, the clock advancing, the flash cap holding, and
// a screenshot that is decoded here and measured. A clean log proves nothing
// about a picture; a decoded PNG does.
//
// It drives the paths a reader actually takes and that nothing else reaches:
// the controls and the fade to sleep with its suspend and resume, the seed
// input and the URL fragment it reloads onto — including the same seed
// describing the same set an hour in, in a fresh page — and "copy link", whose
// clipboard write is recorded so the URL it hands over can be checked.
//
// The checks that are *this app's* are the scope ones. Everything else in here
// could have been copied from a sibling app wholesale; these could not, because
// there is no sibling app with an oscilloscope in it, and they are the only
// checks that would notice if the trace stopped being a measurement and became
// a drawing:
//
//   - the analyser is a real AnalyserNode and is feeding the renderer;
//   - the waveform it returns is not flat, so there is a signal to draw;
//   - the spectrum it returns is bass-heavy, which is a property of this music
//     and would be false of any invented spectrum;
//   - the deflection auto-ranges, so the same moment drawn at two gains is two
//     different pictures;
//   - the frame is as dark as the reference it was measured from, and the trace
//     is where the shader says it put it.
//
//   npm run smoke            (or: node .tools/smoke.mjs)
//   ... [--seconds 8] [--seed other] [--keep]

import { promises as fs, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { launchChrome, type Chrome, type Harness } from './chrome.ts';
import { decodePng, analyse, regionMean } from './png.ts';
import type { DescribedPiece, ForcedSection, PlayerStats } from '../src/types.ts';
import type { OfflineMeasurement } from '../src/offline.ts';
import { TARGET_LUFS, TRUE_PEAK_CEILING_DB } from '../src/audio/loudness.ts';
import { FLASH_DEPTH } from '../src/profile.ts';
import { SCOPE_BINS } from '../src/scope.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
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

/**
 * Where the shader puts things, as fractions of the frame from the top. The
 * shader works in uv.y from -1 to 1, so a row is `(1 - uv.y) / 2`; these are
 * the three bands the picture is built from, and the checks below assert that
 * the light is in the right one of them.
 */
const TRACE_BAND = [0.26, 0.52] as const;
const SPEC_BAND = [0.72, 0.97] as const;
/** The gap between the bottom of the graticule and the top of the spectrum, and
 *  the strip above the box. The deflection gain has nothing to do with either. */
const GAP_BAND = [0.58, 0.70] as const;
const ABOVE_BAND = [0.01, 0.08] as const;
/** Where the shader draws the trace's centre line, as a fraction of the frame's
 *  height: uv.y = BOX_Y maps to (1 - BOX_Y) / 2. */
const TRACE_ROW = (1 - 0.34) / 2;

// --- the run -----------------------------------------------------------------

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** What a page says about the set it is playing: the seed it took, the URL that
 *  carried it, and the set it describes at three times in it. */
interface JourneyReading {
  seed: string;
  hash: string;
  input: string;
  probes: { key: string; chord: string; section: string; bpm: number; bar: number }[];
}

const checks: Check[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

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
    await harness.go(`/#s=${encodeURIComponent(seed)}`);
    // Ready means loaded *and* the enter screen drawn: the diagnostic hook only
    // exists once main.ts has run.
    const ready = await harness.loaded();
    check('the page loads', ready);

    const beforeEnter = await client.evaluate<string>(
      'JSON.stringify({ seed: __jeffer.seed, started: __jeffer.stats().started })',
    );
    check('it has a seed and is not playing yet', /"started":false/.test(beforeEnter), beforeEnter);

    // Click enter the way a person does, so the browser sees a real gesture.
    await enter(client);

    const readStats = async (): Promise<PlayerStats> =>
      JSON.parse(await client.evaluate<string>('JSON.stringify(__jeffer.stats())')) as PlayerStats;

    // Software rendering (SwiftShader) is slow by nature — on a loaded machine
    // well under a frame a second — so wait for the evidence we need (frames
    // drawn, the clock running) rather than a fixed wall-clock. `--seconds`
    // still sets the minimum settle time; the cap only exists so a genuinely
    // broken renderer fails instead of hanging.
    const settleUntil = Date.now() + seconds * 1000;
    const frameDeadline = Date.now() + Math.max(seconds, 90) * 1000;
    let parsed = await readStats();
    for (;;) {
      const settled = Date.now() >= settleUntil;
      const evidence = parsed.frames >= 5 && parsed.clock > 1;
      if ((settled && evidence) || Date.now() >= frameDeadline) break;
      await delay(500);
      parsed = await readStats();
    }
    check('the renderer found WebGL2', parsed.render.available === true, `quality ${parsed.render.quality}`);
    check('frames were drawn', parsed.frames >= 4, `${parsed.frames} frames, ${parsed.render.fps} fps`);
    check(
      'the audio clock is running',
      parsed.clock > 1,
      `clock ${parsed.clock?.toFixed?.(2)}s, trim ${parsed.audio.trimDb?.toFixed?.(1)} dB`,
    );
    check(
      'the set has a key, a chord, a section and a bar',
      Boolean(parsed.piece?.chord && parsed.piece?.key && parsed.piece?.section),
      JSON.stringify(parsed.piece),
    );
    check(
      'the set is on the grid',
      /^(intro|build|groove|drop|break|peak)$/.test(parsed.piece?.section ?? '') &&
        parsed.piece.bpm >= 120 &&
        parsed.piece.bpm <= 134 &&
        parsed.piece.bar >= 0,
      `${parsed.piece?.section} at ${parsed.piece?.bpm} bpm, bar ${parsed.piece?.bar}`,
    );
    check('no script errors on start', client.errors.length === 0, client.errors.slice(0, 3).join(' | '));

    // The set as it stands before anything has touched this page, kept for the
    // seed-link check below. The skip key rewrites the schedule, so a page that
    // has been skipped through is not the set its seed alone would have played —
    // and comparing a *skipped* page against a *fresh* one would pass even if
    // every seed in the app played the same set.
    const untouched = await client.evaluate<string>(
      'JSON.stringify([0, 600, 3600].map((t) => __jeffer.pieceAt(t)))',
    );

    // --- the scope, which is the whole claim of this app --------------------
    check(
      'the analyser on the master is real and feeding the renderer',
      parsed.audio.scopeAvailable === true && parsed.render.scopeBins === SCOPE_BINS,
      `scopeAvailable ${parsed.audio.scopeAvailable}, ${parsed.render.scopeBins} bins ` +
        `(expected ${SCOPE_BINS}), scope ${parsed.audio.meterAvailable ? 'metered' : 'meter off'}`,
    );
    check(
      'the waveform is not flat, so there is a signal to draw',
      parsed.scope.peak > 0.01 && parsed.scope.rms > 0.002 && Number.isFinite(parsed.scope.peak),
      `peak ${parsed.scope.peak?.toFixed(4)}, rms ${parsed.scope.rms?.toFixed(5)}`,
    );
    check(
      'the waveform is signed and centred, as a waveform is',
      hasNegativeAndPositive(parsed.scope.wave) && parsed.scope.peak <= 1,
      `min ${minOf(parsed.scope.wave).toFixed(3)}, max ${maxOf(parsed.scope.wave).toFixed(3)}`,
    );
    // The measured reference spectrum has 62 Hz at full scale and 16 kHz at
    // nothing. A spectrum that is flat across the bins, or brightest at the top,
    // is not this music's spectrum, whatever else it is.
    const lowEnergy = meanOf(parsed.scope.spectrum, 0, SCOPE_BINS / 8);
    const highEnergy = meanOf(parsed.scope.spectrum, (SCOPE_BINS * 3) / 4, SCOPE_BINS);
    check(
      'the spectrum is bass-heavy, like the reference it was measured from',
      lowEnergy > highEnergy * 2 && lowEnergy > 0.01,
      `lowest eighth ${lowEnergy.toFixed(4)} vs top quarter ${highEnergy.toFixed(4)} ` +
        `(${(lowEnergy / Math.max(1e-6, highEnergy)).toFixed(1)}×)`,
    );
    check(
      'the spectrum is in range',
      maxOf(parsed.scope.spectrum) <= 1 && Number.isFinite(maxOf(parsed.scope.spectrum)),
      `max ${maxOf(parsed.scope.spectrum).toFixed(3)}`,
    );

    // The picture itself.
    const buffer = await client.screenshot();
    await fs.mkdir(ARTIFACTS, { recursive: true });
    const shotPath = join(ARTIFACTS, 'smoke.png');
    await fs.writeFile(shotPath, buffer);
    const image = decodePng(buffer);
    const measured = analyse(image);
    check(
      'the screenshot is not black',
      measured.mean > 0.004 && measured.max > 0.2,
      `mean ${measured.mean.toFixed(4)}, max ${measured.max.toFixed(3)}, lit ${(measured.litFraction * 100).toFixed(1)}%`,
    );
    // The reference video is 64.9% pure black, its frames sit between 0.0 and
    // 0.13 mean luminance, and between 47% and 100% of every frame is below a
    // 0.12 luma. A picture much brighter than that is not a picture of this
    // material, however good it looks. The dark fraction is measured with the
    // *same* 0.12 threshold `tmp/jeffer/frames.py` used, because a comparison
    // against a number taken with a different definition is not a comparison.
    const dark = darkFraction(image);
    check(
      'the frame is as dark as the reference',
      measured.mean <= 0.13 && dark >= 0.47,
      `mean ${measured.mean.toFixed(4)} (reference 0.00–0.13), ` +
        `dark ${(dark * 100).toFixed(1)}% (reference 47–100%)`,
    );
    // A two-thirds-black picture of a violet and a red is still a *coloured*
    // picture. A grey one means the palette never reached the shader.
    check(
      'the picture is coloured, not grey',
      measured.stdev > 0.01 && measured.colourFraction > 0.08,
      `stdev ${measured.stdev.toFixed(4)}, coloured ${(measured.colourFraction * 100).toFixed(1)}%`,
    );
    check(
      'the picture is not blown out',
      measured.mean < 0.6 && measured.max <= 1,
      `mean ${measured.mean.toFixed(4)}, max ${measured.max.toFixed(3)}`,
    );
    // Where the light *is*. The same moment drawn with the scope layer on and
    // with it off, both with the signal pinned, so the only thing that changed
    // is the layer under test. Subtracting leaves only what the scope put in the
    // frame.
    //
    // The measurement is then a row profile of that difference — the mean change
    // for each horizontal line — rather than a mean over a rectangle. A
    // rectangle average answers "is this band brighter than that band", and on
    // this picture it cannot: the colour field is a wash that puts a floor
    // under every band, and the trace is a line two pixels tall inside a band
    // fourteen per cent of the screen. The profile does not average the line
    // away, and where its peak lands *is* the answer to "is the trace where the
    // shader says it put it".
    // The analyser's own reading, as an *object*. It crosses the CDP boundary as
    // JSON text, so it has to be parsed here before it is handed back to
    // `draw`: `draw` reads `scope.wave`, and a string has no `wave`, so the
    // renderer is handed a frame with no signal in it and draws a flat line. The
    // checks below all still pass against a flat line — it sits exactly where the
    // shader draws the trace — which is how a suite this long can be green and
    // still never have seen a waveform.
    const signal = JSON.parse(
      await client.evaluate<string>('JSON.stringify(__jeffer.stats().scope)'),
    ) as Record<string, unknown>;
    const pinnedBins = await client.evaluate<number>(
      `__jeffer.draw({ time: 30, scope: ${JSON.stringify(signal)} }); __jeffer.stats().render.scopeBins`,
    );
    const scopeOn = await capture(client, { time: 30, scope: signal, layers: [1, 0.35, 0.8, 0.15] });
    const scopeOff = await capture(client, { time: 30, scope: signal, layers: [0, 0.35, 0.8, 0.15] });
    const lowGain = await capture(client, { time: 30, scope: signal, layers: [1, 0.35, 0.8, 0.15], scopeGain: 0.15 });
    const highGain = await capture(client, { time: 30, scope: signal, layers: [1, 0.35, 0.8, 0.15], scopeGain: 2.5 });
    // The same frame drawn twice, identically. This is the noise floor: the
    // picture has tape noise in it, so two captures of the same moment are never
    // quite the same, and a check that compares one band's change against a
    // hard-coded multiple of nothing is really comparing it against a number
    // that was guessed. Measuring the floor in the same run is the only way to
    // know what "changed" means here.
    const repeat = await capture(client, { time: 30, scope: signal, layers: [1, 0.35, 0.8, 0.15] });
    await client.evaluate('__jeffer.draw({})');

    // What the scope layer adds, row by row.
    const profile = rowProfileDiff(scopeOn, scopeOff);
    // The same thing at the two ends of the auto-ranging range. The moment and
    // the signal are identical in all four captures, so the only thing that
    // differs between `lowGain` and `highGain` is the deflection.
    const lowProfile = rowProfileDiff(lowGain, scopeOff);
    const highProfile = rowProfileDiff(highGain, scopeOff);
    const noiseProfile = rowProfileDiff(scopeOn, repeat);

    // The strongest claim available here is causal, not positional. "The trace
    // is bright" cannot be checked against a band that should be empty, because
    // there is no such band: the graticule's own border and the bloom around the
    // spectrum both put light where the layout says there is none, and both are
    // supposed to be there. So instead: turning the deflection up must change
    // the picture *inside the trace band and essentially nowhere else*, because
    // the deflection is the trace and nothing else on the screen is.
    const shiftTrace = bandDifference(lowProfile, highProfile, TRACE_BAND);
    const shiftGap = bandDifference(lowProfile, highProfile, GAP_BAND);
    const shiftAbove = bandDifference(lowProfile, highProfile, ABOVE_BAND);
    const floor = bandDifference(noiseProfile, zeroProfile(noiseProfile.length), TRACE_BAND);
    // An absolute minimum as well as a multiple of the floor: with the signal,
    // the moment, the noise field and the frame rate all pinned, two draws of
    // one frame are the same picture to within the driver's own rounding, so
    // the floor is small — and a check that only asked for "more than three
    // times almost nothing" would be satisfied by nothing at all.
    const minShift = Math.max(floor * 3, 0.01);
    // The guard for the trap above, stated as its own check. A flat trace still
    // sits on the trace row, so every positional check in this block passes
    // against one; the only thing that gives it away is the renderer refusing the
    // frame, and the refusal is silent unless somebody asks.
    check(
      'the pinned reading reaches the renderer as a waveform',
      pinnedBins === SCOPE_BINS,
      `${pinnedBins} of ${SCOPE_BINS} bins taken from the pinned scope (0 would mean a flat line)`,
    );
    const traceRow = argmax(profile, TRACE_BAND[0], TRACE_BAND[1]);
    check(
      'the deflection gain moves the trace, and only the trace',
      shiftTrace > minShift && shiftTrace > shiftGap * 2 && shiftTrace > shiftAbove * 2,
      `raising the gain four times changes the trace band by ${(shiftTrace * 100).toFixed(1)}%, ` +
        `against ${(shiftGap * 100).toFixed(1)}% in the gap below the graticule, ` +
        `${(shiftAbove * 100).toFixed(1)}% above it, ` +
        `and a ${(floor * 100).toFixed(1)}% noise floor measured by drawing the same frame twice`,
    );
    check(
      'the trace is in the graticule',
      (profile[traceRow] as number) > (percentile(profile, 0.5) as number) * 2,
      `the scope's contribution peaks on row ${(rowOf(traceRow, profile.length) * 100).toFixed(0)}% ` +
        `(the trace is drawn at ${(TRACE_ROW * 100).toFixed(0)}%), at ` +
        `${((profile[traceRow] as number) * 100).toFixed(1)}% against a median row's ` +
        `${((percentile(profile, 0.5) as number) * 100).toFixed(1)}%`,
    );
    const specRow = argmax(profile, SPEC_BAND[0], 1);
    check(
      'the spectrum is along the bottom',
      (profile[specRow] as number) > (percentile(profile, 0.5) as number) * 3,
      `the scope layer's single biggest mark is on row ` +
        `${(rowOf(specRow, profile.length) * 100).toFixed(0)}% at ` +
        `${((profile[specRow] as number) * 100).toFixed(1)}%, ` +
        `against a median row's ${((percentile(profile, 0.5) as number) * 100).toFixed(1)}%`,
    );

    // The flash cap. This is the check that matters most for safety: an electro
    // set must react to the kick, and must not strobe.
    check(
      'the flash cap holds by default',
      parsed.render.flashMode === 'soft' && parsed.pulse <= FLASH_DEPTH.soft + 1e-6,
      `pulse ${parsed.pulse.toFixed(4)}, cap ${FLASH_DEPTH.soft}, mode ${parsed.render.flashMode}`,
    );
    // The claim is that the kick *moves* the brightness and that the cap holds.
    // It is not a claim about how bright it gets: that is the arrangement's
    // business, and the intro this is sampled in is four bars of a quarter of
    // the dynamics of a drop. So the range is what is asserted, and the ceiling
    // is asserted absolutely.
    const pulses = await samplePulse(client, 40);
    const pulseMin = Math.min(...pulses);
    const pulseMax = Math.max(...pulses);
    check(
      'the kick pulses, and never past the cap',
      pulseMax - pulseMin > 0.008 && pulseMax <= FLASH_DEPTH.soft + 1e-6,
      `pulse ${pulseMin.toFixed(4)} … ${pulseMax.toFixed(4)} over ${pulses.length} samples ` +
        `(cap ${FLASH_DEPTH.soft}; sampled in the ${parsed.piece?.section}, which is the quietest passage)`,
    );
    check('there is audio graph activity', parsed.audio.voices > 0, `${parsed.audio.voices} voices, ${parsed.audio.bars} bars scheduled`);
    check(
      'the layers are on the screen',
      parsed.render.layers.some((weight) => weight > 0.01),
      `scope ${parsed.render.layers[0]} colour ${parsed.render.layers[1]} ` +
        `vhs ${parsed.render.layers[2]} glitch ${parsed.render.layers[3]}`,
    );
    // The frame mean is read every twelfth frame, so it is sampled after the
    // captures above rather than from the stats read at the top of the run: by
    // then the renderer has drawn enough frames for the reduction to have run at
    // least once, and a mean of exactly zero would mean the readback is not
    // reading the frame it claims to.
    const sampled = await readStats();
    check(
      'the renderer measures the frame it is drawing',
      sampled.render.mean > 0.001 && Math.abs(sampled.render.mean - measured.mean) < 0.12,
      `renderer ${sampled.render.mean.toFixed(4)} vs the screenshot's ${measured.mean.toFixed(4)} ` +
        `after ${sampled.frames} frames (a 32x32 point sample against a full frame, ` +
        'so "close" is the claim, not "equal")',
    );

    // The intro is the quietest picture the set ever draws, so "the picture is
    // there" is only half the claim. The other half is that a *drop* looks like
    // one: hotter, denser and a different mixture of layers. The conductor is
    // time-addressable, so the moment is found by asking it rather than by
    // waiting for it — and `draw({ time })` pins the frame loop to that instant,
    // so the capture cannot race a redraw.
    const dropAt = await client.evaluate<number>(`(() => {
      for (let t = 0; t < 3600; t += 2) {
        if (__jeffer.pieceAt(t).section !== 'drop') continue;
        // The *middle* of the drop, not its first bar: the section's own change
        // takes a moment to arrive, and a capture taken in the middle of it
        // measures a half-built picture.
        let end = t;
        while (__jeffer.pieceAt(end + 2).section === 'drop') end += 2;
        return (t + end) / 2;
      }
      return 60;
    })()`);
    const dropState = JSON.parse(
      await client.evaluate<string>(`JSON.stringify(__jeffer.draw({ time: ${dropAt} }))`),
    ) as { layers: [number, number, number, number]; flashMode: string };
    const dropBuffer = await client.screenshot();
    await fs.writeFile(join(ARTIFACTS, 'drop.png'), dropBuffer);
    const dropImage = decodePng(dropBuffer);
    const dropMeasured = analyse(dropImage);
    // The intro, drawn the same way the drop was: pinned to a chosen moment, so
    // the two frames differ by the arrangement and by nothing else. The live
    // screenshot above is *not* usable here — it is taken whenever the settle loop
    // finished, and its mean moves by a few thousandths between runs, which is
    // enough to lose a comparison decided by a fraction of a per cent.
    const introAt = await client.evaluate<number>(`(() => {
      for (let t = 0; t < 3600; t += 2) {
        if (__jeffer.pieceAt(t).section !== 'intro') return t / 2;
      }
      return 15;
    })()`);
    await client.evaluate(`__jeffer.draw({ time: ${introAt} })`);
    const introBuffer = await client.screenshot();
    await fs.writeFile(join(ARTIFACTS, 'intro.png'), introBuffer);
    const introImage = decodePng(introBuffer);
    const introMeasured = analyse(introImage);
    check(
      'a drop is a different picture from an intro',
      // The claim is not "a drop is brighter". This picture is two thirds black
      // whatever the arrangement is doing and its exposure follows the master, so
      // two frames of the same set sit within a few per cent of each other in
      // mean luminance — a check with a factor in it would be asserting that the
      // app breaks its own rule about being dark, and it would be a coin flip.
      // What a drop actually does is fill the black in: the darkest twelfth of
      // the frame shrinks, and it shrinks by more than the frame-to-frame noise
      // of the tape, which is why the claim is about the black and not the mean.
      darkFraction(dropImage, 1 / 12) < darkFraction(introImage, 1 / 12) - 0.03 &&
        dropMeasured.colourFraction > 0.1,
      `intro (pinned at ${introAt.toFixed(0)}s) mean ${introMeasured.mean.toFixed(4)} / ` +
        `black ${(darkFraction(introImage, 1 / 12) * 100).toFixed(1)}% / ` +
        `colour ${(introMeasured.colourFraction * 100).toFixed(0)}% ` +
        `-> drop mean ${dropMeasured.mean.toFixed(4)} / ` +
        `black ${(darkFraction(dropImage, 1 / 12) * 100).toFixed(1)}% / ` +
        `colour ${(dropMeasured.colourFraction * 100).toFixed(0)}% ` +
        `(scope ${dropState.layers[0]} colour ${dropState.layers[1]} ` +
        `vhs ${dropState.layers[2]} glitch ${dropState.layers[3]}, at ${dropAt.toFixed(0)}s)`,
    );
    check(
      'a drop is not blown out either',
      dropMeasured.mean < 0.55 && dropMeasured.max <= 1,
      `mean ${dropMeasured.mean.toFixed(4)}, max ${dropMeasured.max.toFixed(3)}`,
    );
    await client.evaluate('__jeffer.draw({})');

    // The controls. These paths only run when someone touches them, so the test
    // touches them: quality, volume, flash mode, sleep, audio-only, and back.
    await client.evaluate(`(() => {
      const set = (id, value, type = 'change') => {
        const el = document.getElementById(id);
        if (el.type === 'checkbox') el.checked = value; else el.value = value;
        el.dispatchEvent(new Event(type, { bubbles: true }));
      };
      set('quality', 'low');
      set('volume', '0.42', 'input');
      set('flash', 'full');
      set('sleep', '15');
      set('audio-only', true);
      document.getElementById('copy-link').click();
      return true;
    })()`);
    // Snapshot *after* enabling, not before: a screenshot stalls the compositor
    // for tens of seconds here, so an older frame count is not comparable.
    const hiddenStart = JSON.parse(await client.evaluate<string>('JSON.stringify(__jeffer.stats())')) as PlayerStats;
    const framesBeforeSilence = hiddenStart.frames;
    await delay(1500);
    const silent = JSON.parse(await client.evaluate<string>('JSON.stringify(__jeffer.stats())')) as PlayerStats;
    check(
      'audio-only draws nothing and keeps playing',
      silent.audioOnly === true &&
        silent.frames === framesBeforeSilence &&
        silent.clock > hiddenStart.clock,
      `${silent.frames - framesBeforeSilence} frames while hidden, ` +
        `clock ${hiddenStart.clock.toFixed(2)}s -> ${silent.clock.toFixed(2)}s`,
    );
    check(
      'the quality setting takes effect',
      silent.render.quality === 'low' && silent.render.octaves <= 1,
      `quality ${silent.render.quality}, ${silent.render.octaves} octaves, scale ${silent.render.scale}`,
    );
    check(
      'the flash control raises the cap, and only then',
      silent.render.flashMode === 'full',
      `mode ${silent.render.flashMode}`,
    );
    // Audio-only means *no GPU work at all*, so the scope's last reading has to
    // be the one that was already taken rather than a fresh one off a dropped
    // drawing buffer.
    check(
      'audio-only stops feeding the picture too',
      silent.frames === framesBeforeSilence,
      `no frames, no scope uploads: ${silent.frames} frames`,
    );

    await client.evaluate(`(() => {
      const set = (id, value, type = 'change') => {
        const el = document.getElementById(id);
        if (el.type === 'checkbox') el.checked = value; else el.value = value;
        el.dispatchEvent(new Event(type, { bubbles: true }));
      };
      set('audio-only', false);
      set('sleep', '0');
      set('quality', 'auto');
      set('flash', 'soft');
      return true;
    })()`);
    await delay(2000);
    const awake = JSON.parse(await client.evaluate<string>('JSON.stringify(__jeffer.stats())')) as PlayerStats;
    check('the picture comes back', awake.frames > silent.frames && awake.audioOnly === false, `${awake.frames - silent.frames} frames since`);
    check('the controls left no errors behind', client.errors.length === 0, client.errors.slice(0, 2).join(' | '));

    // The skip key (main.ts's `N`). The conductor alone is unit-tested for the
    // change; what is checked here is the half only a real page can show: the
    // reported lead, that the set really is the one named there, and that the
    // audio engine was re-anchored rather than left scheduling the passage that
    // was just abandoned.
    const beforeSkip = await readStats();
    const forced = JSON.parse(
      await client.evaluate<string>('JSON.stringify(__jeffer.skipSection())'),
    ) as ForcedSection;
    check(
      'the skip key lands on a passage, not at the end of the schedule',
      forced.lead > 0 && forced.lead < 12,
      `forced ${forced.name} at ${forced.at.toFixed(2)}s, bar ${forced.bar}, ` +
        `${forced.lead.toFixed(2)}s from a clock reading ${beforeSkip.clock.toFixed(2)}s`,
    );
    const atChange = JSON.parse(
      await client.evaluate<string>(`JSON.stringify(__jeffer.pieceAt(${forced.at + 1}))`),
    ) as DescribedPiece;
    check(
      'the set the key skips to is the one that plays there',
      atChange.section === forced.name && atChange.bar >= forced.bar,
      `${atChange.section} at bar ${atChange.bar}, the key said ${forced.name} at bar ${forced.bar}`,
    );
    // The bar clock has to have carried on past the cut rather than stalled or
    // restarted. The section is *not* required to differ: a forced break is
    // eight to sixteen bars long, so twenty seconds on it is still that break,
    // and asking for a different one would be asserting a bar count this set is
    // not obliged to have.
    const afterChange = JSON.parse(
      await client.evaluate<string>(`JSON.stringify(__jeffer.pieceAt(${forced.at + 20}))`),
    ) as DescribedPiece;
    check(
      'the set carries on after a forced change',
      afterChange.bar > atChange.bar && afterChange.bpm > 0,
      `bar ${atChange.bar} → ${afterChange.bar}, still ${afterChange.section} @${afterChange.bpm} bpm`,
    );
    await delay(1200);
    const afterSkip = await readStats();
    check(
      'the engine kept playing through the change',
      afterSkip.clock > beforeSkip.clock &&
        afterSkip.audio.bars >= beforeSkip.audio.bars &&
        afterSkip.audio.voices > beforeSkip.audio.voices &&
        afterSkip.frames > beforeSkip.frames,
      `clock ${beforeSkip.clock.toFixed(2)}s → ${afterSkip.clock.toFixed(2)}s, ` +
        `${afterSkip.audio.bars - beforeSkip.audio.bars} bars, ` +
        `${afterSkip.audio.voices - beforeSkip.audio.voices} voices, ` +
        `${afterSkip.frames - beforeSkip.frames} frames`,
    );
    check(
      'the scope is still reading the music after a forced change',
      afterSkip.scope.peak > 0.01 && afterSkip.audio.scopeAvailable,
      `peak ${afterSkip.scope.peak.toFixed(4)} after the cut at ${forced.at.toFixed(1)}s`,
    );

    // The sleep timer. The HUD's smallest step is fifteen minutes — fifteen
    // minutes nobody waits for in a test — so the timer is armed through the
    // diagnostic hook. It is the same path either way (`armSleep` → `setSleep`
    // → `engine.fadeOut`), so what runs here is the real fade, the real suspend
    // and the real resume.
    //
    // The pointer move is part of it: the controls are "hidden until the pointer
    // moves", and the HUD's own 4.2 s hide timer runs out while the fade below
    // is watched, so both halves of that rule get checked.
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 40, y: 40 });
    await delay(250);
    const hudShown = await client.evaluate<boolean>(
      'document.getElementById("hud").classList.contains("visible")',
    );
    check('the controls appear when the pointer moves', hudShown, hudShown ? 'visible' : 'still hidden');

    await client.evaluate('__jeffer.armSleep(8)');
    const armed = await readStats();
    const armedLeft = armed.sleep.secondsLeft ?? -1;
    check(
      'the sleep timer arms on the journey clock',
      armed.sleep.at != null && armedLeft > 5 && armedLeft <= 8.5,
      `deadline ${armed.sleep.at?.toFixed(2)}s, ${armedLeft.toFixed(2)}s left, dim ${armed.sleep.dim.toFixed(3)}`,
    );

    // The fade runs on the journey clock, and the journey clock is an audio
    // clock on a machine with no audio device: it does not necessarily keep up
    // with the wall. So the fade is *polled for*, not slept through — wait for
    // the state the check is about, with a deadline.
    let dimming = await readStats();
    for (let attempt = 0; attempt < 60 && dimming.sleep.dim >= 0.85; attempt++) {
      await delay(400);
      dimming = await readStats();
    }
    const dimmingLeft = dimming.sleep.secondsLeft ?? -1;
    check(
      'the fade dims the picture as it runs, without a jump',
      dimming.sleep.dim < 0.85 && dimming.sleep.dim < armed.sleep.dim && dimmingLeft < armedLeft,
      `dim ${armed.sleep.dim.toFixed(3)} → ${dimming.sleep.dim.toFixed(3)}, ` +
        `${armedLeft.toFixed(1)}s → ${dimmingLeft.toFixed(1)}s left`,
    );

    // The engine decides the set should have stopped (a second past the fade);
    // the app's frame loop is what notices and suspends.
    let slept = await readStats();
    for (let attempt = 0; attempt < 160 && !slept.asleep; attempt++) {
      await delay(500);
      slept = await readStats();
    }
    const resting = JSON.parse(
      await client.evaluate<string>(
        'JSON.stringify({ shown: !document.getElementById("notice").hidden, ' +
          'text: document.getElementById("notice-text").textContent, ' +
          'action: document.getElementById("notice-action").textContent, ' +
          'hud: document.getElementById("hud").classList.contains("visible") })',
      ),
    ) as { shown: boolean; text: string; action: string; hud: boolean };
    check(
      'the fade reaches silence and the set suspends',
      slept.asleep === true && slept.sleep.dim < 0.1,
      `asleep ${slept.asleep}, dim ${slept.sleep.dim.toFixed(3)} at clock ${slept.clock.toFixed(2)}s`,
    );
    check(
      'sleeping offers a way back',
      resting.shown && /resume/i.test(resting.action),
      `notice "${resting.text}" — action "${resting.action}"`,
    );
    check(
      'the controls hide again once the pointer stops',
      resting.hud === false,
      resting.hud ? 'the HUD is still up' : 'hidden by the time the fade ended',
    );

    // "The set is paused exactly where it stopped" is a claim about the clock,
    // and it has two halves: while asleep nothing moves, and on resume the clock
    // has not run on. Both are wall-clock comparisons, so both read the journey
    // clock and `performance.now()` in one instant, inside the page — a host
    // timestamp against a page one is skewed by round trips that run to seconds
    // here, which would fail a healthy build or pass a broken one.
    const readClocks = async (): Promise<{ clock: number; wall: number }> =>
      JSON.parse(
        await client.evaluate<string>(
          'JSON.stringify({ clock: __jeffer.stats().clock, wall: performance.now() / 1000 })',
        ),
      ) as { clock: number; wall: number };

    const heldFrames = slept.frames;
    const heldProbe = await readClocks();
    await delay(1200);
    const held = await readStats();
    const heldNow = await readClocks();
    const heldWall = heldNow.wall - heldProbe.wall;
    check(
      'a sleeping set holds its clock while wall time runs on',
      Math.abs(heldNow.clock - heldProbe.clock) < 0.05 &&
        held.frames === heldFrames &&
        heldWall > 1,
      `journey clock ${heldProbe.clock.toFixed(2)}s → ${heldNow.clock.toFixed(2)}s ` +
        `while ${heldWall.toFixed(2)}s of wall time passed, ${held.frames - heldFrames} frames drawn`,
    );

    // Read again at the moment of the resume: this baseline is what makes a
    // catch-up jump visible, because a jump would land *after* it.
    const resumeProbe = await readClocks();
    await client.evaluate('document.getElementById("notice-action").click()');
    // rAF is throttled hard in a headless page — a couple of frames a second at
    // best — so wait for the picture to actually come back rather than for a
    // wall-clock interval.
    let awakeAgain = await readStats();
    for (let attempt = 0; attempt < 20 && awakeAgain.frames <= heldFrames; attempt++) {
      await delay(400);
      awakeAgain = await readStats();
    }
    const resumed = JSON.parse(
      await client.evaluate<string>(
        'JSON.stringify({ notice: !document.getElementById("notice").hidden, ' +
          'timer: document.getElementById("sleep").value, ' +
          'toast: document.getElementById("toast").textContent })',
      ),
    ) as { notice: boolean; timer: string; toast: string };
    const awakeProbe = await readClocks();
    const wall = awakeProbe.wall - resumeProbe.wall;
    const clockDelta = awakeProbe.clock - resumeProbe.clock;
    check(
      'resuming carries on from where it stopped',
      awakeAgain.asleep === false &&
        awakeAgain.frames > heldFrames &&
        clockDelta > 0 &&
        clockDelta <= wall + 1 &&
        awakeAgain.sleep.at == null &&
        awakeAgain.sleep.dim === 1 &&
        resumed.notice === false &&
        resumed.timer === '0',
      `clock ${resumeProbe.clock.toFixed(2)}s → ${awakeProbe.clock.toFixed(2)}s (+${clockDelta.toFixed(2)}s) ` +
        `over ${wall.toFixed(2)}s of wall time, ${awakeAgain.frames - heldFrames} frames, ` +
        `timer ${resumed.timer}, dim ${awakeAgain.sleep.dim.toFixed(2)}, toast "${resumed.toast}"`,
    );

    // Sound, not just objects: render the real engine offline — the same graph,
    // the same scheduler, the same patterns — and measure what comes out of the
    // master. The app exposes that path on the diagnostic hook (src/offline.ts);
    // here it runs in the page, against the build that ships.
    const offline = await client.evaluate<OfflineMeasurement>(
      '__jeffer.offline({ seed: "offline-check", seconds: 45 })',
      // Rendering 45 s of an electro graph faster than real time is not instant,
      // and the default evaluate timeout would call it a hang.
      180000,
    );
    check(
      'the engine renders signal offline',
      offline.rms > 0.004 && offline.peak > 0.02,
      `rms ${offline.rms.toFixed(5)}, peak ${offline.peak.toFixed(4)}`,
    );
    // The live trim moves this toward the target once the meter has blocks; here
    // the check is that the set is in the region at all, and not silent or hot.
    check(
      'the master lands in the loudness region',
      Number.isFinite(offline.lufs) && offline.lufs > -30 && offline.lufs < -6,
      `${offline.lufs.toFixed(2)} LUFS over the last ${offline.seconds - offline.measureFrom} s ` +
        `(target ${TARGET_LUFS}) at trim ${offline.trimDb.toFixed(1)} dB`,
    );
    // The reference is a hard-limited master at +6 dBTP. This one is not, on
    // purpose — see the header of src/audio/loudness.ts — so the ceiling is
    // asserted rather than the reference's own number reproduced.
    check(
      'the true peak stays under the ceiling',
      Number.isFinite(offline.truePeakDb) && offline.truePeakDb <= TRUE_PEAK_CEILING_DB + 0.5,
      `${offline.truePeakDb.toFixed(2)} dBTP (ceiling ${TRUE_PEAK_CEILING_DB} dBTP; the reference is +6.02)`,
    );
    check(
      'the offline pass scheduled real music',
      offline.bars >= 10 && offline.voices > 100,
      `${offline.bars} bars, ${offline.voices} voices in ${offline.seconds} s`,
    );

    // Seed links. A link is worth nothing unless it reproduces the set, and the
    // conductor is pure and time-addressable, so that is checked rather than
    // asserted: describe the set at three times here, then come back to the
    // same seed in a *fresh* page and describe it again.
    const readJourney = async (): Promise<JourneyReading> =>
      JSON.parse(
        await client.evaluate<string>(
          'JSON.stringify({ seed: __jeffer.seed, hash: location.hash, ' +
            'input: document.getElementById("seed").value, ' +
            'probes: [0, 600, 3600].map((t) => __jeffer.pieceAt(t)) })',
        ),
      ) as JourneyReading;
    const setSeedInput = async (value: string): Promise<void> => {
      await client.evaluate(`(() => {
        const input = document.getElementById('seed');
        input.value = ${JSON.stringify(value)};
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
    };
    /** Wait for the app to reload itself onto a new seed. */
    const waitForSeed = async (want: string): Promise<boolean> => {
      for (let attempt = 0; attempt < 80; attempt++) {
        await delay(200);
        // A reload destroys the context under the evaluation, which is what the
        // catch is for: the next poll lands in the new document.
        const state = await client
          .evaluate<string>('JSON.stringify({ ready: document.readyState, seed: __jeffer?.seed ?? null })')
          .catch(() => '{}');
        const parsed = JSON.parse(state) as { ready?: string; seed?: string | null };
        if (parsed.ready === 'complete' && parsed.seed === want) return true;
      }
      return false;
    };

    const first = await readJourney();
    const moments = new Set(first.probes.map((p) => `${p.key}/${p.chord}/${p.section}/${p.bpm}`));
    check(
      'the set can be described at any time in it',
      first.seed === seed &&
        first.hash === `#s=${seed}` &&
        first.probes.length === 3 &&
        moments.size >= 2,
      `${first.probes.length} moments in, ${moments.size} distinct: ` +
        first.probes.map((p) => `${p.section} ${p.chord} @${p.bpm}`).join(' | '),
    );

    await setSeedInput('other-set');
    const arrived = await waitForSeed('other-set');
    const other = await readJourney();
    check(
      'another seed reloads into another set, carried by the URL',
      arrived &&
        other.hash === '#s=other-set' &&
        other.input === 'other-set' &&
        JSON.stringify(other.probes) !== untouched,
      `seed ${other.seed}, hash ${other.hash}, ` +
        other.probes.map((p) => `${p.section} ${p.chord}`).join(' | '),
    );

    // Junk is refused rather than followed: the reader keeps the set they had,
    // and the URL is not rewritten into something that cannot be cleaned.
    await setSeedInput('***');
    await delay(800);
    const refused = await readJourney();
    const refusal = await client.evaluate<string>('document.getElementById("toast").textContent');
    check(
      'a junk seed is refused, not followed',
      refused.seed === 'other-set' &&
        refused.input === 'other-set' &&
        refused.hash === '#s=other-set' &&
        /letter or digit/.test(refusal),
      `seed still ${refused.seed}, input back to "${refused.input}", toast "${refusal}"`,
    );

    // Both sides of this comparison are read from a *fresh* page carrying the
    // same seed. `again` was read from a page nothing had touched, and a forced
    // change is deliberately not seed-deterministic — a set someone has skipped
    // through is not the set the seed alone would have played — so comparing
    // against the page the skip key rewrote would be testing the skip, not the
    // link. Go away to another seed and back, which is two clean loads of the
    // same set.
    await setSeedInput(seed);
    const returned = await waitForSeed(seed);
    const again = await readJourney();
    await setSeedInput('other-set');
    const steppedAside = await waitForSeed('other-set');
    await setSeedInput(seed);
    const cameBack = await waitForSeed(seed);
    const third = await readJourney();
    check(
      'a seed link reproduces the set exactly, an hour in',
      returned &&
        steppedAside &&
        cameBack &&
        third.seed === seed &&
        JSON.stringify(third.probes) === JSON.stringify(again.probes),
      third.probes.map((p) => `${p.section} ${p.chord} (${p.key})`).join(' | '),
    );

    // "Copy link" builds the URL and hands it to the clipboard. The clipboard is
    // the browser's; the URL is the app's, so the writeText call is recorded
    // here and what it was given is checked — a link that carries this seed and
    // nothing else.
    await client.evaluate(`(() => {
      globalThis.__copied = null;
      navigator.clipboard.writeText = (text) => { globalThis.__copied = text; return Promise.resolve(); };
      return true;
    })()`);
    await client.evaluate('document.getElementById("copy-link").click()');
    await delay(300);
    const copied = JSON.parse(
      await client.evaluate<string>(
        'JSON.stringify({ url: globalThis.__copied ?? null, ' +
          'toast: document.getElementById("toast").textContent })',
      ),
    ) as { url: string | null; toast: string };
    check(
      'copy link hands over the link that carries this set',
      copied.url === `${url.split('#')[0]}#s=${seed}` && /carries the seed/.test(copied.toast),
      `copied "${copied.url}" and said "${copied.toast}"`,
    );

    check('the new paths left no errors behind', client.errors.length === 0, client.errors.slice(0, 3).join(' | '));

    // The page has been reloaded three times by now, to prove the seed link
    // carries its set — and a reload leaves a set that is *not* playing, because
    // only a real gesture can start audio and the reload threw the old one away.
    // Nothing since has needed sound, so this is the first thing to notice: the
    // loudness feedback below is measured on a page that was never entered, and
    // reads exactly what a set that is not playing reads, which is a trim that
    // never moves. Enter it again, as a person landing on the link would.
    await enter(client);
    const playing = await waitFor<PlayerStats>(
      async () => {
        const stats = JSON.parse(
          await client.evaluate<string>('JSON.stringify(__jeffer.stats())'),
        ) as PlayerStats;
        return stats.started && stats.clock > 0.5 ? stats : null;
      },
      15_000,
    );
    check(
      'a reloaded set plays again once it is entered',
      playing !== null && playing.audio.meterAvailable === true,
      playing
        ? `clock ${playing.clock.toFixed(2)}s, meter ${playing.audio.meterAvailable ? 'on' : 'off'}`
        : 'the set never started after the reload',
    );

    // The loudness feedback, live. The offline render above deliberately cannot
    // check this: an OfflineAudioContext has no audio thread, so the meter worklet
    // never runs and the trim never leaves its starting value. Here it does run,
    // and the claim worth making is not "the master is at the target" — a
    // two-minute set has not converged yet — but that the trim is *moving toward*
    // it, which is the difference between a working feedback loop and a constant.
    // Sixteen reads at 400 ms: the meter needs eight 400 ms blocks before it has
    // said anything at all, so a shorter sample would be reading a set that has
    // not been listened to long enough to be measured.
    const loudness = await sampleLoudness(client, 16);
    check(
      'the loudness feedback is live and moving toward the target',
      Number.isFinite(loudness.trimStart) &&
        Number.isFinite(loudness.trimEnd) &&
        loudness.trimEnd > loudness.trimStart + 0.3,
      `trim ${loudness.trimStart.toFixed(2)} dB → ${loudness.trimEnd.toFixed(2)} dB ` +
        `over ${loudness.samples} reads, ${loudness.lufsStart} → ${loudness.lufsEnd} ` +
        `(target ${TARGET_LUFS})`,
    );

    if (client.logs.length) {
      console.log('\n  console:');
      for (const entry of client.logs.slice(0, 12)) console.log(`    [${entry.level}] ${entry.text.slice(0, 160)}`);
    }
    console.log(
      `\n  screenshots: ${join(ARTIFACTS, 'smoke.png')}, ${join(ARTIFACTS, 'intro.png')}, ` +
        `${join(ARTIFACTS, 'drop.png')}`,
    );
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
 * Click "enter" the way a person does, so the browser sees a real gesture.
 *
 * Only a gesture can start audio, and the smoke test reloads the page to prove
 * a seed link carries its set — so this is not a one-off at the top of the run.
 * Entering the same page twice is what a reader following a link does.
 */
async function enter(client: Chrome): Promise<void> {
  const { x, y } = await client.centreOf('enter-button');
  await client.click(x, y);
}

/** Poll a reading in the page until it is good enough to be worth checking. */
async function waitFor<T>(read: () => Promise<T | null>, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() >= deadline) return null;
    await delay(250);
  }
}

/** Draw a pinned frame and take a screenshot of it. */
async function capture(
  client: Chrome,
  options: Record<string, unknown>,
): Promise<ReturnType<typeof decodePng>> {
  await client.evaluate(`__jeffer.draw(${JSON.stringify(options)})`);
  return decodePng(await client.screenshot());
}

/**
 * The mean *difference* between two captures of the same moment, row by row,
 * as fractions of the frame's height from the top.
 *
 * This is the measurement that answers "is the trace where the shader says it
 * put it". A mean over a rectangle does not: the colour field is a wash that
 * puts a floor under every band, and the trace is a line two pixels tall inside
 * a band fourteen per cent of the screen, so the line averages away into the
 * band and the band averages away into the frame. A row profile does not
 * average the line away, and where its peak lands is the answer.
 */
function rowProfileDiff(
  a: ReturnType<typeof decodePng>,
  b: ReturnType<typeof decodePng>,
): number[] {
  const height = Math.min(a.height, b.height);
  const width = Math.min(a.width, b.width);
  const out = new Array<number>(height).fill(0);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) {
      const at = (y * a.width + x) * a.channels;
      const other = (y * b.width + x) * b.channels;
      const la = (0.2126 * a.data[at] + 0.7152 * a.data[at + 1] + 0.0722 * a.data[at + 2]) / 255;
      const lb = (0.2126 * b.data[other] + 0.7152 * b.data[other + 1] + 0.0722 * b.data[other + 2]) / 255;
      sum += Math.abs(la - lb);
    }
    out[y] = sum / Math.max(1, width);
  }
  return out;
}

/**
 * The index of the largest value between two fractions of the array's length.
 *
 * An index, not a position: this is used both to read `profile[i]` and to say
 * where on the screen that row is, and returning one for the other is how a
 * profile of a 720-row image ends up being indexed at 0.3.
 */
function argmax(values: number[], from = 0, to = 1): number {
  const start = Math.max(0, Math.floor(from * values.length));
  const end = Math.min(values.length, Math.ceil(to * values.length));
  let best = start;
  for (let i = start; i < end; i++) {
    if ((values[i] as number) > (values[best] as number)) best = i;
  }
  return best;
}

/** A row index as a fraction of the frame's height, for saying where it is. */
function rowOf(index: number, length: number): number {
  return length ? index / length : 0;
}

/** An all-zero profile, for measuring a difference against nothing. */
function zeroProfile(length: number): number[] {
  return new Array<number>(length).fill(0);
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
  return sorted[at] as number;
}

/** The mean absolute difference between two row profiles, over one band. */
function bandDifference(a: number[], b: number[], band: readonly [number, number]): number {
  const start = Math.max(0, Math.floor(band[0] * a.length));
  const end = Math.min(a.length, Math.ceil(band[1] * a.length));
  let sum = 0;
  for (let i = start; i < end; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return end > start ? sum / (end - start) : 0;
}

/**
 * The fraction of a frame below a luminance threshold — the same measurement
 * `tmp/jeffer/frames.py` took off the reference, so the number here and the
 * number there mean the same thing. The threshold is that script's 0.12, and
 * using a different one (the smoke test's own `analyse` counts lit pixels above
 * 0.06, which is a different measurement entirely) would make the comparison
 * meaningless in both directions.
 */
function darkFraction(image: ReturnType<typeof decodePng>, threshold = 0.12): number {
  let dark = 0;
  const pixels = image.width * image.height;
  for (let i = 0; i < pixels; i++) {
    const at = i * image.channels;
    const luma =
      (0.2126 * image.data[at] + 0.7152 * image.data[at + 1] + 0.0722 * image.data[at + 2]) / 255;
    if (luma < threshold) dark++;
  }
  return dark / pixels;
}

/**
 * Sample the flash budget over a few beats. The page runs on its own clock, so
 * this polls it rather than trying to catch a beat: what is asserted is the
 * *range*, which is the claim the cap makes.
 */
async function samplePulse(client: Chrome, samples: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < samples; i++) {
    out.push(await client.evaluate<number>('__jeffer.stats().pulse'));
    await delay(60);
  }
  return out;
}

/**
 * The first and last of a run of loudness readings.
 *
 * `lufs` is the awkward one: before the meter has any 400 ms blocks the engine
 * reports -Infinity, and `JSON.stringify` writes that as `null`. So the reading
 * arrives here as null rather than as a number, and a check that called
 * `toFixed` on it would throw instead of reporting. It is carried as a string
 * for exactly that reason — "no blocks yet" is a legitimate thing for the meter
 * to be saying, and it is worth putting in the report.
 */
async function sampleLoudness(
  client: Chrome,
  samples: number,
): Promise<{ trimStart: number; trimEnd: number; lufsStart: string; lufsEnd: string; samples: number }> {
  let trimStart = 0;
  let trimEnd = 0;
  let lufsStart = 'no blocks yet';
  let lufsEnd = 'no blocks yet';
  for (let i = 0; i < samples; i++) {
    const reading = JSON.parse(
      await client.evaluate<string>('JSON.stringify(__jeffer.stats().audio)'),
    ) as { trimDb: number; lufs: number | null };
    const lufs = typeof reading.lufs === 'number' && Number.isFinite(reading.lufs)
      ? `${reading.lufs.toFixed(1)} LUFS`
      : 'no blocks yet';
    if (i === 0) {
      trimStart = reading.trimDb;
      lufsStart = lufs;
    }
    trimEnd = reading.trimDb;
    lufsEnd = lufs;
    await delay(400);
  }
  return { trimStart, trimEnd, lufsStart, lufsEnd, samples };
}

// --- small numeric helpers, so the checks above read as claims ---------------

function meanOf(values: number[], from: number, to: number): number {
  let sum = 0;
  let count = 0;
  for (let i = Math.max(0, from); i < Math.min(values.length, to); i++) {
    sum += values[i] ?? 0;
    count++;
  }
  return count ? sum / count : 0;
}

function minOf(values: number[]): number {
  let out = Infinity;
  for (const value of values) out = Math.min(out, value);
  return Number.isFinite(out) ? out : 0;
}

function maxOf(values: number[]): number {
  let out = -Infinity;
  for (const value of values) out = Math.max(out, value);
  return Number.isFinite(out) ? out : 0;
}

/** A waveform that is all one sign is a rectified signal, not a waveform. */
function hasNegativeAndPositive(wave: number[] | undefined): boolean {
  if (!wave || wave.length === 0) return false;
  return minOf(wave) < -0.001 && maxOf(wave) > 0.001;
}

await main().catch((error) => {
  console.error(error);
  process.exit(2);
});
