// The audio engine: the graph, the scheduler and the master chain (spec §2, §5).
//
// This is the *fallback* engine of the roadmap's step 3 — the browser's own Web
// Audio graph — because Motif's wasm build (M8) does not exist yet. The shape is
// already the target one, so the swap is a swap and not a rewrite:
//
//   drums (kick bass clap hat perc) ┐
//   synth (stab arp pad) ── echo ───┼─> master (leveller -> saturation ->
//   fx (risers, impacts, crashes) ───┘    limiter -> trim -> user -> fade)
//
// Everything the scheduler does is written ahead on the AudioContext's own
// clock, so a throttled tab (or a locked phone) cannot make the set stutter:
// the audio thread owns the next dozen seconds once they are written down.

import { Conductor } from '../conductor.ts';
import { patternsFor, VOICE_TONES, type BarPatterns, type Instrument } from '../patterns.ts';
import { midiToHz } from '../harmony.ts';
import { hashString } from '@fractal-rave/shared';
import { LoudnessMeter, dbToGain } from './loudness.ts';
import { clamp, createNoiseBuffer, createReverbImpulse, saturationCurve } from './dsp.ts';
import { meterWorkletUrl } from './meter-worklet.ts';
import * as voices from './voices.ts';
import type { ChordEntry, EngineStats, Levels, Profile, Seed } from '../types.ts';

/** The spec's target. Techno is loud: −15…−13 LUFS, still under the −1 dBTP
 *  ceiling, still with a master limiter doing only a few dB of work. */
export const TARGET_LUFS = -14;
export const TRUE_PEAK_CEILING_DB = -1;

/** Seconds of schedule written ahead of the clock. A background tab throttles
 *  timers to about one a second; twelve seconds is far more than that needs. */
const LOOKAHEAD = 12;
const TICK_MS = 250;

/** Where the master starts, before the loudness feedback has any blocks. A set
 *  that faded in would be wrong here: the entrance click is the entrance. */
const START_TRIM_DB = -3;

/** How long a scheduled gate is kept before it is disconnected (spec §5).
 *  It only has to outlive the longest thing written through it — a pad
 *  lasting a chord, a riser lasting two bars — so half a minute is generous.
 *  Past that the node is disconnected so the graph can let it go; a
 *  disconnected gate cannot be reused, and a live one is a leak. */
const GATE_KEEP_S = 30;

/** The nine buses. Eight are stepped instruments with a pattern of their own;
 *  the pad is the sustained one, scheduled per chord rather than per bar. */
type BusName = Instrument | 'pad' | 'fx';

/**
 * A gain node put in front of one scheduled bar, event or pad, so that a
 * forced section change can silence it.
 *
 * Web Audio has no "unschedule": a voice written into the graph for a time
 * that has not arrived yet will sound, whether or not the set still wants it.
 * Since the engine writes twelve seconds ahead, truncating the arrangement
 * (see `Conductor.forceNextSection`) is not enough on its own — the audio for
 * the abandoned passage is already committed. Fading its gates is how the
 * change is heard now rather than in twelve seconds' time.
 */
interface ScheduledGate {
  /** When the thing behind this gate starts, on the context clock. */
  at: number;
  node: GainNode;
}

/** Each bus's own weight, so the mix balance is one number per instrument. */
const BUS_GAIN: Record<BusName, number> = {
  kick: 1,
  bass: 0.95,
  clap: 0.8,
  hat: 0.5,
  perc: 0.55,
  stab: 0.9,
  arp: 0.9,
  pad: 0.85,
  fx: 0.8,
};

/** How much of each bus goes to the echo and to the room. */
const ECHO_SEND: Record<BusName, number> = {
  kick: 0, bass: 0, clap: 0.08, hat: 0.06, perc: 0.12,
  stab: 0.4, arp: 0.34, pad: 0.12, fx: 0.25,
};
const ROOM_SEND: Record<BusName, number> = {
  kick: 0, bass: 0, clap: 0.3, hat: 0.16, perc: 0.24,
  stab: 0.35, arp: 0.3, pad: 0.5, fx: 0.6,
};

