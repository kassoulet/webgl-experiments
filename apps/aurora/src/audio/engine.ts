// Aurora audio engine: synth-pop with lush pads, bright arps, and sidechain.
//
// The engine owns the AudioContext. Scheduling is a lookahead loop: every tick
// it asks the conductor for the next few bars (in conductor time, which starts
// at zero) and places them at `epoch + conductor time`, where the epoch is the
// context time the set began at — the two clocks are related but not equal.

import { Conductor } from '../conductor.ts';
import { INSTRUMENTS, patternsFor, type Instrument } from '../patterns.ts';
import { midiToHz } from '../harmony.ts';
import { LoudnessMeter, dbToGain } from './loudness.ts';
import { meterWorkletUrl } from './meter-worklet.ts';
import { clamp, createNoiseBuffer, createReverbImpulse, saturationCurve } from './dsp.ts';
import * as voices from './voices.ts';
import type { ChordAt, EngineStats, Profile, Seed, SleepState } from '../types.ts';

export const TARGET_LUFS = -14;
export const TRUE_PEAK_CEILING_DB = -1;

/** How far ahead of the context clock the scheduler writes (seconds). */
const LOOKAHEAD = 12;
/** How often the scheduler wakes up to top the lookahead up (ms). */
const TICK_MS = 250;
/** The sleep fade's length: the set dims out over its final seconds. */
const SLEEP_FADE = 10;

export interface EngineOptions {
  seed: Seed;
  profile: Profile;
  conductor: Conductor;
  volume: number;
}

export class Engine {
  readonly conductor: Conductor;
  readonly ctx: BaseAudioContext;
  readonly profile: Profile;
  readonly seed: Seed;

  private readonly masterGain: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly levellerGain: GainNode;
  private readonly userGain: GainNode;
  private readonly fadeGain: GainNode;
  private readonly reverb: ConvolverNode;
  private readonly sidechain: GainNode;
  private readonly noiseBuffer: AudioBuffer;
  private readonly saturation: Float32Array<ArrayBuffer>;
  /** Every node created after the fact, so a close can drop them at once. */
  private readonly graph: AudioNode[] = [];

  private readonly voices = new Map<Instrument, voices.Voice[]>();
  /** Voices started since the engine started: cumulative, so it only grows —
   * the soak's line for a scheduler that quietly stopped producing. */
  private voicesStarted = 0;

  private lufs = -Infinity;  private truePeakDb = -Infinity;
  private messages = 0;
  private meterAvailable = false;

  private running = false;
  private ticker: ReturnType<typeof setInterval> | null = null;
  /** The context time bar zero begins at; fixed on the first tick. */
  private epoch = 0;
  private nextBar = 0;
  private nextBarTime = 0;
  private scheduledUntil = 0;
  private trimDb = 0;
  private volume: number;
  private asleep = false;
  /** Context time the sleep timer fires at; null while no timer is armed. */
  private sleepAt: number | null = null;

