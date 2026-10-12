// The audio engine: the graph, the scheduler and the master chain (spec §2, §5).
//
// This is the *fallback* engine of the roadmap's step 3 — the browser's own Web
// Audio graph — because Motif's wasm build (M8) does not exist yet. The shape is
// already the target one, so the swap is a swap and not a rewrite:
//
//   pads · drones · chords · scapes -> buses -> sends (one long reverb) ->
//   master (slow leveller -> saturation -> true-peak limiter -> trim)
//
// Everything the scheduler does is scheduled ahead on the AudioContext's own
// clock, so a throttled tab (or a locked phone) cannot make the music stutter:
// the audio thread owns the next dozen seconds once they are written down.

import { Conductor } from '../conductor.ts';
import { Rng } from '../rng.ts';
import { midiToHz } from '../harmony.ts';
import { LoudnessMeter, dbToGain } from './loudness.ts';
import { saturationCurve } from './tape.ts';
import { meterWorkletUrl } from './meter-worklet.ts';
import type { ChordEntry } from '../types.ts';
import type { EngineStats, Levels, Mood, MoodLevel, Profile, Seed } from '../types.ts';
import {
  ChordVoices,
  DroneBank,
  GrainCloud,
  Shimmer,
  Wind,
  createGrainBuffer,
  playEvent,
} from './voices.ts';

/** The spec's target: "around −18 to −16 LUFS, with real dynamics". */
export const TARGET_LUFS = -17;
export const TRUE_PEAK_CEILING_DB = -1;

/** Seconds of schedule written ahead of the clock. A background tab throttles
 *  timers to about one a second; twelve seconds is far more than that needs. */
const LOOKAHEAD = 12;
const TICK_MS = 250;
// Calibrated against an offline render of this very graph (see src/offline.ts,
// which measures it): at 0 dB the piece sits on the −17 LUFS target, so it
// starts a couple of dB under and lets the feedback bring it up. Starting quiet
// and rising is the only direction a listener cannot be annoyed by.
// Where the master starts, before the loudness feedback has any blocks: the
// pads and the drone bed are the body of the piece, so this is calibrated with
// them running (see the offline measurement in tools/smoke.ts).
const START_TRIM_DB = -5;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** The piece's room: a long, decaying hall with a few early reflections, built
 *  once (spec §2 "the reverb *is* the room of the piece"). */
export function createReverbImpulse(ctx: BaseAudioContext, seed = 0, seconds = 9): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(rate * seconds));
  const buffer = ctx.createBuffer(2, length, rate);
  const rng = new Rng(seed).fork('reverb');
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let lowpass = 0;
    for (let i = 0; i < length; i++) {
      const t = i / rate;
      const white = rng.signed();
      lowpass += (white - lowpass) * 0.34; // air, not a hiss of white noise
      data[i] = lowpass * Math.exp(-t / (seconds * 0.34));
    }
    const reflections = 16;
    for (let r = 0; r < reflections; r++) {
      const at = Math.floor((0.012 + rng.float() * 0.24) * rate);
      data[at] += rng.signed() * 0.45 * (1 - r / reflections);
    }
  }
  return buffer;
}

export interface EngineOptions {
  seed: Seed;
  profile: Profile;
  volume?: number;
  conductor?: Conductor | null;
  /** For offline rendering: the smoke test renders this very engine in an
   *  OfflineAudioContext and measures it. Left out, a live context is created. */
  ctx?: BaseAudioContext | null;
}

export class Engine {
  readonly seed: Seed;
  volume: number;
  readonly profile: Profile;
  readonly conductor: Conductor;
  trimDb: number;
  lufs: number;
  truePeakDb: number;
  grains: number;
  /** Loudness messages heard from the meter worklet: cumulative (see types.ts). */
  messages = 0;
  meterAvailable: boolean;
  stopped: boolean;
  audioOnly: boolean;
  started: boolean;
  sleepAt: number | null = null;
  sleepStart: number | null = null;
  sleepDuration = 0;

  private readonly injectedCtx: BaseAudioContext | null;
  private readonly rng: Rng;
  private lastChordTime: number;
  private chordCursor: number;
  private lastEventTime: number;
  private nextGrain: number;
  private readonly chords: ChordVoices[];
  private grainLevel = 0.6;
  private currentRootHz = 220;
  private mood: Mood | null = null;
  private busLevels: { pad: number; drone: number; scape: number; shimmer: number } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private meter: LoudnessMeter | null = null;
  private tap: AudioWorkletNode | null = null;