export interface EngineOptions {
  seed: Seed;
  profile: Profile;
  volume?: number;
  conductor?: Conductor | null;
  /** For offline rendering: the smoke test renders this very engine in an
   *  OfflineAudioContext and measures it. Left out, a live context is created
   *  and the scheduler runs on a timer. */
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
  /** Voices started since the engine started: cumulative, so it only grows. */
  voices = 0;
  /** Bars written into the schedule: cumulative, so a stall is visible. */
  barsScheduled = 0;
  /** Loudness messages heard from the meter worklet: cumulative (see types.ts). */
  messages = 0;
  meterAvailable: boolean;
  stopped: boolean;
  audioOnly: boolean;
  started: boolean;
  sleepAt: number | null = null;
  sleepStart: number | null = null;

  private readonly injectedCtx: BaseAudioContext | null;
  /** True when this engine is rendering offline: there is no timer to schedule
   *  from, so `start()` writes the whole render down in one pass. */
  private readonly offline: boolean;
  private readonly seedValue: number;
  private nextBar: number | null = null;
  private nextBarTime = 0;
  private scheduledPadChord = -1;
  private lastEventTime = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private meter: LoudnessMeter | null = null;
  private tap: AudioWorkletNode | null = null;
  /** The gates written ahead of the clock, so `resync` can silence them. */
  private readonly gates: ScheduledGate[] = [];

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
  private reverbSend!: GainNode;
  private echo!: DelayNode;
  private echoFeedback!: GainNode;
  private echoSend!: GainNode;
  private echoTone!: BiquadFilterNode;
  private buses!: Record<BusName, GainNode>;
  private noise!: AudioBuffer;
  private cutoff!: BiquadFilterNode;

