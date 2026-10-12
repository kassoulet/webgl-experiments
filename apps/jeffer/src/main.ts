// The app. It owns one clock — the AudioContext's — and reads the conductor's
// state each frame. Exactly one thing crosses between the sound and the picture
// that is not a number the conductor made up: the scope frame, which is this
// instant's waveform and spectrum straight off the master's analyser. Everything
// else is the arrangement's own numbers, read on the same clock.

import { Conductor } from './conductor.ts';
import { Engine } from './audio/engine.ts';
import { Renderer } from './visuals/renderer.ts';
import { detectProfile, DEFAULT_FLASH_MODE } from './profile.ts';
import { cleanSeed, formatSeedHash, parseSeed } from './seed.ts';
import { randomSeed } from './rng.ts';
import { initUI } from './ui.ts';
import { registerServiceWorker } from './pwa.ts';
import { renderOffline } from './offline.ts';
import type { JefferDebug } from './debug.ts';
import type {
  DrawOptions,
  FlashMode,
  ForcedSection,
  Quality,
  RenderStats,
  ScopeFrame,
  ScopeSnapshot,
  SleepState,
} from './types.ts';

const DEFAULT_VOLUME = 0.7;
const HUD_EVERY_FRAMES = 24;

const profile = detectProfile();
const seed = parseSeed(globalThis.location.hash) ?? randomSeed();

// The conductor is the set; the engine and the renderer only read it.
const conductor = new Conductor(seed);
const engine = new Engine({ seed, profile, conductor, volume: DEFAULT_VOLUME });
const renderer = new Renderer(mustCanvas('visual'), { profile, seed, quality: 'auto' });

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

/** Likewise the flash mode, which is a photosensitivity decision and so has a
 *  default that is not "whatever the string said". */
function toFlashMode(value: string, current: FlashMode): FlashMode {
  return value === 'soft' || value === 'full' ? value : current;
}

let started = false;
let startedAt = 0;
let frameId = 0;
let frameCount = 0;
let audioOnly = false;
let asleep = false;
let flashMode: FlashMode = DEFAULT_FLASH_MODE;
/** A diagnostic draw pins the picture to this moment; null follows the set. */
let frozenAt: number | null = null;
/**
 * The overrides of the last diagnostic draw, kept so the frame loop redraws the
 * *same* frame while the picture is pinned. Without them a capture would race a
 * redraw that puts the layers back — or, worse, because it looks fine, a redraw
 * from the set's own drift instead of the frozen one the caller asked for.
 */
let frozenOverrides: DrawOptions | undefined;

renderer.setFlashMode(flashMode);

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
  onFlash: (value) => {
    const chosen = toFlashMode(value, flashMode);
    flashMode = chosen;
    renderer.setFlashMode(chosen);
    ui.toast(
      chosen === 'soft'
        ? 'flashes capped — the kick cannot take the whole screen'
        : 'flashes: full — a real strobe, if that is what you came for',
    );
  },
  onAudioOnly: (on) => setAudioOnly(on),
  onSleep: (minutes) => setSleep(minutes),
  onSeed: (value) => {
    const cleaned = cleanSeed(value);
    if (!cleaned) {
      ui.toast('a seed needs at least one letter or digit');
      ui.setSeed(String(seed));
      return;
    }
    globalThis.location.hash = formatSeedHash(cleaned);
    globalThis.location.reload();
  },
  onNoticeAction: () => resumeFromSleep(),
});

ui.setSeed(String(seed));
ui.setVolume(DEFAULT_VOLUME);
ui.setStats({ mode: `${profile.name} profile` });

/** The one gesture browsers ask for. */
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
    // say so, and keep the picture running on the fallback clock. The trace will
    // be flat, because with no signal there is nothing honest to draw.
    console.error('[app] audio failed to start', error);
    ui.notice(
      `Audio could not start here (${(error as Error).message}). The picture runs, and the set will not be the same one.`,
    );
  }
  started = true;
  startedAt = performance.now();
  if (!document.hidden) startLoop();
}

/** The journey clock: the audio context when there is one, wall time otherwise.
 *  Audio and picture must read one clock or their drift comes apart — and on
 *  this app that is not a rounding argument, because the oscilloscope's write
 *  head crosses once a bar and a picture a frame out of step with the music
 *  shows a trace that is measurably the wrong signal. */
function journeyTime(): number {
  return engine.context ? engine.now : (performance.now() - startedAt) / 1000;
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
  renderer.render({
    time: t,
    state: conductor.stateAt(t, flashMode),
    // The only honest input the picture gets: this instant's waveform and
    // spectrum, as they leave the limiter — or, while a capture has pinned one,
    // exactly the signal that capture asked for. Reading the live analyser here
    // would make `draw({ scope })` a lie: the frame would be correct for the
    // microsecond it was drawn and wrong by the time the screenshot was taken,
    // and a difference between two captures would be as likely to be the music
    // as the thing under test.
    scope: pinnedScope(frozenOverrides),
    dim: dimFactor(t),
    overrides: frozenOverrides,
  });

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
  const piece = conductor.describe(t);
  ui.setInfo({
    section: piece.section,
    bpm: `${piece.bpm} bpm`,
    chord: piece.chord,
    next: piece.next,
    bars: `bar ${piece.bar}`,
  });
  const stats = engine.stats();
  const render = renderer.stats();
  const [scope, colour, vhs, glitch] = render.layers;
  ui.setStats({
    fps: render.fps,
    scale: render.scale,
    scopeBins: render.scopeBins,
    mean: render.mean,
    lufs: stats.lufs,
    truePeakDb: stats.truePeakDb,
    voices: stats.voices,
    mode: `${render.quality} · ${layersLabel(scope, colour, vhs, glitch)} · ${piece.palette} · ${profile.name}`,
  });
}

