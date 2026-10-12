// The tape model (spec §2: "wow and flutter (slow and fast pitch wobble),
// saturation, a soft high cut, a little hiss" — and "the warp depth and the
// tape's 'age' wander slowly").
//
// This is the piece Motif gains from Generative Singularity (spec §2, engine):
// a modulated delay for the wobble, a shaper for the saturation, a one-pole-ish
// low pass for the high cut, and a low hiss bed.

/** tanh saturation, normalised so full scale stays full scale. The WaveShaper
 *  oversamples 2x, the same choice Motif makes for its drive stages. */
export function saturationCurve(amount = 0.4, points = 1024): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(points);
  const k = Math.max(1e-4, amount * 6);
  const norm = Math.tanh(k);
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

export interface NoiseOptions {
  /** White for hiss, pink for winds: the two colours the layers ask for. */
  color?: 'white' | 'pink';
}

/** A looping noise buffer, white or gently pink (hiss and winds). */
export function createNoiseBuffer(
  ctx: BaseAudioContext,
  seconds: number,
  seed = 0,
  { color = 'white' }: NoiseOptions = {},
): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    // A cheap per-channel offset keeps the two channels decorrelated.
    let s = (seed + ch * 7919) >>> 0;
    for (let i = 0; i < length; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const white = (s / 4294967296) * 2 - 1;
      if (color === 'pink') {
        b0 = 0.99765 * b0 + white * 0.099046;
        b1 = 0.963 * b1 + white * 0.2965164;
        b2 = 0.57 * b2 + white * 1.0526913;
        data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.2;
      } else {
        data[i] = white * 0.5;
      }
    }
    // Fade the loop seam so a looping source never clicks.
    const seam = Math.min(2048, Math.floor(length / 8));
    for (let i = 0; i < seam; i++) {
      const g = i / seam;
      data[i] *= g;
      data[length - 1 - i] *= g;
    }
  }
  return buffer;
}

/** One slow oscillator whose output is a parameter offset. */
export interface SlowLfo {
  readonly osc: OscillatorNode;
  readonly gain: GainNode;
  /** Somewhere to remember which parameter this one drives. */
  readonly offset: number;
  connect(param: AudioParam): void;
  stop(when?: number): void;
}

/** A low-frequency source, so a parameter can wander without a memory of it. */
function slowLfo(
  ctx: BaseAudioContext,
  frequency: number,
  depth: number,
  offset = 0,
  type: OscillatorType = 'sine',
): SlowLfo {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = frequency;
  const gain = ctx.createGain();
  gain.gain.value = depth;
  osc.connect(gain);
  osc.start();
  return {
    osc,
    gain,
    offset,
    connect: (param) => gain.connect(param),
    stop: (when) => osc.stop(when),
  };
}

export interface TapeOptions {
  /** Wow and flutter depth multiplier: 1 is the calibrated transport. */
  wow?: number;
  /** 0..1: a new tape cuts high, an old one is dull and noisy. */
  age?: number;
  /** Seed for the hiss bed, so a journey reproduces its own noise. */
  noiseSeed?: number;
}

/**
 * One tape stage. `input` is fed by the voice, `output` goes on to the bus.
 * `setWarp` moves wow/flutter depth and `setAge` moves the high cut and the hiss
 * — both over seconds, never as steps.
 */
export class Tape {
  readonly ctx: BaseAudioContext;
  readonly input: GainNode;
  readonly output: GainNode;

  private readonly baseDelay: number;
  private readonly delay: DelayNode;
  private readonly wow: SlowLfo;
  private readonly flutter: SlowLfo;
  private readonly drift: SlowLfo;
  private readonly shaper: WaveShaperNode;
  private readonly highCut: BiquadFilterNode;
  private readonly hiss: AudioBufferSourceNode;
  private readonly hissGain: GainNode;

  constructor(ctx: BaseAudioContext, { wow = 1, age = 0.4, noiseSeed = 0 }: TapeOptions = {}) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();

    this.baseDelay = 0.008; // 8 ms of tape transport
    this.delay = ctx.createDelay(0.25);
    this.delay.delayTime.value = this.baseDelay;

    this.wow = slowLfo(ctx, 0.37, 0.0028, 0, 'sine');
    this.flutter = slowLfo(ctx, 6.7, 0.00028, 0, 'triangle');
    this.wow.gain.gain.value = 0.0028 * wow;
    this.wow.gain.connect(this.delay.delayTime);
    this.flutter.gain.connect(this.delay.delayTime);
    // The warp depth drifts too: the tape is not a machine that stays steady.
    this.drift = slowLfo(ctx, 0.021, 0.0012);
    this.drift.gain.connect(this.delay.delayTime);

    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = saturationCurve(0.35);
    this.shaper.oversample = '2x';

    this.highCut = ctx.createBiquadFilter();
    this.highCut.type = 'lowpass';
    this.highCut.frequency.value = 9000;
    this.highCut.Q.value = 0.6;

    this.hiss = ctx.createBufferSource();
    this.hiss.buffer = createNoiseBuffer(ctx, 4, noiseSeed, { color: 'white' });
    this.hiss.loop = true;
    const hissFilter = ctx.createBiquadFilter();
    hissFilter.type = 'highpass';
    hissFilter.frequency.value = 3000;
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0.0016;
    this.hiss.connect(hissFilter).connect(this.hissGain).connect(this.output);
    this.hiss.start();

    this.input.connect(this.delay);
    this.delay.connect(this.shaper);
    this.shaper.connect(this.highCut);
    this.highCut.connect(this.output);

    this.setAge(age, 0);
  }

  /** `warp` 0..2: how much the transport wobbles. */
  setWarp(warp: number, duration = 10): void {
    const now = this.ctx.currentTime;
    const wow = 0.0028 * Math.max(0.15, warp);
    const flutter = 0.00028 * Math.max(0.15, warp);
    this.wow.gain.gain.setTargetAtTime(wow, now, Math.max(0.05, duration / 3));
    this.flutter.gain.gain.setTargetAtTime(flutter, now, Math.max(0.05, duration / 3));
  }

  /** `age` 0..1: a new tape cuts high; an old one is dull and noisy. */
  setAge(age: number, duration = 10): void {
    const now = this.ctx.currentTime;
    const a = Math.min(1, Math.max(0, age));
    const cut = 11500 - a * 8200;
    const tau = Math.max(0.05, duration / 3);
    this.highCut.frequency.setTargetAtTime(cut, now, tau);
    this.hissGain.gain.setTargetAtTime(0.0009 + a * 0.0045, now, tau);
  }

  dispose(when?: number): void {
    const t = when ?? this.ctx.currentTime;
    try {
      this.hiss.stop(t);
      this.wow.stop(t);
      this.flutter.stop(t);
      this.drift.stop(t);
    } catch {
      /* already stopped */
    }
    setTimeout(() => {
      try {
        this.input.disconnect();
        this.output.disconnect();
        this.delay.disconnect();
      } catch {
        /* already gone */
      }
    }, 200);
  }
}
