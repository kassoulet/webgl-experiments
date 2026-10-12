// The app (spec §4, §5). It owns one clock — the AudioContext's — and reads two
// things from the conductor each frame: the state both halves share, and where
// the camera is. Nothing else crosses between the sound and the picture.

import { Conductor } from './conductor.ts';
import { Engine } from './audio/engine.ts';
import { Renderer } from './visuals/renderer.ts';
import { detectProfile } from './profile.ts';
import { cleanSeed, formatSeedHash, parseSeed } from './seed.ts';
import { randomSeed } from './rng.ts';
import { initUI } from './ui.ts';
import { registerServiceWorker } from './pwa.ts';
import { renderOffline } from './offline.ts';
import type { DrawOptions, SingularityDebug } from './debug.ts';
import type { FrameOverrides } from './visuals/renderer.ts';
import type { Camera, Quality, RenderStats, SleepState } from './types.ts';

const DEFAULT_VOLUME = 0.7;
const HUD_EVERY_FRAMES = 24;

const profile = detectProfile();
const hash = globalThis.location.hash;
const seed = parseSeed(hash) ?? randomSeed();
const qualityParam = hash.match(/[?&]q=([^&]+)/);
const initialQuality = qualityParam ? qualityParam[1] : 'auto';

// The conductor is the piece; the engine and the renderer only read it.
const conductor = new Conductor(seed);
const engine = new Engine({ seed, profile, conductor, volume: DEFAULT_VOLUME });
const renderer = new Renderer(mustCanvas('sky'), { profile, seed, quality: initialQuality as Quality });

/** The picture's canvas, from index.html. */
function mustCanvas(id: string): HTMLCanvasElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLCanvasElement)) {
    throw new Error(`[app] index.html is missing the #${id} canvas`);
  }
  return element;
}

/** The quality control is a `<select>`; anything unexpected means 'auto'. */
function toQuality(value: string): Quality {
  return value === 'low' || value === 'high' ? value : 'auto';
}

let started = false;
let startedAt = 0;
let frameId = 0;
let frameCount = 0;
let audioOnly = false;
let asleep = false;
/** A diagnostic draw pins the picture to this moment; null follows the journey. */
let frozenAt: number | null = null;
/**
 * The overrides and the camera of the last diagnostic draw, kept so the frame
 * loop redraws the *same* frame while the picture is pinned. Without them a
 * capture would race a redraw that puts the stars back, or — worse, because it
 * looks fine — a redraw from the conductor's own camera instead of the one the
 * caller asked to look through.
 */
let frozenOverrides: FrameOverrides | undefined;
let frozenCamera: Camera | undefined;

const ui = initUI({
  onEnter: enter,
  onNewSeed: () => {
    globalThis.location.hash = formatSeedHash(randomSeed());
    globalThis.location.reload();
  },
  onCopyLink: copyLink,
  onVolume: (volume) => engine.setVolume(volume),
  onQuality: (quality) => {
    const chosen = toQuality(quality);
    renderer.setQuality(chosen);
    ui.toast(chosen === 'auto' ? 'visuals follow the frame rate' : `visuals: ${chosen}`);
  },
  onAudioOnly: (on) => setAudioOnly(on),
  onSleep: (minutes) => setSleep(minutes),
  onSeed: (value) => {
    const cleaned = cleanSeed(value);
    if (!cleaned) {
      ui.toast('a seed needs at least one letter or digit');
      ui.setSeed(seed);
      return;
    }
    globalThis.location.hash = formatSeedHash(cleaned);
    globalThis.location.reload();
  },
  onNoticeAction: () => resumeFromSleep(),
});

ui.setSeed(seed);
ui.setVolume(DEFAULT_VOLUME);
ui.setStats({ mode: `${profile.name} profile` });

