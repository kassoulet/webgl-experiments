// The audio engine: the graph, the scheduler and the master chain (spec §3).
//
//   drums (kick bass clap hat perc) ┐
//   synth (stab arp pad) ── echo ───┼─> leveller -> saturation ->
//   fx (risers, impacts, zaps) ─────┘    limiter -> trim -> user -> fade
//                                                       │
//                                            analyser ──┴──> destination
//
// Everything the scheduler does is written ahead on the AudioContext's own
// clock, so a throttled tab (or a locked phone) cannot make the set stutter:
// the audio thread owns the next dozen seconds once they are written down.
//
// The analyser is the reason this engine is not a copy of FOraveR's. The
// picture's hero is an oscilloscope, and the only honest way to draw one is to
// read the signal that is actually coming out of the limiter — so there is a
// real AnalyserNode on the master, and the shader draws what it says.

import { Conductor } from '../conductor.ts';
import { SCOPE_BINS } from '../scope.ts';
import { patternsFor, VOICE_TONES, contourFor, type BarPatterns } from '../patterns.ts';
import { midiToHz } from '../harmony.ts';
import { hashString } from '../rng.ts';
import { LoudnessMeter, dbToGain, TARGET_LUFS } from './loudness.ts';
import { clamp, createNoiseBuffer, createReverbImpulse, saturationCurve } from './dsp.ts';
import { meterWorkletUrl } from './meter-worklet.ts';
import * as voices from './voices.ts';
import type { ChordEntry, EngineStats, Levels, Profile, ScopeFrame, Seed } from '../types.ts';

export { TARGET_LUFS } from './loudness.ts';
export { SCOPE_BINS } from '../scope.ts';


/** The analyser's window. 2048 samples is about 43 ms at 48 kHz: long enough
 *  to hold a beat's worth of the bass line, short enough that a kick is a
 *  spike rather than a smear. */
const FFT_SIZE = 2048;

/** Seconds of schedule written ahead of the clock. A background tab throttles
 *  timers to about one a second; twelve seconds is far more than that needs. */
const LOOKAHEAD = 12;
const TICK_MS = 250;

/** Where the master starts, before the loudness feedback has any blocks. A set
 *  that faded in would be wrong here: the entrance click is the entrance. */
const START_TRIM_DB = -3;

/** How long a scheduled gate is kept before it is disconnected. It only has to
 *  outlive the longest thing written through it, so half a minute is generous.
 *  Past that the node is disconnected so the graph can let it go. */
const GATE_KEEP_S = 30;

/** The nine buses. Seven are stepped instruments with a pattern of their own;
 *  the pad is the sustained one, scheduled per chord rather than per bar. */
type BusName = InstrumentName | 'pad' | 'fx';
type InstrumentName = 'kick' | 'bass' | 'hat' | 'clap' | 'perc' | 'stab' | 'arp';

/** Each bus's own weight, so the mix balance is one number per instrument.
 *  The measured reference is a bass record: the bass sits at or above the
 *  kick almost everywhere, and the top end is thin. */
const BUS_GAIN: Record<BusName, number> = {
  kick: 1,
  bass: 1.05,
  clap: 0.72,
  hat: 0.38,
  perc: 0.45,
  stab: 0.85,
  arp: 0.7,
  pad: 0.7,
  fx: 0.7,
};

/** How much of each bus goes to the echo and to the room. */
const ECHO_SEND: Record<BusName, number> = {
  kick: 0, bass: 0, clap: 0.06, hat: 0.04, perc: 0.1,
  stab: 0.3, arp: 0.28, pad: 0.1, fx: 0.2,
};

const ROOM_SEND: Record<BusName, number> = {
  kick: 0, bass: 0, clap: 0.16, hat: 0.06, perc: 0.12,
  stab: 0.24, arp: 0.2, pad: 0.34, fx: 0.28,
};

/**
 * A gain node put in front of one scheduled bar, event or pad, so a forced
 * passage change can silence it.
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

export interface EngineOptions {
  seed: Seed;
  volume?: number;
  profile: Profile;
  /** Shared with the picture. A conductor is created if one is not passed. */
  conductor?: Conductor | null;
  /** An injected context: an OfflineAudioContext for measurement, or null. */
  ctx?: BaseAudioContext | null;
}

