// The instruments. Each one is built once and then told what to do — nothing
// here triggers a note like a drum machine: layers fade in, cross-fade and
// glide, and the only envelopes are long (spec §2: "Slow. No parameter jumps").
//
// Layers, per the spec's table: generative pads (detuned oscillators, granular
// clouds, string-machine voices), tape-warped drones (root and fifth, octaves,
// sub), cosmic soundscapes (winds, dust, shimmer, far-away events).

import { Rng } from '../rng.ts';
import { Tape, createNoiseBuffer } from './tape.ts';
import type { Mood, PieceEvent, Seed } from '../types.ts';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** A slowly moving pan, so layers sit in a place rather than a point. */
function panner(ctx: BaseAudioContext, pan: number): StereoPannerNode {
  const node = ctx.createStereoPanner();
  node.pan.value = clamp(pan, -1, 1);
  return node;
}

/** A detuned oscillator stack and a way to glide the whole stack. */
interface OscStack {
  out: GainNode;
  oscs: OscillatorNode[];
  setFreq(freq: number, when: number, glide?: number): void;
}

interface StackOptions {
  type?: OscillatorType;
  voices?: number;
  detune?: number;
  level?: number;
}

/** Detuned oscillator stack: the body of every pitched layer. */
function oscillatorStack(
  ctx: BaseAudioContext,
  { type = 'sawtooth', voices = 3, detune = 7, level = 1 }: StackOptions = {},
): OscStack {
  const out = ctx.createGain();
  out.gain.value = level;
  const oscs: OscillatorNode[] = [];
  for (let i = 0; i < voices; i++) {
    const osc = ctx.createOscillator();
    osc.type = type;
    const spread = voices === 1 ? 0 : (i / (voices - 1)) * 2 - 1;
    osc.detune.value = spread * detune;
    const g = ctx.createGain();
    g.gain.value = 1 / Math.sqrt(voices);
    osc.connect(g).connect(out);
    oscs.push(osc);
  }
  // A stack runs for as long as its layer does: the layer's own gain is the
  // envelope, so an oscillator that is never started would be silence.
  // (A stack's oscillators also need their `stop` at dispose to be legal.)
  for (const osc of oscs) osc.start();
  return {
    out,
    oscs,
    setFreq(freq, when, glide) {
      for (const o of oscs) setFreq(o.frequency, freq, when, glide);
    },
  };
}

function setFreq(param: AudioParam, value: number, when: number, glide = 0): void {
  if (glide <= 0) param.setValueAtTime(value, when);
  else if (param.value > 0 && value > 0) param.exponentialRampToValueAtTime(value, when + glide);
  else param.linearRampToValueAtTime(value, when + glide);
}

function ramp(param: AudioParam, value: number, when: number, duration: number): void {
  if (duration <= 0.001) param.setValueAtTime(value, when);
  else param.setTargetAtTime(value, when, duration / 3);
}

interface DroneLayer {
  interval: number;
  stack: OscStack;
  filter: BiquadFilterNode;
  gain: GainNode;
  pan: StereoPannerNode;
  level: number;
}

interface LayerSpec {
  interval: number;
  type: OscillatorType;
  sub: boolean;
  level?: number;
  pan?: number;
}

export interface DroneOptions {
  seed?: Seed;
  /** Wow and flutter depth multiplier. */
  warp?: number;
  /** 0..1, how worn the tape is. */
  age?: number;
}

/**
 * The tape-warped drone bed: root, fifth and sub, held and glided between notes
 * of the key, plus an optional fourth layer that cross-fades in under the
 * others so the bed itself changes colour (spec §2 "drones cross-fade between
 * notes of the key").
 */
export class DroneBank {
  private readonly ctx: BaseAudioContext;
  private readonly rng: Rng;
  private readonly tape: Tape;
  private readonly bus: GainNode;
  private readonly layers: DroneLayer[];
  private extra: DroneLayer | null;

