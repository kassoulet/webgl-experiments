// The small Web Audio building blocks every voice needs, in one place.
//
// A rave is a distorted kick, a bright saw and a noise burst, so the things
// that matter here are a saturation curve, a noise buffer, a room and an echo.
// All of them are built once and reused; nothing here allocates per hit.

import { Rng } from '@fractal-rave/shared';

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
  /** Seconds of noise. Two is plenty for hats and claps; risers want more. */
  seconds?: number;
  /** 0 is white, 1 is heavily low-passed: "air" rather than hiss. */
  colour?: number;
  seed?: number;
  channels?: number;
}

/** A seeded noise buffer. Unseeded noise would break the promise that a seed
 *  reproduces a set: two pages with the same seed would hiss differently. */
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
 * The room: a long, decaying hall with a handful of early reflections, built
 * once per context (spec §2 "Space: long reverbs and delays are part of the
 * sound, not an effect on top").
 */
export function createReverbImpulse(ctx: BaseAudioContext, seed = 0, seconds = 7): AudioBuffer {
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
      lowpass += (white - lowpass) * 0.4;
      data[i] = lowpass * Math.exp(-t / (seconds * 0.3));
    }
    const reflections = 12;
    for (let r = 0; r < reflections; r++) {
      const at = Math.floor((0.008 + rng.float() * 0.16) * rate);
      if (at < length) data[at] += rng.signed() * 0.5 * (1 - r / reflections);
    }
  }
  return buffer;
}

/**
 * A tempo-synced echo: a dotted eighth, which is the delay a clap and a stab
 * are mixed through in almost every track that has them.
 */
export function createEcho(ctx: BaseAudioContext, seconds: number): DelayNode {
  const delay = ctx.createDelay(2);
  delay.delayTime.value = Math.min(1.9, Math.max(0.02, seconds));
  return delay;
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
