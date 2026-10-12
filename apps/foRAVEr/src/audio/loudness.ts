// Loudness per ITU-R BS.1770 / EBU R128 (spec §2 "Loudness", §6 targets).
// Pure: it takes sample frames and returns numbers, so it is unit-testable and
// runs in tests, a worker or a meter without an audio device.
//
// The app uses it to keep the master honest (around −15…−13 LUFS, true peak
// ≤ −1 dBTP); on the native side Motif does the same with `ebur128`.
//
// Unchanged from `apps/singularity/src/audio/loudness.ts`: the standard is the
// standard, and two copies that must agree is worse than one shared file in a
// repository where neither app can import the other's sources.

/** A 2nd-order section: three numerator and three denominator coefficients. */
type Biquad = { b: [number, number, number]; a: [number, number, number] };
type BiquadState = { x1: number; x2: number; y1: number; y2: number };
type ChannelState = { s1: BiquadState; s2: BiquadState };

/** Stage 1: the K-weighting pre-filter (a high shelf). */
function shelfCoeffs(fs: number): Biquad {
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  return {
    b: [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0],
    a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0],
  };
}

/** Stage 2: the RLB high-pass. */
function highpassCoeffs(fs: number): Biquad {
  const f0 = 38.13547087602444;
  const Q = 0.5003270373238773;
  const K = Math.tan((Math.PI * f0) / fs);
  const a0 = 1 + K / Q + K * K;
  return {
    b: [1 / a0, -2 / a0, 1 / a0],
    a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0],
  };
}

const LUFS_OFFSET = -0.691;
export const ABSOLUTE_GATE = -70;
export const RELATIVE_GATE = -10;

export const powerToLufs = (power: number): number => (power > 0 ? LUFS_OFFSET + 10 * Math.log10(power) : -Infinity);
export const gainToDb = (gain: number): number => (gain > 0 ? 20 * Math.log10(gain) : -Infinity);
export const dbToGain = (db: number): number => Math.pow(10, db / 20);

const BLOCK_SECONDS = 0.4;
const STEP_SECONDS = 0.1; // 75 % overlap, as the standard specifies
const SHORT_TERM_STEPS = 30; // 3 s

export class LoudnessMeter {
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly oversample: number;
  readonly stepSize: number;
  readonly blockSteps: number;

  shelf!: Biquad;
  highpass!: Biquad;
  states!: ChannelState[];
  stepPower!: number;
  stepFill!: number;
  stepRing!: number[];
  /** Overlapping 400 ms block mean squares — the gating source. */
  blocks!: number[];
  recent!: number[];
  peak!: number;
  prevSample!: Float64Array;

  constructor(sampleRate: number, channelCount = 2) {
    this.sampleRate = sampleRate;
    this.channelCount = channelCount;
    this.oversample = 4;
    this.stepSize = Math.max(1, Math.round(STEP_SECONDS * sampleRate));
    this.blockSteps = Math.max(1, Math.round(BLOCK_SECONDS / STEP_SECONDS));
    this.reset();
  }

  reset(): void {
    this.shelf = shelfCoeffs(this.sampleRate);
    this.highpass = highpassCoeffs(this.sampleRate);
    this.states = Array.from({ length: this.channelCount }, () => ({
      s1: { x1: 0, x2: 0, y1: 0, y2: 0 },
      s2: { x1: 0, x2: 0, y1: 0, y2: 0 },
    }));
    this.stepPower = 0;
    this.stepFill = 0;
    this.stepRing = [];
    this.blocks = []; // overlapping 400 ms block mean squares (gating source)
    this.recent = []; // last few blocks, for short-term loudness
    this.peak = 0;
    this.prevSample = new Float64Array(this.channelCount);
  }

