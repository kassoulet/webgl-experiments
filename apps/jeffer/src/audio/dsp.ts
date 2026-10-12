// The small Web Audio building blocks every voice needs, in one place.
//
// Electro is a dry, saturated, bass-forward record (measured off the reference:
// 62 Hz dominant, almost nothing above 8 kHz), so the two things that matter
// here are a saturation curve with real weight behind it and a room that is
// felt rather than heard. All of them are built once and reused; nothing here
// allocates per hit.

import { Rng } from '../rng.ts';

/** A tanh-ish saturation curve for a WaveShaper, in [-1, 1]. */
export function saturationCurve(amount = 0.4, points = 1024): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(points);
  const k = Math.max(0.0001, amount) * 4;
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return curve;
}

export interface NoiseOptions {
  /** Seconds of noise. One is plenty for hats and claps. */
  seconds?: number;
  /** 0 is white, 1 is heavily low-passed: "air" rather than hiss. */
  colour?: number;
  seed?: number;
  channels?: number;
}

/**
 * A seeded noise buffer. Unseeded noise would break the promise that a seed
 * reproduces a set: two pages with the same seed would hiss differently.
 */
export function createNoiseBuffer(
  ctx: BaseAudioContext,
  { seconds = 2, colour = 0, seed = 1, channels = 1 }: NoiseOptions = {},
): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(rate * seconds));
  const buffer = ctx.createBuffer(channels, length, rate);
  const rng = new Rng(seed);
  for (let ch = 0; ch < channels; ch++) {
    const data = buffer.getChannelData(ch);
    let lowpass = 0;
    const mix = 1 - Math.min(1, Math.max(0, colour));
    for (let i = 0; i < length; i++) {
      const white = rng.signed();
      lowpass += (white - lowpass) * (1 - mix);
      data[i] = mix * white + (1 - mix) * lowpass;
    }
  }
  return buffer;
}

/**
 * The room. Short and dark, because the reference is a club record mixed dry:
 * a long reverb on this material sounds like a different genre. What is left
 * is a tight early-reflection cluster, which is what a small room actually
 * sounds like and what puts the track in a room without washing it.
 */
export function createReverbImpulse(ctx: BaseAudioContext, seed = 0, seconds = 3): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(rate * seconds));
  const buffer = ctx.createBuffer(2, length, rate);
  const rng = new Rng(seed).fork('reverb');
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let lowpass = 0;
    // A fast exponential decay. At three seconds the tail is already below the
    // noise floor of the record, which is the point.
    for (let i = 0; i < length; i++) {
      const t = i / rate;
      const white = rng.signed();
      lowpass += (white - lowpass) * 0.5;
      data[i] = lowpass * Math.exp(-t / (seconds * 0.18));
    }
    // Early reflections, tight and few: a room, not a hall.
    const reflections = 8;
    for (let r = 0; r < reflections; r++) {
      const at = Math.floor((0.004 + rng.float() * 0.07) * rate);
      if (at < length) data[at] += rng.signed() * 0.42 * (1 - r / reflections);
    }
  }
  return buffer;
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