export class Engine {
  private readonly conductor: Conductor;
  private readonly profile: Profile;
  /** The seed as it was given, and the number everything is derived from. */
  readonly seed: Seed;
  readonly seedValue: number;

  private ctx: BaseAudioContext | null = null;
  private started = false;
  private stopped = false;
  private audioOnly = false;
  private volume: number;
  private lufs = Number.NEGATIVE_INFINITY;
  private truePeakDb = Number.NEGATIVE_INFINITY;
  private trimDb = START_TRIM_DB;
  private meterAvailable = false;
  private scopeAvailable = false;
  private messages = 0;
  private voicesStarted = 0;
  private barsScheduled = 0;

  /** True when this engine is rendering offline: there is no timer to schedule
   *  from, so `start()` writes the whole render down in one pass. */
  private readonly offline: boolean;
  private readonly injectedCtx: BaseAudioContext | null;
  private nextBar: number | null = null;
  private nextBarTime = 0;
  private scheduledPadChord = -1;
  private lastEventTime = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private meter: LoudnessMeter | null = null;
  private tap: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private readonly waveBytes = new Uint8Array(FFT_SIZE);
  private readonly spectrumBytes = new Uint8Array(FFT_SIZE / 2);
  private readonly scopeWave = new Float32Array(SCOPE_BINS);
  private readonly scopeSpectrum = new Float32Array(SCOPE_BINS);
  /** The gates written ahead of the clock, so `resync` can silence them. */
  private readonly gates: ScheduledGate[] = [];