  /** Push one frame buffer per channel. Blocks close as the 100 ms steps do. */
  push(channels: Float32Array[], frameCount: number = channels[0]!.length, offset = 0): void {
    const nch = Math.min(this.channelCount, channels.length);
    const end = offset + frameCount;

    // True-peak estimate: 4x linear interpolation between neighbouring samples.
    for (let ch = 0; ch < nch; ch++) {
      const data = channels[ch]!;
      let prev = this.prevSample[ch]!;
      let peak = this.peak;
      for (let i = offset; i < end; i++) {
        const cur = data[i]!;
        const a = cur < 0 ? -cur : cur;
        if (a > peak) peak = a;
        for (let k = 1; k < this.oversample; k++) {
          const v = prev + (cur - prev) * (k / this.oversample);
          const av = v < 0 ? -v : v;
          if (av > peak) peak = av;
        }
        prev = cur;
      }
      this.prevSample[ch] = prev;
      this.peak = peak;
    }

    // K-weighted power, accumulated into 100 ms steps.
    for (let i = offset; i < end; i++) {
      let framePower = 0;
      for (let ch = 0; ch < nch; ch++) {
        const y = this.#weight(channels[ch]![i]!, this.states[ch]!);
        framePower += y * y;
      }
      this.stepPower += framePower;
      if (++this.stepFill >= this.stepSize) this.#closeStep(nch);
    }
  }

  #weight(sample: number, state: ChannelState): number {
    const { b: sb, a: sa } = this.shelf;
    const s1 = state.s1;
    const y1 = sb[0] * sample + sb[1] * s1.x1 + sb[2] * s1.x2 - sa[1] * s1.y1 - sa[2] * s1.y2;
    s1.x2 = s1.x1;
    s1.x1 = sample;
    s1.y2 = s1.y1;
    s1.y1 = y1;

    const { b: hb, a: ha } = this.highpass;
    const s2 = state.s2;
    const y2 = hb[0] * y1 + hb[1] * s2.x1 + hb[2] * s2.x2 - ha[1] * s2.y1 - ha[2] * s2.y2;
    s2.x2 = s2.x1;
    s2.x1 = y1;
    s2.y2 = s2.y1;
    s2.y1 = y2;
    return y2;
  }

  #closeStep(channelCount: number): void {
    const stepMean = this.stepPower / (this.stepFill * channelCount);
    this.stepPower = 0;
    this.stepFill = 0;
    this.stepRing.push(stepMean);
    if (this.stepRing.length > this.blockSteps) this.stepRing.shift();
    if (this.stepRing.length === this.blockSteps) {
      let sum = 0;
      for (const p of this.stepRing) sum += p;
      const blockMean = sum / this.stepRing.length;
      this.blocks.push(blockMean);
      // Bounded memory: two hours of blocks is far more than anyone reads.
      if (this.blocks.length > 72000) this.blocks.shift();
      this.recent.push(blockMean);
      if (this.recent.length > SHORT_TERM_STEPS) this.recent.shift();
    }
  }

  #mean(powers: number[]): number {
    if (powers.length === 0) return 0;
    let sum = 0;
    for (const p of powers) sum += p;
    return sum / powers.length;
  }

  /** Gated programme loudness. */
  integrated(): number {
    const powers = this.blocks;
    if (powers.length === 0) return -Infinity;
    const aboveAbsolute = powers.filter((p) => powerToLufs(p) >= ABSOLUTE_GATE);
    if (aboveAbsolute.length === 0) return -Infinity;
    const threshold = powerToLufs(this.#mean(aboveAbsolute)) + RELATIVE_GATE;
    const aboveRelative = aboveAbsolute.filter((p) => powerToLufs(p) >= threshold);
    const chosen = aboveRelative.length ? aboveRelative : aboveAbsolute;
    return powerToLufs(this.#mean(chosen));
  }

  /** Loudness of the last 400 ms. */
  momentary(): number {
    return powerToLufs(this.stepRing.length === this.blockSteps ? this.#mean(this.stepRing) : 0);
  }

  /** Loudness of the last 3 s. */
  shortTerm(): number {
    return powerToLufs(this.#mean(this.recent));
  }

  truePeakDb(): number {
    return gainToDb(this.peak);
  }
}

/** Offline integrated loudness of a whole buffer set (tests, renders). */
export function measure(channels: Float32Array[], sampleRate: number): { lufs: number; truePeakDb: number } {
  const meter = new LoudnessMeter(sampleRate, channels.length);
  const frameCount = channels[0]!.length;
  const chunk = 8192;
  for (let off = 0; off < frameCount; off += chunk) {
    const len = Math.min(chunk, frameCount - off);
    meter.push(channels.map((c) => c.subarray(off, off + len)), len, 0);
  }
  return { lufs: meter.integrated(), truePeakDb: meter.truePeakDb() };
}