  constructor(
    ctx: BaseAudioContext,
    destination: AudioNode,
    { seed = 'drone', warp = 1, age = 0.45 }: DroneOptions = {},
  ) {
    this.ctx = ctx;
    this.rng = new Rng(seed).fork('drone');
    this.tape = new Tape(ctx, { wow: warp, age, noiseSeed: this.rng.int(1e6) });
    this.tape.output.connect(destination);

    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.bus.connect(this.tape.input);

    this.layers = [];
    this.#addLayer({ interval: 0, type: 'sawtooth', sub: true });
    this.#addLayer({ interval: 7, type: 'triangle', sub: false });
    this.#addLayer({ interval: -12, type: 'sine', sub: true });
    this.extra = null;
  }

  #addLayer({ interval, type, sub, level = 0.4, pan = 0 }: LayerSpec): DroneLayer {
    const ctx = this.ctx;
    const stack = oscillatorStack(ctx, { type, voices: sub ? 1 : 2, detune: sub ? 0 : 5, level });
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = sub ? 220 : 900;
    filter.Q.value = 0.5;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const pan2 = panner(ctx, pan);
    stack.out.connect(filter).connect(gain).connect(pan2).connect(this.bus);
    const layer: DroneLayer = { interval, stack, filter, gain, pan: pan2, level };
    this.layers.push(layer);
    return layer;
  }

  /** Glide the bed to a new root. `when` is a context time, `glide` seconds. */
  tune(rootHz: number, when: number, glide = 14): void {
    this.layers.forEach((layer) => {
      const hz = rootHz * Math.pow(2, layer.interval / 12);
      // The sub never goes too low to be heard on a phone speaker.
      const safe = clamp(hz, 24, 900);
      layer.stack.setFreq(safe, when, glide);
      ramp(layer.filter.frequency, clamp(safe * 6, 180, 1400), when, glide);
    });
    if (this.extra) {
      const hz = clamp(rootHz * Math.pow(2, this.extra.interval / 12), 40, 1200);
      this.extra.stack.setFreq(hz, when, glide);
      ramp(this.extra.filter.frequency, clamp(hz * 5, 200, 1600), when, glide);
    }
  }

  /** Fade a new interval in under the bed and let the oldest go. */
  crossFadeLayer(interval: number, when: number, duration = 30): void {
    if (this.extra) {
      const gone = this.extra;
      ramp(gone.gain.gain, 0, when, duration);
      this.extra = null;
      setTimeout(() => {
        for (const o of gone.stack.oscs) {
          try {
            o.stop();
            o.disconnect();
          } catch {
            /* stopped */
          }
        }
      }, (duration + 4) * 1000);
    }
    const layer = this.#addLayer({
      interval,
      type: this.rng.chance(0.5) ? 'triangle' : 'sawtooth',
      sub: false,
      level: 0.22,
      pan: this.rng.signed() * 0.5,
    });
    ramp(layer.gain.gain, 0.22, when, duration);
    this.extra = layer;
  }

  setLevel(level: number, duration = 20): void {
    ramp(this.bus.gain, clamp(level, 0, 1.2), this.ctx.currentTime, duration);
  }

  setTape({ warp, age }: { warp?: number; age?: number }, duration = 40): void {
    if (typeof warp === 'number') this.tape.setWarp(warp, duration);
    if (typeof age === 'number') this.tape.setAge(age, duration);
  }

  dispose(): void {
    for (const layer of this.layers) for (const o of layer.stack.oscs) o.stop();
    this.tape.dispose();
  }
}

interface FadeTarget {
  gain: AudioParam;
  target: number;
  when: number | null;
}

export interface ChordOptions {
  notesHz: number[];
  level?: number;
  pan?: number;
  seed?: Seed;
  /** String-machine voices cost more; the profile decides whether they exist. */
  rich?: boolean;
  mood?: Mood | null;
}

/**
 * Pads and string-machine voices for one chord. A ChordVoices is created at a
 * chord change, fades in under the settling chord, and is disposed of long
 * after it has faded out — the crossfade *is* the harmony (spec §2 "a new one
 * fades in under the old one").
 */
