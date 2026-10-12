// The Aurora app entry point: wire the conductor, the engine and the renderer
// together, and give the smoke test a hook that can drive each of them.
//
// Two clocks meet here. The conductor's starts at zero; the AudioContext's
// starts whenever the browser's audio device does. Everything the picture
// reads goes through `journeyTime()`, which subtracts the engine's epoch, so a
// bar placed at conductor time 8 is drawn and heard at the same instant.

import { Conductor } from './conductor.ts';
import { Engine } from './audio/engine.ts';
import { Renderer } from './visuals/renderer.ts';
import { detectProfile, DEFAULT_FLASH_MODE } from './profile.ts';
import { parseSeed, randomSeed } from '@fractal-rave/shared';
import { initUI } from './ui.ts';
import { registerServiceWorker } from './pwa.ts';
import { renderOffline } from './offline.ts';
import type { DrawOptions, FrameInput } from './visuals/renderer.ts';
import type { FlashMode, RenderStats } from './types.ts';

const DEFAULT_VOLUME = 0.7;
/** The HUD is rewritten every this many frames; a text node per frame is waste. */
const HUD_EVERY_FRAMES = 24;

const profile = detectProfile();
const seed = parseSeed(globalThis.location.hash) ?? randomSeed();

const conductor = new Conductor(seed);
const engine = new Engine({ seed, profile, conductor, volume: DEFAULT_VOLUME });
const renderer = new Renderer(mustCanvas('visual'), { profile, seed, quality: 'auto' });

function mustCanvas(id: string): HTMLCanvasElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLCanvasElement)) throw new Error(`canvas #${id} not found`);
  return element;
}

let started = false;
let audioOnly = false;
let asleep = false;
let flashMode: FlashMode = DEFAULT_FLASH_MODE;
let frameId = 0;
let frameCount = 0;
/** Every draw since load — the soak's line for a renderer that quietly died. */
let framesDrawn = 0;
/** A diagnostic draw pins the picture to this moment; null follows the set. */
let frozenAt: number | null = null;
/** The overrides of the last diagnostic draw, kept so the frame loop redraws
 * the same pinned frame — otherwise the screenshot races the next redraw. */
let frozenOverrides: DrawOptions | null = null;

const ui = initUI({
  seed,
  onStart: () => {
    started = true;
    engine.start();
    startLoop();
  },
  onAudioOnly: (v) => {
    audioOnly = v;
    if (!started) return;
    if (v) stopLoop();
    else startLoop();
  },
  onFlashMode: (v) => {
    flashMode = v;
  },
  onQuality: (v) => {
    renderer.setQuality(v);
  },
  onVolume: (v) => {
    engine.setVolume(v);
  },
  onSleep: (seconds) => {
    if (seconds > 0) engine.armSleep(seconds);
    else engine.cancelSleep();
  },
});

registerServiceWorker();

/** Where the set is now, in conductor time. */
function journeyTime(): number {
  return Math.max(0, engine.clock() - engine.startTime());
}

function dimFactor(t: number): number {
  if (asleep) return 0;
  return engine.sleepStateAt(t).dim;
}

function startLoop(): void {
  if (frameId || !started || audioOnly || asleep) return;
  frameId = requestAnimationFrame(loop);
}

function stopLoop(): void {
  if (frameId) cancelAnimationFrame(frameId);
  frameId = 0;
}

function loop(): void {
  frameId = requestAnimationFrame(loop);
  const t = frozenAt ?? journeyTime();
  drawFrame(t, frozenOverrides ?? undefined);

  if (++frameCount % HUD_EVERY_FRAMES === 0) updateHud(t);
  if (!asleep && engine.sleepDue()) suspendForSleep();
}

/** One frame, with the exact shape the renderer wants. */
function drawFrame(t: number, overrides?: DrawOptions): void {
  const input: FrameInput = {
    time: t,
    state: conductor.stateAt(t, flashMode),
    dim: dimFactor(t),
    overrides,
  };
  renderer.render(input);
  framesDrawn++;
}

/** Everything a long soak samples, in one object, without touching the set. */
function stats(): {
  started: boolean;
  asleep: boolean;
  clock: number;
  frames: number;
  audio: ReturnType<Engine['getStats']>;
  render: RenderStats;
} {
  return {
    started,
    asleep,
    clock: journeyTime(),
    frames: framesDrawn,
    audio: engine.getStats(),
    render: renderer.getStats(),
  };
}

function updateHud(t: number): void {
  const piece = conductor.describe(t);
  const stats = engine.getStats();
  const rstats = renderer.getStats();
  ui.setInfo({
    section: piece.section,
    bpm: `${piece.bpm} bpm`,
    bar: piece.bar,
    key: piece.key,
    chord: `${piece.chord} → ${piece.next}`,
    palette: piece.palette,
  });
  ui.hud.set({
    lufs: stats.lufs.toFixed(1),
    peak: stats.truePeakDb.toFixed(1),
    voices: stats.voices,
    fps: Math.round(rstats.fps),
    scale: `${Math.round(rstats.scale * 100)}%`,
  });
}

/** The timer finished: stop drawing, suspend the clock, keep the state. */
async function suspendForSleep(): Promise<void> {
  if (asleep) return;
  asleep = true;
  stopLoop();
  await engine.suspend();
  ui.setAsleep(true);
}

/** Woken by a click anywhere: pick the set up exactly where it stopped. */
async function resumeFromSleep(): Promise<void> {
  if (!asleep) return;
  asleep = false;
  ui.setAsleep(false);
  await engine.resume();
  startLoop();
}

/**
 * Render the real conductor + patterns offline and measure the master with the
 * same BS.1770 math the live meter runs: the soak's periodic loudness probe.
 */
function offline(options: { seed?: string; seconds?: number; measureFrom?: number } = {}): ReturnType<typeof renderOffline> {
  return renderOffline(options.seed ?? seed, options.seconds ?? 30, profile, undefined, options.measureFrom);
}

/**
 * The picture's offline(): draw the real shader at a chosen moment, with a few
 * uniforms chosen rather than measured, so a capture can compare two moments —
 * or isolate one layer — instead of asserting what it would show.
 */
function draw(options: DrawOptions = {}): void {
  frozenAt = options.time ?? null;
  const t = options.time ?? journeyTime();
  frozenOverrides = options;
  drawFrame(t, options);
}

// Sleep keeps its own listeners: a click both wakes the set and re-arms the
// context if the browser took it back.
document.addEventListener('click', () => {
  void resumeFromSleep();
});
document.addEventListener('keydown', () => {
  void resumeFromSleep();
});

// The diagnostic hook: what the smoke test and soaks drive. Kept deliberately
// boring — every member is a thing a person could also do from the UI.
globalThis.__aurora = {
  conductor,
  engine,
  renderer,
  draw,
  offline,
  stats,
  pieceAt: (t: number) => conductor.describe(t),
  stateAt: (t: number) => conductor.stateAt(t),
  armSleep: (seconds: number) => engine.armSleep(seconds),
  getSeed: () => seed,
  setSeed: (s: string) => {
    globalThis.location.hash = `#s=${encodeURIComponent(s)}`;
    globalThis.location.reload();
  },
};