/** The one gesture browsers ask for (spec §4 "Start"). */
async function enter(): Promise<void> {
  if (started) return;
  ui.enter();

  // Picture first: if WebGL2 is missing the music should still start.
  if (!renderer.init()) {
    ui.notice(
      'WebGL2 is not available here, so the picture stays dark. The music needs no GPU and plays on.',
    );
  }

  try {
    await engine.start();
    engine.setVolume(DEFAULT_VOLUME);
  } catch (error) {
    // Audio is the point, but a silent picture is still better than a dead page:
    // say so, and keep the visuals running on the fallback clock.
    console.error('[app] audio failed to start', error);
    ui.notice(
      `Audio could not start here (${(error as Error).message}). The picture runs, and the journey will not be the same one.`,
    );
  }
  started = true;
  startedAt = performance.now();
  if (!document.hidden) startLoop();
}

/** The journey clock: the audio context when there is one, wall time otherwise.
 *  Audio and picture must read one clock or their drift comes apart. */
function journeyTime(): number {
  return engine.ctx ? engine.now : (performance.now() - startedAt) / 1000;
}

/** Fullscreen is a nicety; Safari on iOS has only the webkit spelling. */
type FullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

function requestFullscreen(): void {
  const el = document.documentElement as FullscreenElement;
  const request = el.requestFullscreen ?? el.webkitRequestFullscreen;
  if (!request) return;
  try {
    const result = request.call(el);
    if (result?.catch) result.catch(() => {});
  } catch {
    /* iOS Safari cannot fullscreen the document; it is not an error here */
  }
}

function loop(): void {
  frameId = requestAnimationFrame(loop);
  // A pinned frame keeps being drawn — the loop stays alive and the HUD honest —
  // but it is always the *same* moment, so a capture of it cannot race.
  const t = frozenAt ?? journeyTime();
  const state = conductor.stateAt(t);
  const camera = frozenCamera ?? conductor.cameraAt(t);
  renderer.render({ time: t, state, camera, dim: dimFactor(t), overrides: frozenOverrides });

  if (++frameCount % HUD_EVERY_FRAMES === 0) updateHud(t);
  if (engine.asleep()) suspendForSleep();
}

function startLoop(): void {
  if (frameId || !started || audioOnly || asleep) return;
  frameId = requestAnimationFrame(loop);
}

function stopLoop(): void {
  if (frameId) cancelAnimationFrame(frameId);
  frameId = 0;
}

function updateHud(t: number): void {
  ui.setInfo(conductor.describe(t));
  const stats = engine.stats();
  const render = renderer.stats();
  ui.setStats({
    fps: render.fps,
    scale: render.scale,
    steps: render.steps,
    lufs: stats.lufs,
    truePeakDb: stats.truePeakDb,
    grains: stats.grains,
    mode: `${render.volumetric ? 'volumetric' : 'layered'} · ${profile.name}`,
  });
}

/** How bright the picture is while the sleep timer runs its course. */
function dimFactor(t: number): number {
  if (!engine.sleepAt) return 1;
  const total = Math.max(1, engine.sleepAt - (engine.sleepStart ?? 0));
  return Math.min(1, Math.max(0, (engine.sleepAt - t) / total));
}

/** The sleep timer, for the HUD and for the diagnostic hook. */
function sleepState(): SleepState {
  const t = journeyTime();
  const at = engine.sleepAt;
  return {
    at,
    secondsLeft: at == null ? null : Math.max(0, at - t),
    dim: dimFactor(t),
  };
}

/** Audio-only: the canvas is dropped and no frame is drawn (spec §6). */
function setAudioOnly(on: boolean): void {
  audioOnly = Boolean(on);
  engine.setAudioOnly(audioOnly);
  renderer.setVisible(!audioOnly);
  ui.setAudioOnly(audioOnly);
  if (audioOnly) {
    stopLoop();
    ui.toast('screen off — the music keeps playing');
  } else if (!asleep) {
    startLoop();
    ui.toast('the picture is back');
  }
}

/**
 * The picture's `offline()`: draw the real shader at a chosen moment, with a few
 * uniforms chosen rather than measured, so a capture can compare two moments —
 * or isolate a star layer — instead of asserting what it would show.
 */