export class ChordVoices {
  private readonly ctx: BaseAudioContext;
  private readonly nodes: AudioNode[];
  private readonly gains: FadeTarget[];
  private readonly oscs: OscillatorNode[];

  constructor(
    ctx: BaseAudioContext,
    destination: AudioNode,
    { notesHz, level = 0.5, pan = 0, seed = 0, rich = true, mood = null }: ChordOptions,
  ) {
    this.ctx = ctx;
    this.nodes = [];
    this.gains = [];
    this.oscs = [];
    const rng = new Rng(seed).fork('chord');
    const brightness = mood ? clamp(mood.brightness + 0.4, 0.3, 1.6) : 1;

    notesHz.forEach((hz, i) => {
      const spread = notesHz.length > 1 ? (i / (notesHz.length - 1)) * 2 - 1 : 0;

      // Layer A — the pad: three detuned saws through a slow filter.
      const pad = oscillatorStack(ctx, { type: 'sawtooth', voices: rich ? 3 : 2, detune: 9 });
      const padFilter = ctx.createBiquadFilter();
      padFilter.type = 'lowpass';
      padFilter.frequency.value = clamp(hz * 3.2 * brightness, 180, 6000);
      padFilter.Q.value = 0.7;
      const padGain = ctx.createGain();
      padGain.gain.value = 0;
      const padPan = panner(ctx, pan + spread * 0.35);
      pad.out.connect(padFilter).connect(padGain).connect(padPan).connect(destination);
      pad.setFreq(hz, ctx.currentTime, 0);
      // The filter opens and closes over tens of seconds, never on a beat.
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.021 + rng.float() * 0.03;
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = clamp(hz * 0.8 * brightness, 40, 1400);
      lfo.connect(lfoDepth).connect(padFilter.frequency);
      lfo.start();

      this.gains.push({ gain: padGain.gain, target: level * 0.55, when: null });
      this.oscs.push(...pad.oscs, lfo);
      this.nodes.push(padGain, padFilter, padPan, lfoDepth);

      // Layer B — the string machine: a pair of saws, slightly apart, slow
      // vibrato. Desktop only: it is the first layer to go on a phone.
      if (!rich) return;
      const strings = oscillatorStack(ctx, { type: 'sawtooth', voices: 2, detune: 4 });
      const vibrato = ctx.createOscillator();
      vibrato.frequency.value = 0.13 + rng.float() * 0.1;
      const vibratoDepth = ctx.createGain();
      vibratoDepth.gain.value = 3;
      vibrato.connect(vibratoDepth);
      for (const o of strings.oscs) vibratoDepth.connect(o.detune);
      vibrato.start();
      const stringFilter = ctx.createBiquadFilter();
      stringFilter.type = 'lowpass';
      stringFilter.frequency.value = clamp(hz * 5 * brightness, 400, 9000);
      const stringGain = ctx.createGain();
      stringGain.gain.value = 0;
      const stringPan = panner(ctx, pan - spread * 0.3);
      strings.out.connect(stringFilter).connect(stringGain).connect(stringPan).connect(destination);
      strings.setFreq(hz, ctx.currentTime, 0);
      this.gains.push({ gain: stringGain.gain, target: level * 0.34, when: null });
      this.oscs.push(...strings.oscs, vibrato);
      this.nodes.push(stringFilter, stringGain, stringPan, vibratoDepth);
    });
  }

  /** Fade the whole voicing in or out, at a context time. Long by design:
   *  the shortest crossfade here is 8 s, and the chord's own change is the
   *  reason (spec §2 "a new one fades in under the old one"). */
  fade(target: number, duration = 16, when: number | null = null): void {
    const at = when ?? this.ctx.currentTime;
    for (const entry of this.gains) {
      ramp(entry.gain, entry.target * target, at, duration);
    }
  }