  // The graph, built in start().
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
    this.seedValue = hashString(String(seed));
    this.volume = clamp(volume, 0, 1);
    this.profile = profile;
    this.conductor = conductor ?? new Conductor(seed);
    this.injectedCtx = ctx;
    this.offline = Boolean(ctx);
  }

  /** The journey clock. Everything — audio, picture, HUD — reads this. */
  get now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** The running context, or null before `start()`. An offline render needs it
   *  to ask for the buffer; the picture does not. */
  get context(): BaseAudioContext | null {
    return this.ctx;
  }

  /** Build the graph. Must be called from a user gesture. */
  async start(): Promise<this> {
    if (this.started) return this;
    const audioGlobal = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
    const AudioContextClass = audioGlobal.AudioContext ?? audioGlobal.webkitAudioContext;
    if (!this.injectedCtx && !AudioContextClass) throw new Error('Web Audio is not available in this browser');
    const ctx = this.injectedCtx ?? new AudioContextClass!({ latencyHint: 'playback' });
    this.ctx = ctx;
    // An offline context must not be resumed: it starts when startRendering()
    // is called and not before.
    if (!this.offline && ctx.state === 'suspended') await (ctx as AudioContext).resume();

    this.noise = createNoiseBuffer(ctx, { seconds: 2, seed: this.seedValue, channels: 1 });

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

    // The saturation is the sound: an electro master is clipped on purpose, and
    // the WaveShaper is where that happens, before the limiter sees it. The
    // reference measures +6 dBTP, which is what this curve is imitating — the
    // peak is held back afterwards, but the density of it is not.
    this.saturation = ctx.createWaveShaper();
    this.saturation.curve = saturationCurve(0.34);
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
    this.user.gain.value = this.volume * this.volume;
    this.fade = ctx.createGain();
    this.fade.gain.value = 1;

    this.masterSum
      .connect(this.leveller)
      .connect(this.saturation)
      .connect(this.limiter)
      .connect(this.trim)
      .connect(this.user)
      .connect(this.fade);

    // The analyser, on the master and *after* the limiter. This is the
    // oscilloscope: the trace is what is leaving the chain, not what went in.
    if (!this.offline) {
      try {
        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = FFT_SIZE;
        // Enough smoothing to stop the trace strobing, not so much that a kick
        // is a smear: the point of the scope is that it moves on the beat.
        this.analyser.smoothingTimeConstant = 0.35;
        this.analyser.minDecibels = -90;
        this.analyser.maxDecibels = -6;
        this.fade.connect(this.analyser);
        this.scopeAvailable = true;
      } catch {
        this.analyser = null;
        this.scopeAvailable = false;
      }
    }

    // A silent sink, so the graph always has something pulling it even when
    // the destination is muted or the tab is in the background.
    this.silence = ctx.createGain();
    this.silence.gain.value = 0;
    this.fade.connect(this.silence).connect(ctx.destination);
    this.fade.connect(ctx.destination);

    // --- sends -------------------------------------------------------------
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = createReverbImpulse(ctx, this.seedValue, this.profile.reverbSeconds);
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 0.7;
    this.reverb.connect(reverbReturn).connect(this.masterSum);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 1;
    this.reverbSend.connect(this.reverb);

    // A sixteenth delay, fed back through a filter that takes the top off each
    // repeat so the tail darkens. Electro's delay is short and on the grid;
    // anything longer is a different record.
    this.echo = ctx.createDelay(2);
    this.echo.delayTime.value = 0.375;
    this.echoFeedback = ctx.createGain();
    this.echoFeedback.gain.value = 0.28;
    this.echoTone = ctx.createBiquadFilter();
    this.echoTone.type = 'lowpass';
    this.echoTone.frequency.value = 2200;
    this.echo.connect(this.echoTone).connect(this.echoFeedback).connect(this.echo);
    const echoReturn = ctx.createGain();
    echoReturn.gain.value = 0.4;
    this.echo.connect(echoReturn).connect(this.masterSum);
    this.echoSend = ctx.createGain();
    this.echoSend.gain.value = 1;
    this.echoSend.connect(this.echo);

    // The passage's low-pass, on the synths. The drums are deliberately left
    // alone: a filter sweep that swallowed the kick would not sound like a
    // build, it would sound like a mistake.
    this.cutoff = ctx.createBiquadFilter();
    this.cutoff.type = 'lowpass';
    this.cutoff.frequency.value = 4000;
    this.cutoff.Q.value = 1.1;
    this.cutoff.connect(this.masterSum);

    // --- buses -------------------------------------------------------------
    const synthBuses: BusName[] = ['stab', 'arp', 'pad'];
    const allBuses: BusName[] = ['kick', 'bass', 'clap', 'hat', 'perc', 'stab', 'arp', 'pad', 'fx'];
    this.buses = {} as Record<BusName, GainNode>;
    for (const name of allBuses) {
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

    await this.#setupMeter();

    // --- the first bar, then the scheduler ---------------------------------
    const now: number = this.now;
    this.conductor.ensure(now + LOOKAHEAD + 4);
    this.#applyLevels(now, true);
    if (this.offline) {
      // No timer will run inside an OfflineAudioContext, so the whole render
      // is written down here. Same code path a live set takes, one window at a
      // time; only the number of windows differs.
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
    if (!ctx) return;
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
        const pcm = (message.data as { pcm?: Float32Array } | null)?.pcm;
        if (!pcm || !pcm.length) return;
        // Counted before the metering: a soak reads this to tell "the audio
        // thread is still processing" from "the context clock is still moving",
        // which are different failures.
        this.messages++;
        meter.push(pcm, pcm.length, 0);
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
    const patterns: BarPatterns = patternsFor(this.seedValue, bar, at.index, at.entry.section.name);
    const chord = this.conductor.chordAt(when).entry;
    const step = at.entry.barSeconds / 16;
    const options = { cutoff: blend.cutoff, voices: this.profile.synthVoices };

    this.#schedulePattern('kick', patterns.kick, when, step, options, 0, at.index);
    this.#schedulePattern('bass', patterns.bass, when, step, options, 0, at.index, chord);
    this.#schedulePattern('clap', patterns.clap, when, step, options, 0, at.index);
    this.#schedulePattern('hat', patterns.hat, when, step, options, 0, at.index);
    this.#schedulePattern('perc', patterns.perc, when, step, options, 0, at.index);
    this.#schedulePattern('stab', patterns.stab, when, step, options, patterns.phrase, at.index, chord);
    this.#schedulePattern('arp', patterns.arp, when, step, options, patterns.phrase, at.index, chord);
  }

  /**
   * A gain node in front of one instrument's bus, remembered so `resync` can
   * close it. It goes in *before* the bus, so the instrument keeps its own
   * level, the passage's filter and its echo and room sends exactly as before:
   * the gate is a way in, not a change to the mix.
   */
  #gate(at: number, into: GainNode): GainNode {
    const node = this.ctx!.createGain();
    node.connect(into);
    this.gates.push({ at, node });
    return node;
  }

  /** Disconnect the gates the audio thread is well past. They are not free: a
   *  gain node connected to a bus is reachable from the graph for as long as
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
   * and a new one put in its place (spec §5's "skip to the next passage").
   *
   * Two things have to happen, and the second is the one that is easy to miss.
   * The schedule is only half of it — the engine has already written the next
   * dozen seconds into the audio graph, and those voices will sound whether or
   * not the conductor still wants them. So the gates from `at` on are faded out
   * where they stand (Web Audio cannot unschedule a voice, only silence the
   * path it plays through), and the cursors are re-anchored onto the new
   * passage's first bar so the next tick schedules from there.
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
    instrument: InstrumentName,
    pattern: BarPatterns[InstrumentName],
    when: number,
    step: number,
    options: { cutoff: number; voices: number },
    /** The four-bar phrase the stab contour is chosen from, if this pattern
     *  has one: a synth that only plays bass tones has no contour to pick. */
    phrase: number | null,
    /** Which passage this bar is in. The contour is a property of the passage,
     *  not of the seed alone, so a change of section really changes it. */
    sectionIndex: number,
    chord?: ChordEntry,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
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
    const contour = chord && phrase != null ? contourFor(this.seedValue, sectionIndex, phrase, 2) : null;

    for (let i = 0; i < 16; i++) {
      const raw = (pattern.velocity[i] ?? 0) / 255;
      if (raw <= 0) continue;
      const at = when + i * step;
      const voice = { velocity: raw, ...options };
      switch (instrument) {
        case 'kick':
          voices.kick(ctx, out, this.noise, at, voice);
          break;
        case 'bass': {
          if (!chord) break;
          // The bass line's tones are offsets from the chord root: 0 is the
          // root, 1 the fifth an octave up, 2 the root an octave up. That is
          // what makes a sixteenth line a bass line rather than an arpeggio.
          const tone = (pattern.tone[i] ?? 0) % VOICE_TONES;
          const note = chord.bassNotes[tone] ?? (chord.bassNotes[0] as number);
          voices.bass(ctx, out, at, midiToHz(note), { ...voice, accent: i % 4 === 0 });
          break;
        }
        case 'clap':
          voices.clap(ctx, out, this.noise, at, voice);
          break;
        case 'hat':
          voices.hat(ctx, out, at, { ...voice, open: i % 8 === 6 });
          break;
        case 'perc':
          voices.perc(ctx, out, at, { ...voice, pitch: 700 + ((i * 137) % 1400) });
          break;
        case 'stab': {
          if (!chord) break;
          const tone = (pattern.tone[i] ?? 0) % chord.stabNotes.length;
          const pick = contour ? contour[(i + tone) % contour.length] ?? 0 : tone;
          const a = chord.stabNotes[tone % chord.stabNotes.length] as number;
          const b = chord.stabNotes[(tone + 1 + pick) % chord.stabNotes.length] as number;
          voices.stab(ctx, out, at, [a, b], voice);
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
      this.voicesStarted++;
    }
  }

  #scheduleEvents(until: number): void {
    const fx = this.buses.fx;
    if (!fx || !this.ctx) return;
    for (const event of this.conductor.eventsBetween(this.lastEventTime, until)) {
      const blend = this.conductor.sectionBlend(event.t);
      // Gated like the drums: a riser written for a passage that a forced
      // change then abandoned is exactly the sound that must not arrive.
      voices.playEvent(this.ctx, this.#gate(event.t, fx), this.noise, event.t, event, {
        cutoff: blend.cutoff,
        voices: this.profile.synthVoices,
      });
      this.voicesStarted++;
    }
    this.lastEventTime = Math.max(this.lastEventTime, until);
  }

  /**
   * The pad, which spans a whole chord rather than a bar. It is scheduled when
   * the chord change is inside the window, once, and left to cross-fade into the
   * next one — a sustained voice cannot be retriggered every bar.
   */
  #schedulePad(until: number): void {
    const pad = this.buses.pad;
    if (!pad || !this.ctx) return;
    const chord = this.conductor.chordAt(until);
    if (chord.index === this.scheduledPadChord) return;
    const entry = chord.entry;
    const hold = Math.max(2, chord.next.t - entry.t);
    const blend = this.conductor.sectionBlend(entry.t);
    // The bus already carries the passage's pad level, so the voice is asked
    // for full velocity: counting the passage twice would make a breakdown
    // quieter than it is written and a peak louder than the limiter expects.
    const when = Math.max(entry.t, this.now + 0.05);
    voices.pad(this.ctx, this.#gate(when, pad), when, entry.padNotes, hold, {
      velocity: 1,
      cutoff: blend.cutoff,
      voices: this.profile.synthVoices,
    });
    this.scheduledPadChord = chord.index;
    this.voicesStarted++;
  }

  /** Passage levels become bus levels, always as ramps. A drop's kick arrives
   *  over `SECTION_FADE` seconds because the ramp is, not because anything is
   *  cross-faded by hand. */
  #applyLevels(now: number, immediate = false): void {
    const blend = this.conductor.sectionBlend(now);
    const duration = immediate ? 0.2 : 0.6;
    for (const name of ['kick', 'bass', 'clap', 'hat', 'perc', 'stab', 'arp', 'pad'] as InstrumentName[]) {
      const bus = this.buses[name];
      if (!bus) continue;
      this.ramp(bus.gain, (blend.levels[name] ?? 0) * (BUS_GAIN[name] ?? 1), now, duration);
    }
    const fx = this.buses.fx;
    if (fx) this.ramp(fx.gain, (blend.levels.fx ?? 0) * (BUS_GAIN.fx ?? 1), now, duration);
    this.ramp(this.cutoff.frequency, clamp(blend.cutoff, 80, 18000), now, immediate ? 0.2 : 1.2);
    // The echo is the set's tempo, so it follows the bar rather than the
    // passage: a sixteenth delay at 126 is not the same delay as at 132.
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
    if (meter.blocks.length < 8 || !Number.isFinite(this.lufs)) return;
    const error = TARGET_LUFS - this.lufs;
    const step = clamp(error, -0.05, 0.05);
    this.trimDb = clamp(this.trimDb + step, -26, 6);
    this.trim.gain.setTargetAtTime(dbToGain(this.trimDb), now, 0.35);
  }

  /** Share the levels with the picture (spec §4: audio and visuals read the
   *  same state, and no audio data crosses into the GPU beyond a few uniforms
   *  and one texture of waveform). */
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
    // Loudness as a 0..1 brightness the tape noise can breathe with.
    const fromLoudness = Number.isFinite(this.lufs) ? clamp((this.lufs + 30) / 20, 0, 1) : 0.6;
    smooth('brightness', fromLoudness);
    smooth('peak', Number.isFinite(this.truePeakDb) ? clamp((this.truePeakDb + 24) / 24, 0, 1) : 0.5);
  }

  /**
   * The oscilloscope's data for this frame.
   *
   * The waveform is decimated from the analyser's window by taking the peak of
   * each output bin rather than its mean: a mean over 16 samples turns a kick
   * into a smear and the whole point of a scope is that the kick is a spike.
   * The spectrum is log-spaced, because a linear axis on music puts nine tenths
   * of the picture in the top two octaves, which is empty on this material.
   */
  scopeFrame(): ScopeFrame {
    const out: ScopeFrame = {
      wave: this.scopeWave,
      spectrum: this.scopeSpectrum,
      peak: 0,
      rms: 0,
    };
    const analyser = this.analyser;
    if (!analyser) return out;

    analyser.getByteTimeDomainData(this.waveBytes);
    analyser.getByteFrequencyData(this.spectrumBytes);

    // Decimated to SCOPE_BINS by *averaging* each group, and kept signed.
    //
    // Both halves of that matter. Averaging is a box filter — 8 samples at
    // 48 kHz is 0.17 ms, so it smooths nothing a scope would show — and it
    // preserves the shape. Taking the largest magnitude in the group instead
    // does not decimate a waveform, it rectifies one: the result is a row of
    // humps that never goes below zero, which is an envelope and not a
    // waveform.
    //
    // And it has to stay signed, because the picture's trigger search looks for
    // an upward crossing of the mean (`findTrigger` in src/scope.ts). A
    // rectified buffer has no crossing to find, so the trigger silently reports
    // zero forever and the trace slides sideways continuously — which is the
    // single most common way a fake scope gives itself away.
    const per = Math.max(1, Math.floor(this.waveBytes.length / SCOPE_BINS));
    let peak = 0;
    let sum = 0;
    for (let i = 0; i < SCOPE_BINS; i++) {
      let bin = 0;
      for (let j = 0; j < per; j++) {
        bin += ((this.waveBytes[i * per + j] as number) - 128) / 128;
      }
      const v = bin / per;
      this.scopeWave[i] = v;
      const magnitude = Math.abs(v);
      if (magnitude > peak) peak = magnitude;
      sum += v * v;
    }
    out.peak = peak;
    out.rms = Math.sqrt(sum / SCOPE_BINS);

    // Log-spaced from 40 Hz to 12 kHz across the bins, which is where this music
    // actually lives — the reference measures 62 Hz dominant and 16 kHz at
    // nothing.
    //
    // Each output bin is the *peak* of the FFT bins its own frequency range
    // covers, not a sample of one of them. That matters for the display: the
    // bottom of the log scale is thousands of hertz wide in FFT bins and the top
    // is a few, so sampling one bin per output point reads the bass off a
    // single FFT bin and reads the top end off a single one too, and the
    // resulting picture is a row of identical bars. Peak-per-band is what a
    // hardware analyser's peak detector does, and it is the only reduction of
    // these that keeps the shape of the spectrum's *envelope*, which is the
    // thing being drawn.
    const bins = this.spectrumBytes.length;
    const nyquist = this.ctx ? this.ctx.sampleRate / 2 : 24000;
    const fMin = 40;
    const fMax = 12000;
    const toBin = (hz: number): number =>
      Math.min(bins - 1, Math.max(0, Math.round((hz / nyquist) * bins)));
    let previous = 0;
    for (let i = 0; i < SCOPE_BINS; i++) {
      const t = i / (SCOPE_BINS - 1);
      const lo = toBin(fMin * Math.pow(fMax / fMin, previous));
      const hi = Math.max(lo, toBin(fMin * Math.pow(fMax / fMin, t)));
      let peak = 0;
      for (let j = lo; j <= hi; j++) peak = Math.max(peak, this.spectrumBytes[j] as number);
      this.scopeSpectrum[i] = peak / 255;
      previous = t;
    }
    return out;
  }

  /** Volume, 0..1 from the slider, curved like a fader. */
  setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1);
    if (!this.ctx) return;
    this.ramp(this.user.gain, this.volume * this.volume, this.now, 0.3);
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

  sleepAt: number | null = null;
  sleepStart: number | null = null;

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
    if (ctx?.suspend) void ctx.suspend();
  }

  /** Start the clock again after a sleep. */
  async resume(): Promise<void> {
    const ctx = this.ctx as AudioContext;
    if (ctx?.resume) await ctx.resume();
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
      voices: this.voicesStarted,
      clock: this.now,
      messages: this.messages,
      meterAvailable: this.meterAvailable,
      scopeAvailable: this.scopeAvailable,
      audioOnly: this.audioOnly,
    };
  }

  /** The levels, for the picture. Shared with the conductor. */
  levels(): Levels {
    return this.conductor.levels;
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
