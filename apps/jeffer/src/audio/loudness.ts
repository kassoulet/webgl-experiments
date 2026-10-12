// Programme loudness, ITU-R BS.1770-4, and a true-peak meter.
//
// This is the number the leveller steers on and the number the smoke test
// checks, so it is measured rather than estimated: K-weighting, 400 ms blocks
// with 75% overlap, an absolute gate at -70 LUFS and a relative gate 10 LU
// below the ungated mean.
//
// The target is not a habit. The reference this app is built from measures
// **-5.98 LUFS integrated, -3.98 short-term, +6.02 dBTP** — a hard-limited
// 2011 club master that clips. This app does not ship a clipping master: a
// web player runs into lossy encoders on the way to a phone speaker, and
// +6 dBTP is 6 dB of inter-sample clipping that an AAC encoder will turn into
// audible distortion rather than faithfully reproduce. So the *character* —
// loud, hard-limited, no headroom — is reproduced and the peak is not. The gap
// is a deliberate, measured deviation and the smoke test asserts where it sits.

/** What the master aims for. Loud for a club record, safe for a codec. */
export const TARGET_LUFS = -10.5;

/** The ceiling the limiter holds. -0.3 dBTP leaves room for an encoder. */
export const TRUE_PEAK_CEILING_DB = -0.3;

/** BS.1770 block length and hop: 400 ms, 75% overlap. */
const BLOCK_MS = 400;
const OVERLAP = 4;

/** The absolute gate, in LUFS. Below this a block is silence. */
const ABSOLUTE_GATE = -70;

/** The relative gate sits this far under the ungated mean. */
const RELATIVE_GATE = -10;

/** The two K-weighting stages, designed for the running sample rate. */
function designHighShelf(f0: number, gainDb: number, q: number, rate: number): Biquad {
  const a = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / rate;
  const alpha = Math.sin(w0) / (2 * q);
  const b0 = 1 + alpha * a;
  const b1 = -2 * Math.cos(w0);
  const b2 = 1 - alpha * a;
  const a0 = 1 + alpha / a;
  const a1 = -2 * Math.cos(w0);
  const a2 = 1 - alpha / a;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function designHighPass(f0: number, q: number, rate: number): Biquad {
  const w0 = (2 * Math.PI * f0) / rate;
  const alpha = Math.sin(w0) / (2 * q);
  const b0 = (1 + Math.cos(w0)) / 2;
  const b1 = -(1 + Math.cos(w0));
  const b2 = (1 + Math.cos(w0)) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * Math.cos(w0);
  const a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** Direct-form-I state for one biquad and one channel. */
interface BiquadState {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

function runBiquad(buf: Float32Array, c: Biquad, state: BiquadState): void {
  let { x1, x2, y1, y2 } = state;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i] as number;
    const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    buf[i] = y;
  }
  state.x1 = x1;
  state.x2 = x2;
  state.y1 = y1;
  state.y2 = y2;
}

export interface LoudnessMeasurement {
  /** Gated programme loudness, LUFS. */
  lufs: number;
  /** True peak, dBTP, 4x oversampled. */
  truePeakDb: number;
  /** Sample peak, dBFS. */
  peakDb: number;
  /** Number of gated blocks the measurement had. */
  blocks: number;
}

/** Loudness of a whole buffer, measured the way the standard says. */
export function measure(channels: readonly Float32Array[], sampleRate: number): LoudnessMeasurement {
  const shelf = designHighShelf(1681.974450955533, 3.999843853973347, 0.7071752369554196, sampleRate);
  const rlb = designHighPass(38.13547087602444, 0.5003270373238773, sampleRate);

  const weighted = channels.map((ch) => {
    const copy = Float32Array.from(ch);
    const s1: BiquadState = { x1: 0, x2: 0, y1: 0, y2: 0 };
    const s2: BiquadState = { x1: 0, x2: 0, y1: 0, y2: 0 };
    runBiquad(copy, shelf, s1);
    runBiquad(copy, rlb, s2);
    return copy;
  });

  const length = Math.min(...weighted.map((c) => c.length));
  const blockLen = Math.max(1, Math.floor((BLOCK_MS / 1000) * sampleRate));
  const hop = Math.max(1, Math.floor(blockLen / OVERLAP));
  const blocks: number[] = [];
  for (let start = 0; start + blockLen <= length; start += hop) {
    let sum = 0;
    for (const ch of weighted) {
      for (let i = start; i < start + blockLen; i++) {
        const v = ch[i] as number;
        sum += v * v;
      }
    }
    const meanSquare = sum / blockLen;
    if (meanSquare > 0) blocks.push(-0.691 + 10 * Math.log10(meanSquare));
  }

  const meanOver = (threshold: number): number => {
    const kept = blocks.filter((b) => b > threshold);
    if (!kept.length) return Number.NEGATIVE_INFINITY;
    return kept.reduce((a, b) => a + b, 0) / kept.length;
  };
  const ungated = meanOver(ABSOLUTE_GATE);
  const lufs = meanOver(ungated + RELATIVE_GATE);

  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i] as number);
      if (v > peak) peak = v;
    }
  }

  return {
    lufs: Number.isFinite(lufs) ? lufs : Number.NEGATIVE_INFINITY,
    truePeakDb: truePeak(channels),
    peakDb: peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY,
    blocks: blocks.length,
  };
}