function draw(options: DrawOptions = {}): RenderStats {
  frozenAt = options.time ?? null;
  const t = options.time ?? journeyTime();
  const { stars, density, volumetric, brightness, flare } = options;
  // Each call says what the picture is: the frame loop keeps drawing this same
  // frame, overrides included, until the next call. (A renderer left in 'auto'
  // quality would still be re-scaling its buffer under us — which is why a
  // capture sets the quality first; see tools/stars.ts.)
  const overrides: FrameOverrides = { stars, density, volumetric, brightness, flare };
  frozenOverrides = Object.values(overrides).some((v) => v !== undefined) ? overrides : undefined;
  frozenCamera = options.camera;
  renderer.render({
    time: t,
    state: conductor.stateAt(t),
    camera: frozenCamera ?? conductor.cameraAt(t),
    dim: options.dim ?? dimFactor(t),
    overrides,
  });
  return renderer.stats();
}

function setSleep(minutes: number): void {
  if (!started) return;
  if (!minutes) {
    engine.cancelFadeOut();
    ui.toast('sleep timer off');
    return;
  }
  engine.fadeOut(minutes * 60);
  const seconds = Math.round(minutes * 60);
  // The HUD's steps are whole minutes; the diagnostic hook can arm a short one.
  ui.toast(seconds < 60 ? `fading out over ${seconds} seconds` : `fading out over ${minutes} minutes`);
}

/** The timer finished: stop drawing, suspend the clock, keep the state. */
function suspendForSleep(): void {
  if (asleep) return;
  asleep = true;
  stopLoop();
  ui.notice('Resting. The journey is paused exactly where it stopped.', 'resume');
  try {
    engine.suspend();
  } catch (error) {
    console.warn('[app] could not suspend', error);
  }
}

async function resumeFromSleep(): Promise<void> {
  asleep = false;
  ui.hideNotice();
  ui.setSleep(0);
  engine.cancelFadeOut();
  try {
    await engine.resume();
  } catch (error) {
    console.warn('[app] could not resume', error);
  }
  startLoop();
  ui.toast('carrying on');
}

async function copyLink(): Promise<void> {
  const url = `${globalThis.location.origin}${globalThis.location.pathname}${formatSeedHash(seed)}`;
  try {
    await navigator.clipboard.writeText(url);
    ui.toast('link copied — it carries the seed');
  } catch {
    ui.toast('copy this link from the address bar; the seed is in it');
  }
}

// A hidden tab throttles timers, but the audio thread already owns the next
// twelve seconds and the meter is measured there, so the piece keeps going.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopLoop();
  else startLoop();
});

document.addEventListener('keydown', (event) => {
  if (!started || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  if (event.key === 'm' || event.key === 'M') {
    const t = journeyTime();
    const newMood = conductor.forceNextSection(t);
    ui.toast(`scene: ${newMood}`);
  }
  if (event.key === 'v' || event.key === 'V') {
    const current = renderer.stats().quality;
    const next = current === 'auto' ? 'low' : current === 'low' ? 'high' : 'auto';
    renderer.setQuality(next);
    ui.toast(`visuals: ${next}`);
  }
  if (event.key === 'f' || event.key === 'F') {
    requestFullscreen();
  }
});

// A small diagnostic hook: the headless smoke test reads it, and so can anyone
// with the console open. It is the only global the app creates.
const diagnostics: SingularityDebug = {
  seed,
  profile,
  offline: (options = {}) => renderOffline({ profile, ...options }),
  stats: () => ({
    started,
    audioOnly,
    asleep,
    clock: journeyTime(),
    frames: frameCount,
    sleep: sleepState(),
    audio: engine.stats(),
    render: renderer.stats(),
    piece: conductor.describe(journeyTime()),
  }),
  pieceAt: (seconds) => conductor.describe(seconds),
  flareAt: (seconds) => conductor.flareAt(seconds),
  draw,
  armSleep: (seconds) => setSleep(seconds / 60),
};

globalThis.__singularity = diagnostics;

registerServiceWorker();