  // The graph, built in start(). Definite assignment: every method that touches
  // these only runs once the engine is started.
  ctx!: BaseAudioContext;
  private masterSum!: GainNode;
  private leveller!: DynamicsCompressorNode;
  private saturation!: WaveShaperNode;
  private limiter!: DynamicsCompressorNode;
  private trim!: GainNode;
  private user!: GainNode;
  private fade!: GainNode;
  private silence!: GainNode;
  private reverb!: ConvolverNode;
  private reverbReturn!: GainNode;
  private reverbSend!: GainNode;
  private buses!: Record<'pad' | 'drone' | 'scape' | 'event', GainNode>;
  private drone!: DroneBank;
  private wind!: Wind;
  private shimmer!: Shimmer;
  private cloud!: GrainCloud;

  constructor({ seed, volume = 0.7, profile, conductor = null, ctx = null }: EngineOptions) {
    this.seed = seed;
    this.volume = clamp(volume, 0, 1);
    this.profile = profile;
    this.conductor = conductor ?? new Conductor(seed);
    this.injectedCtx = ctx;
    this.rng = new Rng(seed).fork('engine');
    this.started = false;
    this.audioOnly = false;
    this.trimDb = START_TRIM_DB;
    this.lufs = -Infinity;
    this.truePeakDb = -Infinity;
    this.grains = 0;
    this.meterAvailable = false;
    this.lastChordTime = -1;
    this.chordCursor = 0;
    this.lastEventTime = 0;
    this.nextGrain = 0;
    this.chords = [];
    this.stopped = false;
  }