/** Which layers are actually on screen, loudest first. Four numbers would be
 *  four more things to read, and the picture is the point. The scope wins a tie
 *  on purpose: it is the one layer that is real, and the others are weather. */
function layersLabel(scope: number, colour: number, vhs: number, glitch: number): string {
  const named: [string, number][] = [
    ['scope', scope],
    ['colour', colour],
    ['vhs', vhs],
    ['glitch', glitch],
  ];
  named.sort((a, b) => b[1] - a[1]);
  return named.slice(0, 2).map(([name]) => name).join('+');
}

/** How bright the picture is while the sleep timer runs its course. */
function dimFactor(t: number): number {
  if (engine.sleepAt == null) return 1;
  const total = Math.max(1, engine.sleepAt - (engine.sleepStart ?? 0));
  return Math.min(1, Math.max(0, (engine.sleepAt - t) / total));
}

/** The sleep timer, for the HUD and for the diagnostic hook. */
function sleepState(): SleepState {
  const t = journeyTime();
  const at = engine.sleepAt;
  return { at, secondsLeft: at == null ? null : Math.max(0, at - t), dim: dimFactor(t) };
}

/** Audio-only: the canvas is dropped and no frame is drawn. */
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
 * Draw one frame of the real picture at a chosen moment, with a few uniforms
 * chosen rather than measured, so a capture can compare two moments — or isolate
 * one layer — instead of asserting what it would show.
 */
function draw(options: DrawOptions = {}): RenderStats {
  frozenAt = options.time ?? null;
  const t = options.time ?? journeyTime();
  frozenOverrides = options;
  renderer.render({
    time: t,
    state: conductor.stateAt(t, flashMode),
    // A pinned `scope` is what makes two captures of one moment comparable:
    // without it each draw gets whatever the analyser is returning now, and a
    // difference between the frames is as likely to be the music as the thing
    // under test.
    scope: pinnedScope(options),
    dim: options.dim ?? dimFactor(t),
    overrides: options,
  });
  return renderer.stats();
}

/**
 * The signal a draw asked for, or the live one.
 *
 * A pinned `scope` is what makes two captures of one moment comparable: without
 * it each draw gets whatever the analyser is returning now, and a difference
 * between the frames is as likely to be the music as the thing under test. It
 * has to be honoured by the frame loop as well as by the draw itself, or the
 * pin lasts less than a frame.
 */
function pinnedScope(options: DrawOptions | undefined): ScopeFrame | null {
  if (options && 'scope' in options) return options.scope ?? null;
  return liveScope();
}

/** This instant's waveform and spectrum, or null when there is no audio. */
function liveScope(): ScopeFrame | null {
  return engine.context ? engine.scopeFrame() : null;
}

/** The same reading, as plain arrays, for a console and for a test. */
function scopeSnapshot(): ScopeSnapshot {
  const frame = engine.scopeFrame();
  return {
    wave: Array.from(frame.wave),
    spectrum: Array.from(frame.spectrum),
    peak: frame.peak,
    rms: frame.rms,
  };
}

/**
 * Cut the passage in progress short and start a new one, now. The conductor
 * decides where the change can land — on a bar line, a whole number of phrases
 * out — and the engine is told, so the audio already written ahead is dropped
 * rather than played over the top of the change.
 */
function skipSection(): ForcedSection {
  const forced = conductor.forceNextSection(journeyTime());
  engine.resync(forced.at, forced.bar);
  ui.toast(`section: ${forced.name} in ${forced.lead.toFixed(1)}s`);
  return forced;
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
  ui.notice('Resting. The set is paused exactly where it stopped.', 'resume');
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
// dozen seconds and the meter is measured there, so the set keeps going. The
// picture does not, and does not need to: a scope watching a paused tab is a
// scope with no signal.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopLoop();
  else startLoop();
});

document.addEventListener('keydown', (event) => {
  if (!started || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  if (event.key === 'n' || event.key === 'N') {
    // Skip to the next passage. A set that will not change for eight minutes is
    // a set you cannot hear the shape of.
    skipSection();
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
const diagnostics: JefferDebug = {
  seed,
  profile,
  offline: (options = {}) => renderOffline({ profile, ...options }),
  stats: () => ({
    started,
    audioOnly,
    asleep,
    clock: journeyTime(),
    frames: frameCount,
    pulse: conductor.stateAt(journeyTime(), flashMode).pulse,
    sleep: sleepState(),
    audio: engine.stats(),
    render: renderer.stats(),
    scope: scopeSnapshot(),
    piece: conductor.describe(journeyTime()),
  }),
  pieceAt: (seconds) => conductor.describe(seconds),
  armSleep: (seconds) => setSleep(seconds / 60),
  skipSection,
  draw,
};

globalThis.__jeffer = diagnostics;

registerServiceWorker();