  constructor(opts: EngineOptions) {
    this.conductor = opts.conductor;
    this.profile = opts.profile;
    this.seed = opts.seed;
    this.volume = opts.volume;

    const Ctor = (globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio is not available in this browser');
    this.ctx = new Ctor();

    this.masterGain = this.ctx.createGain();
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.05;

    // The leveller is the loudness feedback's hand on the fader; the user gain
    // is the volume control; the fade is the sleep timer's.
    this.levellerGain = this.ctx.createGain();
    this.userGain = this.ctx.createGain();
    this.userGain.gain.value = this.volume;
    this.fadeGain = this.ctx.createGain();

    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = createReverbImpulse(this.ctx, opts.profile.reverbSeconds);

    this.sidechain = this.ctx.createGain();

    this.noiseBuffer = createNoiseBuffer(this.ctx, 2);
    this.saturation = saturationCurve(0.35);

    this.masterGain.connect(this.limiter);
    this.limiter.connect(this.levellerGain);
    this.levellerGain.connect(this.userGain);
    this.userGain.connect(this.fadeGain);
    this.fadeGain.connect(this.ctx.destination);

    // Reverb send: dry straight out, wet through the impulse response.
    const dry = this.ctx.createGain();
    dry.gain.value = 0.7;
    const wet = this.ctx.createGain();
    wet.gain.value = 0.3;
    this.masterGain.connect(dry);
    this.masterGain.connect(wet);
    wet.connect(this.reverb);
    dry.connect(this.ctx.destination);
    this.reverb.connect(this.ctx.destination);
  }

  /** Start the scheduler and put the meter tap on the master bus. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.#setupMeter();
    this.schedule();
    this.ticker = setInterval(() => {
      try {
        this.schedule();
        this.#sleepTick();
      } catch (error) {
        console.error('[engine] scheduler error', error);
      }
    }, TICK_MS);
  }

  stop(): void {
    this.running = false;
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  async suspend(): Promise<void> {
    this.asleep = true;
    this.sleepAt = null;
    this.stop();
    this.fadeGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.5);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const ctx = this.ctx as AudioContext;
    if (typeof ctx.suspend === 'function') await ctx.suspend();
  }

  async resume(): Promise<void> {
    const ctx = this.ctx as AudioContext;
    if (typeof ctx.resume === 'function') await ctx.resume();
    this.asleep = false;
    this.fadeGain.gain.setTargetAtTime(1, this.ctx.currentTime, 0.5);
    this.start();
  }

  asleepState(): boolean {
    return this.asleep;
  }

  /** The context clock, in seconds — the live time everything else is read against. */
  clock(): number {
    return this.ctx.currentTime;
  }

  /** The context time bar zero began at; 0 until the first scheduler tick. */
  startTime(): number {
    return this.epoch;
  }

  /** Arm the sleep timer, in seconds from now. */
  armSleep(seconds: number): void {
    this.sleepAt = this.ctx.currentTime + seconds;
  }

  cancelSleep(): void {
    this.sleepAt = null;
    this.fadeGain.gain.setTargetAtTime(1, this.ctx.currentTime, 0.5);
  }

  /** True once, and until main.ts acts on it: the caller clears state on wake. */
  sleepDue(): boolean {
    return this.sleepAt !== null && this.ctx.currentTime >= this.sleepAt;
  }

  /** The sleep timer's public state, in the shape the HUD and stats want. */
  sleepStateAt(_t: number): SleepState {
    if (this.sleepAt === null) return { at: null, secondsLeft: null, dim: 1 };
    const secondsLeft = Math.max(0, this.sleepAt - this.ctx.currentTime);
    return { at: this.sleepAt, secondsLeft, dim: clamp(secondsLeft / SLEEP_FADE, 0, 1) };
  }

  /** Ride the fade down as the timer runs out; main.ts does the suspending. */
  #sleepTick(): void {
    if (this.sleepAt === null) return;
    const remaining = this.sleepAt - this.ctx.currentTime;
    if (remaining <= 0 || remaining > SLEEP_FADE) return;
    this.fadeGain.gain.setTargetAtTime(0, this.ctx.currentTime, Math.max(0.2, remaining / 3));
  }