  get now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** Build the graph. Must be called from a user gesture (spec §4 "a single
   *  'enter' click"). */
  async start(): Promise<this> {
    if (this.started) return this;
    const audioGlobal = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
    const AudioContextClass = audioGlobal.AudioContext ?? audioGlobal.webkitAudioContext;
    if (!this.injectedCtx && !AudioContextClass) throw new Error('Web Audio is not available in this browser');
    const ctx = this.injectedCtx ?? new AudioContextClass!({ latencyHint: 'playback' });
    this.ctx = ctx;
    // An offline context (the smoke test's measurement pass) must not be resumed:
    // it starts when startRendering() is called and not before.
    if (!this.injectedCtx && ctx.state === 'suspended') await (ctx as AudioContext).resume();

    const { profile, seed } = this;
    // --- master ------------------------------------------------------------
    this.masterSum = ctx.createGain();
    this.masterSum.gain.value = 1;

    // A gentle bus compressor for glue. Its attack and release are clamped to
    // a second by the browser, so the *slow* levelling is the trim feedback
    // below, which is where a piece measured in tens of seconds belongs.
    this.leveller = ctx.createDynamicsCompressor();
    this.leveller.threshold.value = -26;
    this.leveller.knee.value = 14;
    this.leveller.ratio.value = 2.4;
    this.leveller.attack.value = 0.25;
    this.leveller.release.value = 1;

    this.saturation = ctx.createWaveShaper();
    this.saturation.curve = saturationCurve(0.22);
    this.saturation.oversample = '2x';

    // The true-peak limiter: fast, and only ever a few dB of work because the
    // trim keeps the piece at its target loudness in the first place.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.005;
    this.limiter.release.value = 0.25;

    this.trim = ctx.createGain();
    this.trim.gain.value = dbToGain(this.trimDb);
    this.user = ctx.createGain();
    this.user.gain.value = volumeCurve(this.volume);
    this.fade = ctx.createGain();
    this.fade.gain.value = 1;

    this.masterSum
      .connect(this.leveller)
      .connect(this.saturation)
      .connect(this.limiter)
      .connect(this.trim)
      .connect(this.user)
      .connect(this.fade);

    // Meter tap: connected through a silent gain so the graph always pulls it.
    this.silence = ctx.createGain();
    this.silence.gain.value = 0;
    this.fade.connect(this.silence).connect(ctx.destination);
    this.fade.connect(ctx.destination);

    // --- sends -------------------------------------------------------------
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = createReverbImpulse(ctx, this.rng.int(1e6), profile.reverbSeconds);
    this.reverbReturn = ctx.createGain();
    this.reverbReturn.gain.value = 0.85;
    this.reverb.connect(this.reverbReturn).connect(this.masterSum);
    this.reverbSend = ctx.createGain();
    this.reverbSend.connect(this.reverb);

    // --- buses -------------------------------------------------------------
    this.buses = {} as Record<'pad' | 'drone' | 'scape' | 'event', GainNode>;
    for (const name of ['pad', 'drone', 'scape', 'event'] as const) {
      const bus = ctx.createGain();
      bus.gain.value = 0;
      const send = ctx.createGain();
      // Space is part of the sound: the pads and scapes live mostly in the room.
      send.gain.value = name === 'pad' ? 0.5 : name === 'scape' ? 0.6 : name === 'drone' ? 0.2 : 0.8;
      bus.connect(this.masterSum);
      bus.connect(send).connect(this.reverbSend);
      this.buses[name] = bus;
    }

    // --- layers ------------------------------------------------------------
    this.drone = new DroneBank(ctx, this.buses.drone, { seed, warp: 1, age: 0.45 });
    this.wind = new Wind(ctx, this.buses.scape, { seed });
    this.shimmer = new Shimmer(ctx, this.buses.scape, { seed });
    this.cloud = new GrainCloud(ctx, this.buses.scape, {
      buffer: createGrainBuffer(ctx, this.rng.int(1e6)),
      seed,
      density: 1,
    });

    // --- metering ----------------------------------------------------------
    await this.#setupMeter();

    // --- the first chord and the first grain, then run the scheduler -------
    const now: number = this.now;
    this.conductor.ensure(now + LOOKAHEAD);
    const current = this.conductor.chordAt(now);
    this.#scheduleChord(current.entry, Math.max(now, current.entry.t));
    this.chordCursor = current.index + 1;
    this.lastEventTime = now;
    this.nextGrain = now + 1;
    this.#applyLevels(now, true);
    this.started = true;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (error) {
        console.error('[engine] scheduler error', error);
      }
    }, TICK_MS);
    return this;
  }

  async #setupMeter(): Promise<void> {
    const ctx = this.ctx;
    const meter = new LoudnessMeter(ctx.sampleRate, 2);
    this.meter = meter;
    if (!ctx.audioWorklet) return;
    try {
      const url = meterWorkletUrl();
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      this.tap = new AudioWorkletNode(ctx, 'loudness-tap', { numberOfInputs: 1, numberOfOutputs: 1 });
      this.tap.port.onmessage = (message: MessageEvent) => {
        const pcm = (message.data as { pcm?: Float32Array[] } | null)?.pcm;
        const left = pcm?.[0];
        if (!pcm || !left) return;
        // Counted before the metering: a soak reads this to tell "the audio
        // thread is still processing" from "the context clock is still moving",
        // which are different failures (silence looks like the first one).
        this.messages++;
        meter.push(pcm, left.length, 0);
        this.lufs = meter.shortTerm();
        this.truePeakDb = meter.truePeakDb();
      };
      this.fade.connect(this.tap);
      this.tap.connect(this.silence);
      this.meterAvailable = true;
    } catch (error) {
      // No worklet (old Safari, or a blocked module): the trim stays put and the
      // picture still gets its levels from the schedule.
      console.warn('[engine] loudness meter unavailable', error);
    }
  }

  /** One scheduler pass: chords, moods, grains and events, all written ahead. */
  tick(): void {
    if (!this.started || this.stopped) return;
    const now = this.now;
    const until = now + LOOKAHEAD;
    this.conductor.ensure(until + 2);

    // A throttled or sleeping tab can come back mid-chord: land on the chord it
    // is actually in rather than walking through the ones it missed.
    const current = this.conductor.chordAt(now);
    if (current.entry.t > this.lastChordTime) {
      this.#scheduleChord(current.entry, now);
      this.chordCursor = current.index + 1;
    }
    // Every change inside the window gets its voices ready in time.
    const chords = this.conductor.chords;
    for (let i = this.chordCursor; i < chords.length; i++) {
      const entry = chords[i];
      if (entry.t > until) break;
      this.#scheduleChord(entry, entry.t);
      this.chordCursor = i + 1;
    }

    // Far-away events.
    for (const event of this.conductor.eventsBetween(this.lastEventTime, until)) {
      playEvent(this.ctx, this.buses.event, event, { rootHz: this.currentRootHz });
    }
    this.lastEventTime = Math.max(this.lastEventTime, until);

    this.#applyLevels(now);
    this.#pumpGrains(now, until);
    this.cloud.reap(now);
    this.#adjustTrim(now);
    this.#publishLevels();
  }

  #scheduleChord(entry: ChordEntry, when: number): void {
    const ctx = this.ctx;
    const notesHz = entry.voicing.map(midiToHz);
    const rich = this.profile.padLayers > 1;
    const hold = entry.hold;

    // The outgoing chord: it takes its leave slowly, underneath the new one.
    for (const voices of this.chords.splice(0)) {
      voices.fade(0, clamp(hold * 0.35, 12, 40), when);
      voices.dispose(when + 45);
    }

    const mood = this.conductor.moodBlend(when).mood;
    const voices = new ChordVoices(ctx, this.buses.pad, {
      notesHz,
      level: 0.5,
      seed: this.rng.int(1e6),
      rich,
      mood,
    });
    voices.fade(1, clamp(hold * 0.4, 10, 30), when);
    this.chords.push(voices);

    this.currentRootHz = notesHz[0];
    this.drone.tune(midiToHz(entry.drone[0]), when, clamp(hold * 0.3, 8, 20));
    this.shimmer.tune(notesHz, when, clamp(hold * 0.3, 10, 22));
    this.cloud.setNotes([...notesHz, ...entry.drone.map(midiToHz)]);
    // Now and then the bed itself changes colour: a new interval fades in
    // under the others while the oldest leaves (spec §2's drone cross-fade).
    if (this.rng.chance(0.3)) {
      this.drone.crossFadeLayer(this.rng.pick([3, 4, 5, 10, 12, -5]), when, clamp(hold * 0.5, 15, 40));
    }
    this.lastChordTime = entry.t;
  }

  /** Moods and drift become bus levels, always as ramps over tens of seconds. */
  #applyLevels(now: number, immediate = false): void {
    const blend = this.conductor.moodBlend(now);
    const mood = blend.mood;
    const previous = blend.previous ?? mood;
    const drift = this.conductor.drift(now);
    const f = blend.fade;
    const pick = (key: MoodLevel): number => lerp(previous[key], mood[key], f);

    const pad = pick('pad') * (0.72 + 0.3 * drift.density);
    const drone = pick('drone') * (0.8 + 0.25 * drift.detune);
    const scape = pick('scape') * (0.72 + 0.3 * drift.warp);
    const shimmer = pick('shimmer') * drift.shimmer;
    const duration = immediate ? 0.5 : 24;

    this.busLevels = { pad: clamp(pad, 0, 1.2), drone: clamp(drone, 0, 1.2), scape: clamp(scape, 0, 1.2), shimmer: clamp(shimmer, 0, 1.2) };
    this.ramp(this.buses.pad.gain, this.busLevels.pad * 0.9, now, duration);
    this.ramp(this.buses.drone.gain, this.busLevels.drone * 0.85, now, duration);
    this.ramp(this.buses.scape.gain, this.busLevels.scape * 0.7, now, duration);
    this.ramp(this.buses.event.gain, 0.9, now, duration);
    this.drone.setLevel(this.busLevels.drone, duration);
    this.wind.setLevel(this.busLevels.scape, duration);
    this.shimmer.setLevel(this.busLevels.shimmer, duration);
    this.drone.setTape(
      {
        warp: clamp(drift.detune * 1.3, 0.35, 1.9),
        age: clamp(0.45 + (drift.warp - 1) * 0.6, 0.12, 0.95),
      },
      immediate ? 1 : 45,
    );
    this.grainLevel = pick('grains') * (0.7 + 0.4 * drift.density);
    this.mood = mood;
  }

  ramp(param: AudioParam, value: number, when: number, duration: number): void {
    if (duration <= 0.02) param.setValueAtTime(value, when);
    else param.setTargetAtTime(value, when, duration / 3);
  }

  /** Grains are scheduled ahead like everything else, so no timer decides them. */
  #pumpGrains(now: number, until: number): void {
    const density = this.profile.grainScale * (this.grainLevel ?? 0.6);
    const perSecond = clamp(this.cloud.rate() * density, 0, this.profile.maxGrains);
    if (perSecond <= 0) return;
    if (this.nextGrain < now) this.nextGrain = now + 0.05;
    while (this.nextGrain < until) {
      this.cloud.spawn(this.nextGrain, { level: clamp(0.6 + (this.grainLevel ?? 0.6) * 0.5, 0, 1.4) });
      this.nextGrain += 1 / perSecond;
      this.grains++;
    }
  }

  /** The slow leveller, on our own measurement: the piece finds the target on
   *  whatever speakers it is played through, without a jump anyone can hear. */
  #adjustTrim(now: number): void {
    const meter = this.meter;
    if (!this.meterAvailable || !meter) return;
    if (meter.blocks.length < 24 || !Number.isFinite(this.lufs)) return;
    const error = TARGET_LUFS - this.lufs;
    const step = clamp(error, -0.05, 0.05);
    this.trimDb = clamp(this.trimDb + step, -26, 6);
    this.trim.gain.setTargetAtTime(dbToGain(this.trimDb), now, 0.35);
  }

  /** Share the levels with the picture (spec §5: audio and visuals read the same
   *  state, and no audio data crosses into the GPU beyond a few uniforms). */
  #publishLevels(): void {
    const levels = this.conductor.levels;
    const { pad = 0.5, drone = 0.7, scape = 0.5, shimmer = 0.3 } = this.busLevels ?? {};
    const smooth = (key: keyof Levels, value: number): number =>
      (levels[key] = levels[key] + (value - levels[key]) * 0.05);
    smooth('pad', clamp(pad, 0, 1));
    smooth('drone', clamp(drone, 0, 1));
    smooth('scape', clamp(scape, 0, 1));
    smooth('shimmer', clamp(shimmer, 0, 1));
    // Loudness as a 0..1 brightness the nebula can breathe with.
    const fromLoudness = Number.isFinite(this.lufs) ? clamp((this.lufs + 34) / 16, 0, 1) : (this.mood?.brightness ?? 0.5);
    smooth('brightness', clamp(fromLoudness * 0.7 + (this.mood?.brightness ?? 0.5) * 0.3, 0, 1));
    smooth('peak', Number.isFinite(this.truePeakDb) ? clamp((this.truePeakDb + 24) / 24, 0, 1) : 0.5);
  }

  /** Volume, 0..1 from the slider, curved like a fader rather than a straight
   *  line (equal-power-ish, so the top of the range is usable). */
  setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1);
    if (!this.ctx) return;
    this.ramp(this.user.gain, volumeCurve(this.volume), this.now, 0.3);
  }

  /** Audio-only mode: the picture is stopped by the app; the music carries on
   *  (spec §4, §6 "audio-only mode draws no GPU"). */
  setAudioOnly(on: boolean): void {
    this.audioOnly = Boolean(on);
  }

  /** Sleep timer: a slow fade to silence, long enough to fall asleep inside. */
  fadeOut(seconds = 60): void {
    if (!this.ctx) return;
    const now = this.now;
    this.fade.gain.cancelScheduledValues(now);
    this.fade.gain.setValueAtTime(this.fade.gain.value, now);
    this.fade.gain.linearRampToValueAtTime(0, now + Math.max(5, seconds));
    this.sleepAt = now + seconds;
    this.sleepStart = now;
    this.sleepDuration = seconds;
  }

  cancelFadeOut(): void {
    if (!this.ctx) return;
    const now = this.now;
    this.fade.gain.cancelScheduledValues(now);
    this.fade.gain.setValueAtTime(this.fade.gain.value, now);
    this.fade.gain.linearRampToValueAtTime(1, now + 5);
    this.sleepAt = null;
    this.sleepStart = null;
  }

  /** Suspend the clock (the sleep timer): the journey is held, not lost. */
  suspend(): void {
    const ctx = this.ctx as AudioContext;
    if (ctx.suspend) void ctx.suspend();
  }

  /** Start the clock again after a sleep. */
  async resume(): Promise<void> {
    const ctx = this.ctx as AudioContext;
    if (ctx.resume) await ctx.resume();
  }

  /** Whether the music should have stopped by now (the app polls this). */
  asleep(): boolean {
    return this.sleepAt != null && this.now > this.sleepAt + 1;
  }

  /** A snapshot for the UI and for the picture. */
  stats(): EngineStats {
    return {
      lufs: this.lufs,
      truePeakDb: this.truePeakDb,
      trimDb: this.trimDb,
      chords: this.chords.length,
      grains: this.grains,
      clock: this.now,
      messages: this.messages,
      meterAvailable: this.meterAvailable,
    };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
    for (const voices of this.chords.splice(0)) voices.dispose();
    try {
      this.drone.dispose();
      this.wind.dispose();
      this.shimmer.dispose();
    } catch (error) {
      console.warn('[engine] dispose', error);
    }
    try {
      (this.ctx as AudioContext).close();
    } catch { /* already closed, or offline */ }
    this.started = false;
  }
}

/** A fader curve: quiet at the bottom, usable at the top. */
export function volumeCurve(volume: number): number {
  const v = clamp(volume, 0, 1);
  return v * v;
}