  constructor({ seed, volume = 0.7, profile, conductor = null, ctx = null }: EngineOptions) {
    this.seed = seed;
    this.volume = clamp(volume, 0, 1);
    this.profile = profile;
    this.conductor = conductor ?? new Conductor(seed);
    this.injectedCtx = ctx;
    this.offline = Boolean(ctx);
    this.seedValue = hashString(String(seed));
    this.started = false;
    this.audioOnly = false;
    this.trimDb = START_TRIM_DB;
    this.lufs = -Infinity;
    this.truePeakDb = -Infinity;
    this.meterAvailable = false;
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
    if (!this.offline && ctx.state === 'suspended') await (ctx as AudioContext).resume();

    const { profile } = this;
    this.noise = createNoiseBuffer(ctx, { seconds: 3, seed: this.seedValue, channels: 1 });

    // --- master ------------------------------------------------------------
    this.masterSum = ctx.createGain();
    this.masterSum.gain.value = 1;

    // A gentle bus compressor for glue. Its attack and release are clamped to a
    // second by the browser, so the *slow* levelling is the trim feedback
    // below, which is where a set measured in tens of seconds belongs.
    this.leveller = ctx.createDynamicsCompressor();
    this.leveller.threshold.value = -18;
    this.leveller.knee.value = 12;
    this.leveller.ratio.value = 3;
    this.leveller.attack.value = 0.12;
    this.leveller.release.value = 0.6;

    // The saturation is the sound: a rave master is clipped on purpose, and
    // the WaveShaper is where that happens, before the limiter sees it.
    this.saturation = ctx.createWaveShaper();
    this.saturation.curve = saturationCurve(0.28);
    this.saturation.oversample = '2x';

    // The true-peak limiter: fast, and only ever a few dB of work because the
    // trim keeps the set at its target loudness in the first place.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.004;
    this.limiter.release.value = 0.18;

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
    this.reverb.buffer = createReverbImpulse(ctx, this.seedValue, profile.reverbSeconds);
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 0.8;
    this.reverb.connect(reverbReturn).connect(this.masterSum);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 1;
    this.reverbSend.connect(this.reverb);

    // The echo: a dotted eighth, fed back through a filter that takes the top
    // off each repeat so the tail darkens the way a real delay does.
    this.echo = ctx.createDelay(2);
    this.echo.delayTime.value = 0.375;
    this.echoFeedback = ctx.createGain();
    this.echoFeedback.gain.value = 0.34;
    this.echoTone = ctx.createBiquadFilter();
    this.echoTone.type = 'lowpass';
    this.echoTone.frequency.value = 2600;
    this.echo.connect(this.echoTone).connect(this.echoFeedback).connect(this.echo);
    const echoReturn = ctx.createGain();
    echoReturn.gain.value = 0.5;
    this.echo.connect(echoReturn).connect(this.masterSum);
    this.echoSend = ctx.createGain();
    this.echoSend.gain.value = 1;
    this.echoSend.connect(this.echo);

    // The section's low-pass, on the synths. The drums are deliberately left
    // alone: a filter sweep that swallowed the kick would not sound like a
    // build, it would sound like a mistake.
    this.cutoff = ctx.createBiquadFilter();
    this.cutoff.type = 'lowpass';
    this.cutoff.frequency.value = 4000;
    this.cutoff.Q.value = 1.1;
    this.cutoff.connect(this.masterSum);

    // --- buses -------------------------------------------------------------
    this.buses = {} as Record<BusName, GainNode>;
    const synthBuses: BusName[] = ['stab', 'arp', 'pad'];
    for (const name of ['kick', 'bass', 'clap', 'hat', 'perc', 'stab', 'arp', 'pad', 'fx'] as BusName[]) {
      const bus = ctx.createGain();
      bus.gain.value = 0;
      bus.connect(synthBuses.includes(name) ? this.cutoff : this.masterSum);
      const echo = ctx.createGain();
      echo.gain.value = ECHO_SEND[name];
      bus.connect(echo).connect(this.echoSend);
      const room = ctx.createGain();
      room.gain.value = ROOM_SEND[name];
      bus.connect(room).connect(this.reverbSend);
      this.buses[name] = bus;
    }

    // --- metering ----------------------------------------------------------
    await this.#setupMeter();

    // --- the first bar, then the scheduler ---------------------------------
    const now: number = this.now;
    this.conductor.ensure(now + LOOKAHEAD + 4);
    this.#applyLevels(now, true);
    if (this.offline) {
      // No timer will run inside an OfflineAudioContext, so the whole render is
      // written down here. This is the same code path a live set takes, one
      // window at a time; only the number of windows differs.
      const seconds = (ctx as OfflineAudioContext).length / ctx.sampleRate;
      this.#scheduleBars(now, now + seconds);
      this.#scheduleEvents(now + seconds);
      this.#schedulePad(now + seconds);
    } else {
      this.#scheduleBars(now, now + LOOKAHEAD);
      this.#scheduleEvents(now + LOOKAHEAD);
      this.#schedulePad(now + LOOKAHEAD);
      this.lastEventTime = now + LOOKAHEAD;
      this.timer = setInterval(() => {
        try {
          this.tick();
        } catch (error) {
          console.error('[engine] scheduler error', error);
        }
      }, TICK_MS);
    }
    this.started = true;
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

  /** One scheduler pass: bars, events, the pad and the levels, all written
   *  ahead on the context clock. */
  tick(): void {
    if (!this.started || this.stopped) return;
    const now = this.now;
    const until = now + LOOKAHEAD;
    this.conductor.ensure(until + 4);
    this.#scheduleBars(now, until);
    this.#scheduleEvents(until);
    this.#schedulePad(until);
    this.#applyLevels(now);
    this.#adjustTrim(now);
    this.#publishLevels();
    this.#pruneGates(now);
  }

  // --- scheduling ----------------------------------------------------------

  /**
   * Every bar that starts inside the window, once. `nextBar` is the only cursor
   * in the engine: it walks forwards one bar at a time, so a throttled tab
   * resumes on the bar it is actually in rather than replaying the ones it
   * missed.
   */
  #scheduleBars(now: number, until: number): void {
    if (this.nextBar == null) {
      this.nextBar = this.conductor.gridAt(now).bar;
      this.nextBarTime = this.conductor.timeOfBar(this.nextBar);
    }
    while (this.nextBarTime < until) {
      const at = Math.max(this.nextBarTime, now + 0.02);
      this.#scheduleBar(this.nextBar, at);
      this.nextBar = this.nextBar + 1;
      this.nextBarTime = this.conductor.timeOfBar(this.nextBar);
      this.barsScheduled++;
    }
  }