  dispose(when: number | null = null): void {
    const t = when ?? this.ctx.currentTime;
    for (const osc of this.oscs) {
      try {
        osc.stop(t + 1);
      } catch {
        /* already stopped */
      }
    }
    setTimeout(() => {
      for (const node of this.nodes) {
        try {
          node.disconnect();
        } catch {
          /* gone */
        }
      }
    }, 2500);
  }
}

interface Partial {
  h: number;
  amp: number;
  phase: number;
  drift: number;
}

/** A buffer of rich, string-like material for the granular cloud to cut up. */
export function createGrainBuffer(ctx: BaseAudioContext, seed: Seed = 0): AudioBuffer {
  const seconds = 3;
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  const rng = new Rng(seed).fork('grains');
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    const partials: Partial[] = [];
    for (let h = 1; h <= 12; h++) {
      partials.push({
        h,
        amp: Math.pow(h, -1.3) * (0.6 + rng.float() * 0.6),
        phase: rng.float() * Math.PI * 2,
        drift: (rng.float() - 0.5) * 0.4,
      });
    }
    for (let i = 0; i < length; i++) {
      const t = i / ctx.sampleRate;
      let s = 0;
      for (const p of partials) {
        s += p.amp * Math.sin(2 * Math.PI * (110 + p.drift * 3) * p.h * t + p.phase + p.drift * t);
      }
      data[i] = s * 0.08;
    }
  }
  return buffer;
}

interface GrainVoice {
  source: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  pan: StereoPannerNode;
  end: number;
}

export interface GrainCloudOptions {
  /** The material grains are cut from (createGrainBuffer). */
  buffer: AudioBuffer;
  seed?: Seed;
  density?: number;
  level?: number;
}

/**
 * Granular dust: short grains cut from the grain buffer, pitched to chord
 * tones, scattered in time and space. Positions are chosen by a seeded Rng, so
 * a seed reproduces the cloud as well as the harmony.
 */
export class GrainCloud {
  private readonly ctx: BaseAudioContext;
  private readonly destination: AudioNode;
  private readonly buffer: AudioBuffer;
  private readonly rng: Rng;
  private readonly density: number;
  private level: number;
  private notes: number[];
  private voices: GrainVoice[];

  constructor(
    ctx: BaseAudioContext,
    destination: AudioNode,
    { buffer, seed = 0, density = 1, level = 0.5 }: GrainCloudOptions,
  ) {
    this.ctx = ctx;
    this.destination = destination;
    this.buffer = buffer;
    this.rng = new Rng(seed).fork('cloud');
    this.density = density;
    this.level = level;
    this.notes = [220];
    this.voices = [];
  }

  setNotes(hzList: number[]): void {
    if (hzList.length) this.notes = [...hzList];
  }

  setLevel(level: number, duration = 20): void {
    this.level = clamp(level, 0, 1);
    void duration;
  }

  /** One grain, starting at `when`. */
  spawn(when: number, { level = 1, rate = null }: { level?: number; rate?: number | null } = {}): GrainVoice {
    const ctx = this.ctx;
    const dur = 0.6 + this.rng.float() * 2.4;
    const note = this.rng.pick(this.notes);
    const pitch = note * Math.pow(2, this.rng.pick([0, 0, 0, 12, -12]) / 12);
    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = clamp(pitch / 110, 0.25, 4) * (rate ?? 1);
    const offset = this.rng.float() * Math.max(0.01, this.buffer.duration - dur);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = clamp(pitch * (2 + this.rng.float() * 4), 200, 9000);
    filter.Q.value = 0.8 + this.rng.float() * 2;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const pan = panner(ctx, this.rng.signed());
    source.connect(filter).connect(gain).connect(pan).connect(this.destination);
    // A raised-cosine window: grains have no edges.
    const peak = this.level * level * (0.1 + this.rng.float() * 0.16);
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(peak, when + dur * 0.4);
    gain.gain.linearRampToValueAtTime(0, when + dur);
    source.start(when, offset, dur);
    source.stop(when + dur + 0.05);
    const voice: GrainVoice = { source, filter, gain, pan, end: when + dur + 0.2 };
    this.voices.push(voice);
    return voice;
  }

