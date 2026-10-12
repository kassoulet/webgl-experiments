#!/usr/bin/env node
// A real-browser smoke test, headless: load the page over HTTP, click "enter"
// like a person would, let it run, then check what actually happened — script
// errors, WebGL2, frames drawn, the clock advancing, and a screenshot that is
// decoded here and measured. A clean log proves nothing about a picture; a
// decoded PNG does.
//
// It drives the paths a reader actually takes and that nothing else reaches:
// the controls (spec §4) and the fade to sleep with its suspend and resume, the
// seed input and the URL fragment it reloads onto — including the same seed
// describing the same piece an hour in, in a fresh page — and "copy link",
// whose clipboard write is recorded so the URL it hands over can be checked.
//
//   npm run smoke            (or: node --experimental-strip-types tools/smoke.ts)
//   ... [--seconds 8] [--seed other] [--keep]
//
// Exits non-zero if a hard check fails.

import { promises as fs, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { launchChrome, type Chrome, type Harness } from './chrome.js';
import { decodePng, analyse, regionMean } from './png.js';
import type { PlayerStats } from '../src/types.js';
import type { OfflineMeasurement } from '../src/offline.js';
import { TARGET_LUFS } from '../src/audio/engine.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url))).replace(/\/tools-dist$/, '');
const ARTIFACTS = join(ROOT, '.smoke');
/** The smoke test runs the *build*, not the sources: this is what ships. */
const SITE = join(ROOT, 'dist');

const args = process.argv.slice(2);
const seconds = Number(readArg('--seconds') ?? 8);
const keep = args.includes('--keep');
// A fixed seed by default: two runs of the smoke test then render the same
// moment of the same journey, which is what makes its numbers comparable.
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

/** What a page says about the journey it is playing: the seed it took, the URL
 *  that carried it, and the piece it describes at three times in it. */
interface JourneyReading {
  seed: string;
  hash: string;
  input: string;
  probes: { key: string; chord: string; mood: string }[];
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
    await harness.go(seed, 'low');
    // Ready means loaded *and* the enter screen drawn: the diagnostic hook only
    // exists once main.ts has run.
    const ready = await harness.loaded();
    check('the page loads', ready);

    const beforeEnter = await client.evaluate<string>(
      'JSON.stringify({ seed: __singularity.seed, started: __singularity.stats().started })',
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
      JSON.parse(await client.evaluate<string>('JSON.stringify(__singularity.stats())')) as PlayerStats;

    // Software rendering (SwiftShader) is slow by nature — on a loaded machine
    // well under a frame a second — so wait for the evidence we need (frames
    // drawn, the clock running) rather than a fixed wall-clock. `--seconds`
    // still sets the minimum settle time; the cap only exists so a genuinely
    // broken renderer fails instead of hanging.
    const settleUntil = Date.now() + seconds * 1000;
    const frameDeadline = Date.now() + Math.max(seconds, 120) * 1000;
    let parsed = await readStats();
    for (;;) {
      const settled = Date.now() >= settleUntil;
      const evidence = parsed.frames >= 5 && parsed.clock > 1;
      if ((settled && evidence) || Date.now() >= frameDeadline) break;
      await delay(500);
      parsed = await readStats();
    }
    check('the renderer found WebGL2', parsed.render.available === true, `quality ${parsed.render.quality}`);
    // Software rendering (SwiftShader) is slow by nature; a handful of frames
    // still prove the pass runs, the shaders compile and the canvas has content.
    check('frames were drawn', parsed.frames >= 4, `${parsed.frames} frames, ${parsed.render.fps} fps`);
    check(
      'the audio clock is running',
      parsed.clock > 1,
      `clock ${parsed.clock?.toFixed?.(2)}s, trim ${parsed.audio.trimDb?.toFixed?.(1)} dB`,
    );
    check('the piece has a key, a chord and a mood', Boolean(parsed.piece?.chord && parsed.piece?.key), JSON.stringify(parsed.piece));
    check('no script errors on start', client.errors.length === 0, client.errors.slice(0, 3).join(' | '));

    // The picture itself (at auto quality, before any changes).
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
    check(
      'the picture has structure and colour',
      measured.stdev > 0.02 && measured.colourFraction > 0.02,
      `stdev ${measured.stdev.toFixed(4)}, coloured ${(measured.colourFraction * 100).toFixed(1)}%`,
    );
    // Deep space, not fog. The corners are not asserted to be darker than the
    // centre — the nebula is seeded and wanders, and a dark centre crop is a
    // legitimate frame — so what is asserted is a ceiling: the edges must not
    // be lifted into haze. The centre is measured and reported as context.
    const centre = regionMean(image, 0.35, 0.35, 0.65, 0.65);
    const corners =
      (regionMean(image, 0, 0, 0.18, 0.18) +
        regionMean(image, 0.82, 0, 1, 0.18) +
        regionMean(image, 0, 0.82, 0.18, 1) +
        regionMean(image, 0.82, 0.82, 1, 1)) / 4;
    check(
      'the edges are not lifted into haze',
      corners < 0.5 && measured.mean < 0.65,
      `corners ${corners.toFixed(4)}, centre ${centre.toFixed(4)}, mean ${measured.mean.toFixed(4)}`,
    );
    check('there is audio graph activity', parsed.audio.chords >= 1, `${parsed.audio.chords} chord voicings, ${parsed.audio.grains} grains`);

    // The controls (spec §4). These paths only run when someone touches them, so
    // the test touches them: volume, sleep, audio-only, and back. Quality starts
    // at 'low' for the test.
    await client.evaluate(`(() => {
      const set = (id, value, type = 'change') => {
        const el = document.getElementById(id);
        if (el.type === 'checkbox') el.checked = value; else el.value = value;
        el.dispatchEvent(new Event(type, { bubbles: true }));
      };
      set('volume', '0.42', 'input');
      set('sleep', '15');
      set('audio-only', true);
      document.getElementById('copy-link').click();
      return true;
    })()`);
    // Snapshot *after* enabling, not before: a screenshot stalls the compositor
    // for tens of seconds here, so an older frame count is not comparable.
    const hiddenStart = JSON.parse(await client.evaluate<string>('JSON.stringify(__singularity.stats())')) as PlayerStats;
    const framesBeforeSilence = hiddenStart.frames;
    await delay(1500);
    const silent = JSON.parse(await client.evaluate<string>('JSON.stringify(__singularity.stats())')) as PlayerStats;
    check(
      'audio-only draws nothing and keeps playing',
      silent.audioOnly === true &&
        silent.frames === framesBeforeSilence &&
        silent.clock > hiddenStart.clock,
      `${silent.frames - framesBeforeSilence} frames while hidden, ` +
        `clock ${hiddenStart.clock.toFixed(2)}s -> ${silent.clock.toFixed(2)}s`,
    );
    check(
      'quality starts at low for the test',
      silent.render.quality === 'low' && silent.render.volumetric === false && silent.render.steps <= 40,
      `quality ${silent.render.quality}, ${silent.render.steps} steps, volumetric ${silent.render.volumetric}`,
    );

    await client.evaluate(`(() => {
      const set = (id, value, type = 'change') => {
        const el = document.getElementById(id);
        if (el.type === 'checkbox') el.checked = value; else el.value = value;
        el.dispatchEvent(new Event(type, { bubbles: true }));
      };
      set('audio-only', false);
      set('sleep', '0');
      return true;
    })()`);
    await delay(2000);
    const awake = JSON.parse(await client.evaluate<string>('JSON.stringify(__singularity.stats())')) as PlayerStats;
    check('the picture comes back', awake.frames > silent.frames && awake.audioOnly === false, `${awake.frames - silent.frames} frames since`);
    check('the controls left no errors behind', client.errors.length === 0, client.errors.slice(0, 2).join(' | '));

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

    await client.evaluate('__singularity.armSleep(8)');
    const armed = await readStats();
    const armedLeft = armed.sleep.secondsLeft ?? -1;
    check(
      'the sleep timer arms on the journey clock',
      armed.sleep.at != null && armedLeft > 5 && armedLeft <= 8.5,
      `deadline ${armed.sleep.at?.toFixed(2)}s, ${armedLeft.toFixed(2)}s left, dim ${armed.sleep.dim.toFixed(3)}`,
    );

    await delay(2600);
    const dimming = await readStats();
    const dimmingLeft = dimming.sleep.secondsLeft ?? -1;
    check(
      'the fade dims the picture as it runs, without a jump',
      dimming.sleep.dim < 0.85 && dimming.sleep.dim < armed.sleep.dim && dimmingLeft < armedLeft,
      `dim ${armed.sleep.dim.toFixed(3)} → ${dimming.sleep.dim.toFixed(3)}, ` +
        `${armedLeft.toFixed(1)}s → ${dimmingLeft.toFixed(1)}s left`,
    );

    // The engine decides the piece should have stopped (a second past the fade);
    // the app's frame loop is what notices and suspends.
    let slept = await readStats();
    for (let attempt = 0; attempt < 40 && !slept.asleep; attempt++) {
      await delay(400);
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
      'the fade reaches silence and the piece suspends',
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

    // "The journey is paused exactly where it stopped" is a claim about the
    // clock, and it has two halves: while asleep nothing moves, and on resume the
    // clock has not run on. Both are wall-clock comparisons, so both read the
    // journey clock and `performance.now()` in one instant, inside the page — a
    // host timestamp against a page one is skewed by round trips that run to
    // seconds here, which would fail a healthy build or pass a broken one.
    const readClocks = async (): Promise<{ clock: number; wall: number }> =>
      JSON.parse(
        await client.evaluate<string>(
          'JSON.stringify({ clock: __singularity.stats().clock, wall: performance.now() / 1000 })',
        ),
      ) as { clock: number; wall: number };

    const heldFrames = slept.frames;
    const heldProbe = await readClocks();
    await delay(1200);
    const held = await readStats();
    const heldNow = await readClocks();
    const heldWall = heldNow.wall - heldProbe.wall;
    // Wall time must have moved, or a frozen page would pass this for the wrong
    // reason: the claim is that the journey stands still while the world does not.
    check(
      'a sleeping piece holds its clock while wall time runs on',
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
    // wall-clock interval, which is what the sleep fade above taught this test.
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
        (awakeAgain.frames > heldFrames || clockDelta > 0) &&
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
    // the same scheduler — and measure what comes out of the master. The app
    // exposes that path on the diagnostic hook (src/offline.ts); here it runs in
    // the page, against the build that ships.
    const offlineResult = await client.send<{ result: { value: OfflineMeasurement } }>('Runtime.evaluate', {
      expression: '__singularity.offline({ seed: "offline-check", seconds: 45 })',
      awaitPromise: true,
      returnByValue: true,
    }, 180000);
    const offline = offlineResult.result.value;
    check(
      'the engine renders signal offline',
      offline.rms > 0.004 && offline.peak > 0.02,
      `rms ${offline.rms.toFixed(5)}, peak ${offline.peak.toFixed(4)}`,
    );
    // The live trim moves this toward the target once the meter has blocks; here
    // the check is that the piece is in the region at all, and not silent or hot.
    check(
      'the master lands in the loudness region',
      Number.isFinite(offline.lufs) && offline.lufs > -30 && offline.lufs < -8,
      `${offline.lufs.toFixed(2)} LUFS over the last ${offline.seconds - offline.measureFrom} s ` +
        `(target ${TARGET_LUFS}) at trim ${offline.trimDb.toFixed(1)} dB`,
    );
    check(
      'the true peak stays under the ceiling',
      Number.isFinite(offline.truePeakDb) && offline.truePeakDb <= 0.5,
      `${offline.truePeakDb.toFixed(2)} dBTP (ceiling ${-1} dBTP)`,
    );
    check(
      'the offline pass scheduled real music',
      offline.chords >= 1 && offline.grains > 0,
      `${offline.chords} chord voicings, ${offline.grains} grains in ${offline.seconds} s`,
    );

    // Seed links (spec §4: "a seed (and a 'copy link' that carries it)"). A link
    // is worth nothing unless it reproduces the journey, and the conductor is
    // pure and time-addressable, so that is checked rather than asserted:
    // describe the piece at three times here, then come back to the same seed in
    // a *fresh* page and describe it again. The seed-input path is the one a
    // reader uses (`onSeed` → the URL fragment → reload), so it is driven there.
    const readJourney = async (): Promise<JourneyReading> =>
      JSON.parse(
        await client.evaluate<string>(
          'JSON.stringify({ seed: __singularity.seed, hash: location.hash, ' +
            'input: document.getElementById("seed").value, ' +
            'probes: [0, 600, 3600].map((t) => __singularity.pieceAt(t)) })',
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
          .evaluate<string>('JSON.stringify({ ready: document.readyState, seed: __singularity?.seed ?? null })')
          .catch(() => '{}');
        const parsed = JSON.parse(state) as { ready?: string; seed?: string | null };
        if (parsed.ready === 'complete' && parsed.seed === want) return true;
      }
      return false;
    };

    const first = await readJourney();
    const moments = new Set(first.probes.map((p) => `${p.key}/${p.chord}/${p.mood}`));
    check(
      'the journey can be described at any time in it',
      first.seed === seed && first.hash.startsWith(`#s=${seed}`) && first.probes.length === 3 && moments.size >= 2,
      `${first.probes.length} moments in, ${moments.size} distinct: ` +
        first.probes.map((p) => `${p.key} ${p.chord}`).join(' | '),
    );

    await setSeedInput('other-journey');
    const arrived = await waitForSeed('other-journey');
    const other = await readJourney();
    check(
      'another seed reloads into another journey, carried by the URL',
      arrived &&
        other.hash.startsWith('#s=other-journey') &&
        other.input === 'other-journey' &&
        JSON.stringify(other.probes) !== JSON.stringify(first.probes),
      `seed ${other.seed}, hash ${other.hash}, ` +
        other.probes.map((p) => `${p.key} ${p.chord}`).join(' | '),
    );

    // Junk is refused rather than followed: the reader keeps the journey they
    // had, and the URL is not rewritten into something that cannot be cleaned.
    await setSeedInput('***');
    await delay(800);
    const refused = await readJourney();
    const refusal = await client.evaluate<string>('document.getElementById("toast").textContent');
    check(
      'a junk seed is refused, not followed',
      refused.seed === 'other-journey' &&
        refused.input === 'other-journey' &&
        refused.hash === '#s=other-journey' &&
        /letter or digit/.test(refusal),
      `seed still ${refused.seed}, input back to "${refused.input}", toast "${refusal}"`,
    );

    await setSeedInput('smoke-test');
    const returned = await waitForSeed('smoke-test');
    const again = await readJourney();
    check(
      'a seed link reproduces the journey exactly, an hour in',
      returned && JSON.stringify(again.probes) === JSON.stringify(first.probes),
      again.probes.map((p) => `${p.key} ${p.chord} (${p.mood})`).join(' | '),
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
      'copy link hands over the link that carries this journey',
      copied.url === `${url.split('#')[0]}#s=${seed}` && /carries the seed/.test(copied.toast),
      `copied "${copied.url}" and said "${copied.toast}"`,
    );

    check('the new paths left no errors behind', client.errors.length === 0, client.errors.slice(0, 3).join(' | '));

    if (client.logs.length) {
      console.log('\n  console:');
      for (const entry of client.logs.slice(0, 12)) console.log(`    [${entry.level}] ${entry.text.slice(0, 160)}`);
    }
    console.log(`\n  screenshot: ${join(ROOT, '.smoke', 'smoke.png')}`);
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

await main().catch((error) => {
  console.error(error);
  process.exit(2);
});