  #scheduleBar(bar: number, when: number): void {
    const at = this.conductor.sectionAt(when);
    const blend = this.conductor.sectionBlend(when);
    const patterns = patternsFor(this.seedValue, bar, at.index);
    const chord = this.conductor.chordAt(when).entry;
    const step = at.entry.barSeconds / 16;
    const options = { cutoff: blend.cutoff, voices: this.profile.synthVoices };

    // One gate per instrument per bar, so a change of passage silences the
    // whole bar without touching how any of it is mixed or sent.
    this.#schedulePattern('kick', patterns.kick, when, step, options);
    this.#schedulePattern('bass', patterns.bass, when, step, options, chord);
    this.#schedulePattern('clap', patterns.clap, when, step, options);
    this.#schedulePattern('hat', patterns.hat, when, step, options);
    this.#schedulePattern('perc', patterns.perc, when, step, options);
    this.#schedulePattern('stab', patterns.stab, when, step, options, chord);
    this.#schedulePattern('arp', patterns.arp, when, step, options, chord);
  }

  /**
   * A gain node in front of one instrument's bus, remembered so `resync` can
   * close it. It goes in *before* the bus, so the instrument keeps its own
   * level, the section's filter and its echo and room sends exactly as before:
   * the gate is a way in, not a change to the mix.
   */
  #gate(at: number, into: GainNode): GainNode {
    const node = this.ctx.createGain();
    node.connect(into);
    this.gates.push({ at, node });
    return node;
  }

  /** Disconnect the gates the audio thread is well past. They are not free:
   *  a gain node connected to a bus is reachable from the graph for as long as
   *  the connection stands, so an eight-hour set would otherwise leave
   *  hundreds of thousands of them behind. */
  #pruneGates(now: number): void {
    let keep = 0;
    for (let i = 0; i < this.gates.length; i++) {
      const gate = this.gates[i] as ScheduledGate;
      if (gate.at >= now - GATE_KEEP_S) {
        this.gates[keep++] = gate;
        continue;
      }
      try {
        gate.node.disconnect();
      } catch {
        /* already torn down with the context */
      }
    }
    this.gates.length = keep;
  }

  /**
   * The arrangement was rewritten under the engine: a passage was cut short
   * and a new one put in its place (spec §4's "skip to the next passage").
   *
   * Two things have to happen, and the second is the one that is easy to miss.
   * The schedule is only half of it — the engine has already written the next
   * dozen seconds into the audio graph, and those voices will sound whether or
   * not the conductor still wants them. So the gates from `at` on are faded out
   * where they stand (Web Audio cannot unschedule a voice, only silence the
   * path it plays through), and the cursors are re-anchored onto the new
   * passage's first bar so the next tick schedules from there.
   *
   * `at` is the conductor's own answer for when the change lands, so this does
   * not have to agree with the conductor about anything: it is told.
   */
  resync(at: number, bar: number): void {
    const now = this.now;
    // A short fade rather than a hard cut: a gate slammed to zero on a bus
    // carrying a ride cymbal is a click, and this is a musical event.
    const fade = Math.min(0.08, Math.max(0.01, at - now));
    for (const gate of this.gates) {
      if (gate.at < at) continue;
      try {
        gate.node.gain.cancelScheduledValues(now);
        gate.node.gain.setValueAtTime(gate.node.gain.value, now);
        gate.node.gain.linearRampToValueAtTime(0, now + fade);
      } catch {
        /* the context is closed, or the node is already gone */
      }
    }
    // The bar cursor resumes at the new passage's first bar. Everything from
    // there to the old horizon is dropped, and re-derived from the new plan.
    this.nextBar = bar;
    this.nextBarTime = at;
    // Events are consumed by `(from, to]`, so the cursor goes just before the
    // change: the new passage's own impact and crash sit exactly on it.
    this.lastEventTime = at - 1e-6;
    // The pad is keyed off a chord index that the truncation renumbered, so it
    // has to be allowed to schedule itself again.
    this.scheduledPadChord = -1;
    this.#applyLevels(now, true);
  }

  /** Sixteen steps of one instrument, each voice asked for by the pattern. */
  #schedulePattern(
    instrument: Instrument,
    pattern: BarPatterns[Instrument],
    when: number,
    step: number,
    options: { cutoff: number; voices: number },
    chord?: ChordEntry,
  ): void {
    const ctx = this.ctx;
    const bus = this.buses[instrument];
    if (!bus) return;
    // Only a pattern that actually plays gets a gate: an empty one would be a
    // node in the graph that nothing will ever sound through.
    let sounding = false;
    for (let i = 0; i < 16; i++) {
      if ((pattern.velocity[i] ?? 0) > 0) {
        sounding = true;
        break;
      }
    }
    if (!sounding) return;
    const out = this.#gate(when, bus);
    for (let i = 0; i < 16; i++) {
      const raw = (pattern.velocity[i] ?? 0) / 255;
      if (raw <= 0) continue;
      const at = when + i * step;
      const velocity = raw;
      const voice: { velocity: number; cutoff: number; voices: number } = { velocity, ...options };
      switch (instrument) {
        case 'kick':
          voices.kick(ctx, out, this.noise, at, voice);
          break;
        case 'bass': {
          if (!chord) break;
          const note = chord.bassNotes[(pattern.tone[i] ?? 0) % chord.bassNotes.length] ?? chord.bassNotes[0] as number;
          voices.bass(ctx, out, at, midiToHz(note), { ...voice, accent: i % 4 === 0 });
          break;
        }
        case 'clap':
          voices.clap(ctx, out, this.noise, at, voice);
          break;
        case 'hat':
          voices.hat(ctx, out, this.noise, at, { ...voice, open: i % 8 === 6 });
          break;
        case 'perc':
          voices.perc(ctx, out, this.noise, at, { ...voice, pitch: 700 + ((i * 137) % 1400) });
          break;
        case 'stab': {
          if (!chord) break;
          const tone = (pattern.tone[i] ?? 0) % VOICE_TONES;
          const notes = [chord.stabNotes[tone], chord.stabNotes[(tone + 1) % chord.stabNotes.length]].filter(
            (n): n is number => typeof n === 'number',
          );
          voices.stab(ctx, out, at, notes, voice);
          break;
        }
        case 'arp': {
          if (!chord) break;
          const tone = (pattern.tone[i] ?? 0) % chord.stabNotes.length;
          voices.arp(ctx, out, at, midiToHz(chord.stabNotes[tone] as number), voice);
          break;
        }
        default:
          break;
      }
      this.voices++;
    }
  }

  #scheduleEvents(until: number): void {
    const fx = this.buses.fx;
    if (!fx) return;
    for (const event of this.conductor.eventsBetween(this.lastEventTime, until)) {
      const blend = this.conductor.sectionBlend(event.t);
      // Gated like the drums: a riser written for a passage that a forced
      // change then abandoned is exactly the sound that must not arrive.
      voices.playEvent(this.ctx, this.#gate(event.t, fx), this.noise, event.t, event, {
        cutoff: blend.cutoff,
        voices: this.profile.synthVoices,
      });
      this.voices++;
    }
    this.lastEventTime = Math.max(this.lastEventTime, until);
  }

  /**
   * The pad, which spans a whole chord rather than a bar. It is scheduled when
   * the chord change is inside the window, once, and left to cross-fade into the
   * next one — a sustained voice cannot be retriggered every bar, which is the
   * one place Singularity's engine differs from this one.
   */
  #schedulePad(until: number): void {
    const chord = this.conductor.chordAt(until);
    if (chord.index === this.scheduledPadChord) return;
    const entry = chord.entry;
    const hold = Math.max(2, chord.next.t - entry.t);
    const blend = this.conductor.sectionBlend(entry.t);
    // The bus already carries the section's pad level, so the voice is asked
    // for full velocity: counting the section twice would make a breakdown
    // quieter than it is written and a peak louder than the limiter expects.
    const pad = this.buses.pad;
    if (!pad) return;
    const when = Math.max(entry.t, this.now + 0.05);
    voices.pad(this.ctx, this.#gate(when, pad), when, entry.padNotes, hold, {
      velocity: 1,
      cutoff: blend.cutoff,
      voices: this.profile.synthVoices,
    });
    this.scheduledPadChord = chord.index;
    this.voices++;
  }

  /** Section levels become bus levels, always as ramps. A drop's kick arrives
   *  over `SECTION_FADE` seconds because the ramp is, not because anything is
   *  cross-faded by hand. */
  #applyLevels(now: number, immediate = false): void {
    const blend = this.conductor.sectionBlend(now);
    const duration = immediate ? 0.2 : 0.6;
    for (const name of ['kick', 'bass', 'clap', 'hat', 'perc', 'stab', 'arp', 'pad'] as Instrument[]) {
      const level = blend.levels[name];
      this.ramp(this.buses[name]!.gain, level * BUS_GAIN[name], now, duration);
    }
    this.ramp(this.buses.fx.gain, blend.levels.fx * BUS_GAIN.fx, now, duration);
    this.ramp(this.cutoff.frequency, clamp(blend.cutoff, 120, 18000), now, immediate ? 0.2 : 1.2);
    // The echo is the set's tempo, so it follows the bar rather than the
    // section: a dotted eighth at 128 is not the same delay as at 140.
    const bar = this.conductor.gridAt(now);
    this.ramp(this.echo.delayTime, clamp((bar.barSeconds / 4) * 0.75, 0.05, 1.9), now, 0.8);
  }

  ramp(param: AudioParam, value: number, when: number, duration: number): void {
    if (duration <= 0.02) param.setValueAtTime(value, when);
    else param.setTargetAtTime(value, when, duration / 3);
  }

  /** The slow leveller, on our own measurement: the set finds the target on
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
    const blend = this.conductor.sectionBlend(this.now);
    const smooth = (key: keyof Levels, value: number): void => {
      levels[key] = levels[key] + (clamp(value, 0, 1) - levels[key]) * 0.08;
    };
    smooth('kick', blend.levels.kick / 1.2);
    smooth('bass', blend.levels.bass / 1.2);
    smooth('hat', blend.levels.hat);
    smooth('stab', blend.levels.stab);
    smooth('pad', blend.levels.pad);
    // Loudness as a 0..1 brightness the picture can breathe with.
    const fromLoudness = Number.isFinite(this.lufs) ? clamp((this.lufs + 30) / 16, 0, 1) : 0.6;
    smooth('brightness', fromLoudness);
    smooth('peak', Number.isFinite(this.truePeakDb) ? clamp((this.truePeakDb + 24) / 24, 0, 1) : 0.5);
  }

  /** Volume, 0..1 from the slider, curved like a fader rather than a straight line. */
  setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1);
    if (!this.ctx) return;
    this.ramp(this.user.gain, volumeCurve(this.volume), this.now, 0.3);
  }

  /** Audio-only mode: the picture is stopped by the app; the music carries on. */
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
    this.sleepAt = now + Math.max(5, seconds);
    this.sleepStart = now;
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

  /** Suspend the clock (the sleep timer): the set is held, not lost. */
  suspend(): void {
    const ctx = this.ctx as AudioContext;
    if (ctx.suspend) void ctx.suspend();
  }

  /** Start the clock again after a sleep. */
  async resume(): Promise<void> {
    const ctx = this.ctx as AudioContext;
    if (ctx.resume) await ctx.resume();
  }

  /** Whether the set should have stopped by now (the app polls this). */
  asleep(): boolean {
    return this.sleepAt != null && this.now > this.sleepAt + 1;
  }

  /** A snapshot for the UI and for the picture. */
  stats(): EngineStats {
    return {
      lufs: this.lufs,
      truePeakDb: this.truePeakDb,
      trimDb: this.trimDb,
      bars: this.barsScheduled,
      voices: this.voices,
      clock: this.now,
      messages: this.messages,
      meterAvailable: this.meterAvailable,
    };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
    for (const gate of this.gates.splice(0)) {
      try {
        gate.node.disconnect();
      } catch {
        /* the context is going away anyway */
      }
    }
    try {
      (this.ctx as AudioContext).close();
    } catch {
      /* already closed, or offline */
    }
    this.started = false;
  }
}

/** A fader curve: quiet at the bottom, usable at the top. */
export function volumeCurve(volume: number): number {
  const v = clamp(volume, 0, 1);
  return v * v;
}