  /** Number of grains a second, from the mood's density and the drift. */
  rate(): number {
    return clamp(this.density * 3.2, 0, 12);
  }

  reap(until: number): void {
    this.voices = this.voices.filter((v) => {
      if (v.end > until) return true;
      try {
        v.source.disconnect();
        v.filter.disconnect();
        v.gain.disconnect();
        v.pan.disconnect();
      } catch {
        /* gone */
      }
      return false;
    });
  }
}

export interface WindOptions {
  seed?: Seed;
  level?: number;
}

/** Filtered noise winds: a band pass wandering over a very long period. */
export class Wind {
  private readonly ctx: BaseAudioContext;
  private readonly source: AudioBufferSourceNode;
  private readonly filter: BiquadFilterNode;
  private readonly gain: GainNode;
  private readonly lfo: OscillatorNode;
  private target: number;

  constructor(ctx: BaseAudioContext, destination: AudioNode, { seed = 0, level = 0.4 }: WindOptions = {}) {
    const rng = new Rng(seed).fork('wind');
    this.ctx = ctx;
    this.source = ctx.createBufferSource();
    this.source.buffer = createNoiseBuffer(ctx, 8, rng.int(1e6), { color: 'pink' });
    this.source.loop = true;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'bandpass';
    this.filter.frequency.value = 320;
    this.filter.Q.value = 1.1;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.source
      .connect(this.filter)
      .connect(this.gain)
      .connect(panner(ctx, rng.signed() * 0.4))
      .connect(destination);
    // Wide, slow sweeps: the wind takes minutes to change direction.
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = 0.012 + rng.float() * 0.02;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 240;
    this.lfo.connect(lfoDepth).connect(this.filter.frequency);
    this.lfo.start();
    this.source.start();
    this.target = level;
  }

  setLevel(level: number, duration = 25): void {
    this.target = clamp(level, 0, 1);
    ramp(this.gain.gain, this.target * 0.5, this.ctx.currentTime, duration);
  }

  dispose(): void {
    this.source.stop();
    this.lfo.stop();
  }
}

/** Shimmering high partials: quiet, far above the chords, mostly in the reverb. */
export class Shimmer {
  private readonly ctx: BaseAudioContext;
  private readonly oscs: OscillatorNode[];
  private readonly gain: GainNode;

  constructor(ctx: BaseAudioContext, destination: AudioNode, { seed = 0 }: { seed?: Seed } = {}) {
    const rng = new Rng(seed).fork('shimmer');
    this.ctx = ctx;
    this.oscs = [];
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 1200;
    this.gain.connect(filter).connect(panner(ctx, rng.signed() * 0.5)).connect(destination);
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 1200 * Math.pow(2, i / 3);
      const g = ctx.createGain();
      g.gain.value = 0.25 / (i + 1);
      // A slow tremolo each, out of step, so they never pulse together.
      const trem = ctx.createOscillator();
      trem.frequency.value = 0.02 + rng.float() * 0.05;
      const tremDepth = ctx.createGain();
      tremDepth.gain.value = 0.12;
      trem.connect(tremDepth).connect(g.gain);
      trem.start();
      osc.connect(g).connect(this.gain);
      osc.start();
      this.oscs.push(osc, trem);
    }
  }

  /** Tune the partials to the chord's upper register. */
  tune(notesHz: number[], when: number, glide = 18): void {
    const partials = [3, 4, 6];
    this.oscs.forEach((osc, i) => {
      if (i % 2 !== 0) return; // every other node is a tremolo
      const note = notesHz[(i / 2) % notesHz.length] ?? 220;
      const factor = partials[(i / 2) % partials.length] ?? 3;
      setFreq(osc.frequency, clamp(note * factor, 400, 12000), when, glide);
    });
  }

  setLevel(level: number, duration = 25): void {
    ramp(this.gain.gain, clamp(level, 0, 1) * 0.06, this.ctx.currentTime, duration);
  }

  dispose(): void {
    for (const osc of this.oscs) osc.stop();
  }
}