  getStats(): EngineStats {
    return {
      lufs: this.lufs,
      truePeakDb: this.truePeakDb,
      trimDb: this.trimDb,
      bars: this.nextBar,
      voices: this.voicesStarted,
      clock: this.ctx.currentTime,
      messages: this.messages,
      meterAvailable: this.meterAvailable,
    };
  }

  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    this.userGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
  }

  /**
   * The loudness tap: an AudioWorklet copies the master signal out in blocks
   * and this pushes them through the same BS.1770 math the offline render
   * measures with (src/audio/loudness.ts). The trim rides the leveller to hold
   * the set at TARGET_LUFS. No worklet (old Safari, a blocked module): the
   * trim stays put and the set still plays.
   */
  async #setupMeter(): Promise<void> {
    const ctx = this.ctx as AudioContext;
    const meter = new LoudnessMeter(ctx.sampleRate, 2);
    if (!ctx.audioWorklet) return;
    try {
      const url = meterWorkletUrl();
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const tap = new AudioWorkletNode(ctx, 'loudness-processor', { numberOfInputs: 1, numberOfOutputs: 1 });
      tap.port.onmessage = (message: MessageEvent) => {
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
        const trim = Math.min(0, TARGET_LUFS - this.lufs);
        if (Number.isFinite(trim)) {
          this.trimDb = trim;
          this.levellerGain.gain.setTargetAtTime(dbToGain(trim), this.ctx.currentTime, 2);
        }
      };
      // The tap copies the master out and emits nothing: through a silent gain
      // so the graph pulls it without its (silent) output reaching the speakers.
      const silence = this.ctx.createGain();
      silence.gain.value = 0;
      this.fadeGain.connect(tap);
      tap.connect(silence);
      silence.connect(this.ctx.destination);
      this.graph.push(tap, silence);
      this.meterAvailable = true;
    } catch (error) {
      console.warn('[engine] loudness meter unavailable', error);
    }
  }

  schedule(): void {
    if (!this.running) return;
    // The epoch is fixed the first time the context clock is actually moving:
    // before a user gesture the context is suspended and currentTime is 0.
    if (this.epoch === 0) {
      if (this.ctx.currentTime <= 0) return;
      this.epoch = this.ctx.currentTime;
    }
    const until = this.ctx.currentTime + LOOKAHEAD;
    if (this.scheduledUntil >= until) return;

    while (this.nextBarTime < until) this.scheduleBar(this.nextBar++);
    this.scheduledUntil = until;
  }

  private scheduleBar(bar: number): void {
    const conductorTime = this.conductor.timeOfBar(bar);
    const barTime = this.epoch + conductorTime;
    this.nextBarTime = barTime;
    if (barTime < this.ctx.currentTime - 0.1) return;

    const at = this.conductor.sectionAt(conductorTime);
    const entry = at.entry;
    const section = entry.section;
    const chord = this.conductor.chordAt(conductorTime);
    const patterns = patternsFor(String(this.seed), bar, section.name);
    const levelScale = this.profile.synthVoices;

    for (const inst of INSTRUMENTS) {
      const level = section[inst] * levelScale;
      if (level <= 0) continue;
      const voice = this.getVoice(inst);
      if (!voice) continue;
      const pattern = patterns[inst];
      if (!pattern) continue;

      for (let step = 0; step < 16; step++) {
        if (!pattern[step]) continue;
        const stepTime = barTime + (step / 16) * entry.barSeconds;
        if (stepTime < this.ctx.currentTime) continue;
        voice.play(stepTime, this.freqFor(inst, chord, step), level, section, entry.barSeconds);
        this.voicesStarted++;
      }
    }
    // Piece events (swell, sparkle, wave, flare, shimmer) arrive through the
    // section levels and the conductor's pulse rather than as scheduled voices:
    // the offline pass measures the bed, and the flash budget keeps the peaks
    // inside the photosensitivity cap either way (see conductor.pulseAt).
  }

  private getVoice(inst: Instrument): voices.Voice | null {
    let pool = this.voices.get(inst);
    if (!pool) {
      // A small pool per instrument; the profile's synthVoices scales it down
      // on phones (where it also scales the levels).
      const size = Math.max(1, Math.round((inst === 'pad' || inst === 'arp' ? 6 : 3) * this.profile.synthVoices));
      pool = [];
      for (let i = 0; i < size; i++) {
        pool.push(voices.create(inst, this.ctx, this.masterGain, this.sidechain, this.noiseBuffer, this.saturation, 1)[0]!);
      }
      this.voices.set(inst, pool);
    }
    for (const v of pool) if (v.free) return v;
    return pool[0] ?? null;
  }

  private freqFor(inst: Instrument, chord: ChordAt, step: number): number {
    switch (inst) {
      case 'kick': return 50;
      case 'bass': return midiToHz(chord.entry.bassNotes[step % chord.entry.bassNotes.length] ?? 40);
      case 'hat': return 8000;
      case 'clap': return 2000;
      case 'perc': return 4000;
      case 'stab': return midiToHz(chord.entry.stabNotes[step % chord.entry.stabNotes.length] ?? 60);
      case 'arp': return midiToHz((chord.entry.stabNotes[step % chord.entry.stabNotes.length] ?? 60) + 12);
      case 'pad': return midiToHz(chord.entry.padNotes[step % chord.entry.padNotes.length] ?? 52);
      case 'fx': return 1000;
      default: return 440;
    }
  }
}
