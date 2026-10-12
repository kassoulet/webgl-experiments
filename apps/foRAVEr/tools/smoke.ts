#!/usr/bin/env node
// A real-browser smoke test, headless: load the page over HTTP, click "enter"
// like a person would, let it run, then check what actually happened — script
// errors, WebGL2, frames drawn, the clock advancing, the flash cap holding,
// and a screenshot that is decoded here and measured. A clean log proves
// nothing about a picture; a decoded PNG does.
//
// It drives the paths a reader actually takes and that nothing else reaches:
// the controls (spec §4) and the fade to sleep with its suspend and resume,
// the seed input and the URL fragment it reloads onto — including the same seed
// describing the same set an hour in, in a fresh page — and "copy link", whose
// clipboard write is recorded so the URL it hands over can be checked.
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
import type { DescribedPiece, ForcedSection, PlayerStats } from '../src/types.ts';
import type { OfflineMeasurement } from '../src/offline.ts';
import { TARGET_LUFS } from '../src/audio/engine.ts';
import { FLASH_DEPTH } from '../src/profile.ts';

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
    await harness.go(seed);
    // Ready means loaded *and* the enter screen drawn: the diagnostic hook only
    // exists once main.ts has run.
    const ready = await harness.loaded();
    check('the page loads', ready);

    const beforeEnter = await client.evaluate<string>(
      'JSON.stringify({ seed: __foraver.seed, started: __foraver.stats().started })',
    );
    check('it has a seed and is not playing yet', /"started":false/.test(beforeEnter), beforeEnter);

    // Click enter the way a person does, so the browser sees a real gesture.
    const box = await client.evaluate<string>(
      'JSON.stringify(document.getElementById("enter-button").getBoundingClientRect())',
    );
    const rect = JSON.parse(box) as { x: number; y: number; width: number; height: number };
    const x = Math.round(rect.x + rect.width / 2);
    const y = Math.round(rect.y + rect.height / 2);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await client.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }

    const readStats = async (): Promise<PlayerStats> =>
      JSON.parse(await client.evaluate<string>('JSON.stringify(__foraver.stats())')) as PlayerStats;

    // Software rendering (SwiftShader) is slow by nature — on a loaded machine
    // well under a frame a second — so wait for the evidence we need (frames
    // drawn, the clock running) rather than a fixed wall-clock. `--seconds`
    // still sets the minimum settle time; the cap only exists so a genuinely
    // broken renderer fails instead of hanging.
    const settleUntil = Date.now() + seconds * 1000;
    const frameDeadline = Date.now() + Math.max(seconds, 60) * 1000;
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
      /^(intro|build|drop|breakdown|peak)$/.test(parsed.piece?.section ?? '') &&
        parsed.piece.bpm >= 120 &&
        parsed.piece.bpm <= 141 &&
        parsed.piece.bar >= 0,
      `${parsed.piece?.section} at ${parsed.piece?.bpm} bpm, bar ${parsed.piece?.bar}`,
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
    // A rave picture is saturated by definition: a monochrome one is a broken
    // palette, a grey one is a shader that fell over, and a flat one is a
    // constant with a noise texture on top.
    check(
      'the picture is psychedelic, not grey',
      measured.stdev > 0.02 && measured.colourFraction > 0.25,
      `stdev ${measured.stdev.toFixed(4)}, coloured ${(measured.colourFraction * 100).toFixed(1)}%`,
    );
    check(
      'the picture is not blown out',
      measured.mean < 0.75 && measured.max <= 1,
      `mean ${measured.mean.toFixed(4)}, max ${measured.max.toFixed(3)}`,
    );
    // A kaleidoscope is symmetric about its centre; a picture that is only bright
    // in one corner is a camera pointed at the wrong thing.
    const centre = regionMean(image, 0.35, 0.35, 0.65, 0.65);
    check(
      'the centre of the picture is where the picture is',
      centre > 0.01,
      `centre ${centre.toFixed(4)}, mean ${measured.mean.toFixed(4)}`,
    );

    // The flash cap (spec §3). This is the check that matters most here: a rave
    // picture must react to the kick, and must not strobe.
    check(
      'the flash cap holds by default',
      parsed.render.flashMode === 'soft' && parsed.pulse <= FLASH_DEPTH.soft + 1e-6,
      `pulse ${parsed.pulse.toFixed(4)}, cap ${FLASH_DEPTH.soft}, mode ${parsed.render.flashMode}`,
    );
    const pulses = await samplePulse(client, 40);
    check(
      'the kick pulses, and never past the cap',
      Math.max(...pulses) > 0.05 && Math.max(...pulses) <= FLASH_DEPTH.soft + 1e-6,
      `peak pulse ${Math.max(...pulses).toFixed(4)} over ${pulses.length} samples`,
    );    check(
      'there is audio graph activity', parsed.audio.voices > 0, `${parsed.audio.voices} voices, ${parsed.audio.bars} bars scheduled`);
    check(
      'the layers are on the screen',
      parsed.render.layers.some((weight) => weight > 0.01),
      `kaleido ${parsed.render.layers[0]} plasma ${parsed.render.layers[1]} fractal ${parsed.render.layers[2]} noise ${parsed.render.layers[3]}`,
    );

    // The intro is the quietest picture the set ever draws, so "the picture is
    // there" is only half the claim. The other half is that a *drop* looks like
    // one: hotter, denser and a different mixture of layers. The conductor is
    // time-addressable, so the moment is found by asking it rather than by
    // waiting for it — and `draw({ time })` pins the frame loop to that instant,
    // so the capture cannot race a redraw.
    const dropAt = await client.evaluate<number>(`(() => {
      for (let t = 0; t < 3600; t += 2) {
        if (__foraver.pieceAt(t).section !== 'drop') continue;
        // The *middle* of the drop, not its first bar: the section's own change
        // takes three quarters of a second to arrive, and a capture taken in the
        // middle of it measures a half-built picture.
        let end = t;
        while (__foraver.pieceAt(end + 2).section === 'drop') end += 2;
        return (t + end) / 2;
      }
      return 60;
    })()`);
    const dropState = JSON.parse(
      await client.evaluate<string>(`JSON.stringify(__foraver.draw({ time: ${dropAt} }))`),
    ) as { layers: [number, number, number, number]; flashMode: string };
    const dropBuffer = await client.screenshot();
    await fs.writeFile(join(ARTIFACTS, 'drop.png'), dropBuffer);
    const dropImage = decodePng(dropBuffer);
    const dropMeasured = analyse(dropImage);
    check(
      'a drop is a different picture from an intro',
      dropMeasured.mean > measured.mean * 1.1 && dropMeasured.colourFraction > 0.3,
      `intro mean ${measured.mean.toFixed(4)} / colour ${(measured.colourFraction * 100).toFixed(0)}% ` +
        `-> drop mean ${dropMeasured.mean.toFixed(4)} / colour ${(dropMeasured.colourFraction * 100).toFixed(0)}% ` +
        `(kaleido ${dropState.layers[0]} plasma ${dropState.layers[1]} ` +
        `fractal ${dropState.layers[2]} noise ${dropState.layers[3]}, at ${dropAt.toFixed(0)}s)`,
    );
    check(
      'a drop is not blown out either',
      dropMeasured.mean < 0.7 && dropMeasured.max <= 1,
      `mean ${dropMeasured.mean.toFixed(4)}, max ${dropMeasured.max.toFixed(3)}`,
    );
    // Back to following the set, or everything measured after this is a picture
    // of a moment two minutes old.
    await client.evaluate('__foraver.draw({})');


    // The controls (spec §4). These paths only run when someone touches them, so
    // the test touches them: quality, volume, flash mode, sleep, audio-only, and
    // back.
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
    const hiddenStart = JSON.parse(await client.evaluate<string>('JSON.stringify(__foraver.stats())')) as PlayerStats;
    const framesBeforeSilence = hiddenStart.frames;
    await delay(1500);
    const silent = JSON.parse(await client.evaluate<string>('JSON.stringify(__foraver.stats())')) as PlayerStats;
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
      silent.render.quality === 'low' && silent.render.iterations <= 30,
      `quality ${silent.render.quality}, ${silent.render.iterations} iterations`,
    );
    check(
      'the flash control raises the cap, and only then',
      silent.render.flashMode === 'full',
      `mode ${silent.render.flashMode}`,
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
    const awake = JSON.parse(await client.evaluate<string>('JSON.stringify(__foraver.stats())')) as PlayerStats;
    check('the picture comes back', awake.frames > silent.frames && awake.audioOnly === false, `${awake.frames - silent.frames} frames since`);
    check('the controls left no errors behind', client.errors.length === 0, client.errors.slice(0, 2).join(' | '));

    // The skip key (main.ts's `N`, spec §4's "skip to the next passage"). This
    // is the one control that reaches into the arrangement rather than the
    // interface, and the failure it had was invisible from the HUD: the toast
    // said "section: breakdown" while the set carried on unchanged, because the
    // change was appended at the end of the already-scheduled horizon — 591 s
    // away on a run this long. The conductor alone is unit-tested for that, so
    // what is checked here is the half only a real page can show: the reported
    // lead, that the picture follows, and that the audio engine was re-anchored
    // rather than left scheduling the passage that was just abandoned.
    const beforeSkip = await readStats();
    const forced = JSON.parse(
      await client.evaluate<string>('JSON.stringify(__foraver.skipSection())'),
    ) as ForcedSection;
    check(
      'the skip key lands on a passage, not at the end of the schedule',
      forced.lead > 0 && forced.lead < 12,
      `forced ${forced.name} at ${forced.at.toFixed(2)}s, bar ${forced.bar}, ` +
        `${forced.lead.toFixed(2)}s from a clock reading ${beforeSkip.clock.toFixed(2)}s`,
    );
    // Wait for the clock to actually reach the change, then read the set there.
    // This is the assertion the old code could not pass: the passage at
    // `forced.at` was a different one from the one the toast named.
    const atChange = JSON.parse(
      await client.evaluate<string>(`JSON.stringify(__foraver.pieceAt(${forced.at + 1}))`),
    ) as DescribedPiece;
    check(
      'the set the key skips to is the one that plays there',
      atChange.section === forced.name && atChange.bar >= forced.bar,
      `${atChange.section} at bar ${atChange.bar}, the key said ${forced.name} at bar ${forced.bar}`,
    );
    // The bar clock has to have carried on past the cut rather than stalled or
    // restarted. The section is *not* required to differ: a forced breakdown is
    // eight to sixteen bars long, so twenty seconds on it is still a breakdown,
    // and asking for a different one would be asserting a bar count this set is
    // not obliged to have.
    const afterChange = JSON.parse(
      await client.evaluate<string>(`JSON.stringify(__foraver.pieceAt(${forced.at + 20}))`),
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

    // The sleep timer (spec §4: "a sleep timer with a slow fade-out"). The HUD's
    // smallest step is fifteen minutes — fifteen minutes nobody waits for in a
    // test — so the timer is armed through the diagnostic hook. It is the same
    // path either way (`armSleep` → `setSleep` → `engine.fadeOut`), so what runs
    // here is the real fade, the real suspend and the real resume.
    //
    // The pointer move is part of it: the controls are spec §4's "hidden until
    // the pointer moves", and the HUD's own 4.2 s hide timer runs out while the
    // fade below is watched, so both halves of that rule get checked.
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 40, y: 40 });
    await delay(250);
    const hudShown = await client.evaluate<boolean>(
      'document.getElementById("hud").classList.contains("visible")',
    );
    check('the controls appear when the pointer moves', hudShown, hudShown ? 'visible' : 'still hidden');

    await client.evaluate('__foraver.armSleep(8)');
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
    // and it has two halves: while asleep nothing moves, and on resume the
    // clock has not run on. Both are wall-clock comparisons, so both read the
    // journey clock and `performance.now()` in one instant, inside the page — a
    // host timestamp against a page one is skewed by round trips that run to
    // seconds here, which would fail a healthy build or pass a broken one.
    const readClocks = async (): Promise<{ clock: number; wall: number }> =>
      JSON.parse(
        await client.evaluate<string>(
          'JSON.stringify({ clock: __foraver.stats().clock, wall: performance.now() / 1000 })',
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
      '__foraver.offline({ seed: "offline-check", seconds: 45 })',
      // Rendering 45 s of a techno graph faster than real time is not instant,
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
    check(
      'the true peak stays under the ceiling',
      Number.isFinite(offline.truePeakDb) && offline.truePeakDb <= 0.5,
      `${offline.truePeakDb.toFixed(2)} dBTP (ceiling -1 dBTP)`,
    );
    // A techno set is four on the floor: if the offline render scheduled no
    // bars, or bars with no voices in them, the picture would have been the only
    // thing playing.
    check(
      'the offline pass scheduled real music',
      offline.bars >= 10 && offline.voices > 100,
      `${offline.bars} bars, ${offline.voices} voices in ${offline.seconds} s`,
    );

    // Seed links (spec §4: "a seed (and a 'copy link' that carries it)"). A link
    // is worth nothing unless it reproduces the set, and the conductor is pure
    // and time-addressable, so that is checked rather than asserted: describe
    // the set at three times here, then come back to the same seed in a *fresh*
    // page and describe it again.
    const readJourney = async (): Promise<JourneyReading> =>
      JSON.parse(
        await client.evaluate<string>(
          'JSON.stringify({ seed: __foraver.seed, hash: location.hash, ' +
            'input: document.getElementById("seed").value, ' +
            'probes: [0, 600, 3600].map((t) => __foraver.pieceAt(t)) })',
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
          .evaluate<string>('JSON.stringify({ ready: document.readyState, seed: __foraver?.seed ?? null })')
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
        JSON.stringify(other.probes) !== JSON.stringify(first.probes),
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
    // same seed. `first` was read from the page the skip key rewrote, and a
    // forced change is deliberately not seed-deterministic — a set someone has
    // skipped through is not the set the seed alone would have played — so
    // comparing against it would be testing the skip, not the link. Go away to
    // another seed and back, which is two clean loads of the same set.
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

    if (client.logs.length) {
      console.log('\n  console:');
      for (const entry of client.logs.slice(0, 12)) console.log(`    [${entry.level}] ${entry.text.slice(0, 160)}`);
    }
    console.log(`\n  screenshots: ${join(ROOT, '.smoke', 'smoke.png')}, ${join(ROOT, '.smoke', 'drop.png')}`);
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
    out.push(await client.evaluate<number>('__foraver.stats().pulse'));
    await delay(60);
  }
  return out;
}

await main().catch((error) => {
  console.error(error);
  process.exit(2);
});