export interface EventOptions {
  /** The piece's current root, so an event sits in the key. */
  rootHz: number;
}

/** Far-away events: sparse, unsynchronised, always wet (spec §2). */
export function playEvent(
  ctx: BaseAudioContext,
  destination: AudioNode,
  event: PieceEvent,
  { rootHz }: EventOptions,
): number {
  const { t, type, params } = event;
  const dur = params.duration ?? 12;
  const level = params.level ?? 0.8;
  const pan = panner(ctx, params.pan ?? 0);
  pan.connect(destination);
  const nodes: AudioNode[] = [];
  const oscs: OscillatorNode[] = [];

  const gain = ctx.createGain();
  gain.gain.value = 0;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 2400;
  filter.Q.value = 0.7;
  gain.connect(filter).connect(pan);
  nodes.push(gain, filter, pan);

  const intervalHz = rootHz * Math.pow(2, (params.interval ?? 0) / 12);

  if (type === 'risingSweep') {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(intervalHz * 0.5, t);
    osc.frequency.exponentialRampToValueAtTime(intervalHz * 2.5, t + dur);
    const g = ctx.createGain();
    g.gain.value = 0.5;
    osc.connect(g).connect(gain);
    filter.frequency.setValueAtTime(400, t);
    filter.frequency.exponentialRampToValueAtTime(5000, t + dur);
    osc.start(t);
    osc.stop(t + dur + 0.5);
    oscs.push(osc);
    nodes.push(g);
  } else if (type === 'distantTone' || type === 'farBell') {
    const partials = type === 'farBell' ? [1, 2.76, 5.4] : [1, 2, 3];
    partials.forEach((mult, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = intervalHz * 2 * mult;
      const g = ctx.createGain();
      g.gain.value = 0.5 / (i + 1);
      osc.connect(g).connect(gain);
      osc.start(t);
      osc.stop(t + (type === 'farBell' ? dur * 2.2 : dur) + 0.5);
      oscs.push(osc);
      nodes.push(g);
    });
    filter.frequency.value = 1600;
  } else if (type === 'shimmerBurst') {
    [5, 8, 12].forEach((mult, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = clamp(intervalHz * mult, 800, 14000);
      const g = ctx.createGain();
      g.gain.value = 0.22 / (i + 1);
      osc.connect(g).connect(gain);
      osc.start(t);
      osc.stop(t + dur + 0.5);
      oscs.push(osc);
      nodes.push(g);
    });
    filter.frequency.value = 6000;
  } else {
    // dustCloud: a scatter of noise grains, no pitch of its own.
    const buffer = createNoiseBuffer(ctx, 2, (params.interval ?? 1) * 977, { color: 'pink' });
    const count = 24;
    for (let i = 0; i < count; i++) {
      const at = t + (i / count) * dur * 0.9;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = 0.6 + ((i * 37) % 100) / 100;
      const g = ctx.createGain();
      g.gain.value = 0;
      const grainDur = 0.5 + ((i * 53) % 100) / 60;
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.12, at + grainDur * 0.4);
      g.gain.linearRampToValueAtTime(0, at + grainDur);
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 300 + ((i * 71) % 900);
      band.Q.value = 1.4;
      src.connect(band).connect(g).connect(gain);
      src.start(at, (i * 0.13) % 1.2, grainDur);
      src.stop(at + grainDur + 0.1);
      nodes.push(g, band);
    }
  }

  // The envelope: always at least several seconds, in and out.
  const attack = Math.min(4, dur * 0.35);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.34 * level, t + attack);
  gain.gain.linearRampToValueAtTime(0, t + dur);

  const total = dur + (type === 'farBell' ? dur * 1.4 : 2);
  setTimeout(() => {
    for (const node of nodes) {
      try {
        node.disconnect();
      } catch {
        /* gone */
      }
    }
    for (const osc of oscs) {
      try {
        osc.disconnect();
      } catch {
        /* gone */
      }
    }
  }, total * 1000);
  return total;
}