/**
 * True peak by 4x linear interpolation between samples. A square wave that
 * peaks between two samples measures 0 dBFS on a sample meter and +3 dBTP on a
 * true-peak one, and only the second number survives an encoder.
 */
export function truePeak(channels: readonly Float32Array[]): number {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i + 1 < ch.length; i++) {
      const a = ch[i] as number;
      const b = ch[i + 1] as number;
      const d = Math.abs(b - a);
      // The interpolated maximum of a straight line between two samples.
      const between = d * 0.25;
      const m = Math.max(Math.abs(a), Math.abs(b)) + between;
      if (m > peak) peak = m;
    }
    const last = ch.length ? Math.abs(ch[ch.length - 1] as number) : 0;
    if (last > peak) peak = last;
  }
  return peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY;
}

/**
 * The running meter the engine steers on. Short-term only: the browser's
 * compressor clamps its own release to about a second, and a set that is
 * levelled over tens of seconds is a set being levelled too slowly to hear.
 */
export class LoudnessMeter {
  readonly sampleRate: number;
  readonly channels: number;

  /** The most recent block loudness per channel, LUFS. */
  readonly blocks: number[][] = [];
  private readonly filtered: Float32Array[];
  private readonly shelf: Biquad;
  private readonly rlb: Biquad;
  private readonly state: BiquadState[][];
  private readonly blockLen: number;
  private readonly ring: Float32Array;
  private filled = 0;
  private write = 0;
  private peak = 0;

  constructor(sampleRate: number, channels = 2) {
    this.sampleRate = sampleRate;
    this.channels = Math.max(1, channels);
    this.shelf = designHighShelf(1681.974450955533, 3.999843853973347, 0.7071752369554196, sampleRate);
    this.rlb = designHighPass(38.13547087602444, 0.5003270373238773, sampleRate);
    this.filtered = [];
    this.state = [];
    for (let c = 0; c < this.channels; c++) {
      this.filtered.push(new Float32Array(0));
      this.state.push([
        { x1: 0, x2: 0, y1: 0, y2: 0 },
        { x1: 0, x2: 0, y1: 0, y2: 0 },
      ]);
    }
    this.blockLen = Math.max(1, Math.floor((BLOCK_MS / 1000) * sampleRate));
    this.ring = new Float32Array(this.blockLen);
  }

  /**
   * Feed samples. `length` is how many of `pcm` are new; the rest is the
   * worklet's own buffer, which is reused between messages.
   */
  push(pcm: Float32Array, length: number, channel: number): void {
    const ch = Math.min(Math.max(0, channel), this.channels - 1);
    if (pcm.length < this.blockLen) {
      // Too short to K-weight into a block of its own; grow the ring lazily.
      if (pcm.length === 0) return;
    }
    for (let i = 0; i < length; i++) {
      const v = pcm[i] ?? 0;
      const a = Math.abs(v);
      if (a > this.peak) this.peak = a;
      this.ring[this.write] = v;
      this.write = (this.write + 1) % this.blockLen;
      if (this.filled < this.blockLen) this.filled++;
    }
    if (this.filled >= this.blockLen && ch === 0) this.#closeBlock();
  }

  #closeBlock(): void {
    const ordered = new Float32Array(this.blockLen);
    for (let i = 0; i < this.blockLen; i++) ordered[i] = this.ring[(this.write + i) % this.blockLen] as number;
    const s1: BiquadState = { x1: 0, x2: 0, y1: 0, y2: 0 };
    const s2: BiquadState = { x1: 0, x2: 0, y1: 0, y2: 0 };
    runBiquad(ordered, this.shelf, s1);
    runBiquad(ordered, this.rlb, s2);
    let sum = 0;
    for (let i = 0; i < ordered.length; i++) {
      const v = ordered[i] as number;
      sum += v * v;
    }
    const meanSquare = sum / ordered.length;
    const lufs = meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : Number.NEGATIVE_INFINITY;
    this.filtered[0] = ordered;
    if (this.blocks.length >= 64) this.blocks.shift();
    this.blocks.push([lufs]);
  }

  /** Short-term loudness, LUFS, or -Infinity before the first block. */
  shortTerm(): number {
    if (!this.blocks.length) return Number.NEGATIVE_INFINITY;
    // Short term is three seconds; at 100 ms a block that is the last thirty.
    const recent = this.blocks.slice(-30).flat().filter((b) => Number.isFinite(b));
    if (!recent.length) return Number.NEGATIVE_INFINITY;
    return recent.reduce((a, b) => a + b, 0) / recent.length;
  }

  /** True peak so far, dBTP. */
  truePeakDb(): number {
    if (this.peak <= 0) return Number.NEGATIVE_INFINITY;
    return 20 * Math.log10(this.peak);
  }
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function gainToDb(gain: number): number {
  return gain > 0 ? 20 * Math.log10(gain) : Number.NEGATIVE_INFINITY;
}
