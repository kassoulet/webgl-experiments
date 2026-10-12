// Offline rendering, for measurement rather than listening. It builds the real
// engine on an OfflineAudioContext — the same graph, the same scheduler, the
// same loudness meter — renders a stretch of the piece faster than real time
// and reports what came out of the master.
//
// Nothing in the app calls this: the headless smoke test does (over the
// diagnostic hook in main.ts). It is how "the piece is in the loudness region"
// becomes a check on real samples instead of a hope.

import { Conductor } from './conductor.ts';
import { Engine } from './audio/engine.ts';
import { measure } from './audio/loudness.ts';
import type { Profile, Seed } from './types.ts';

export interface OfflineOptions {
  profile: Profile;
  seed?: Seed;
  /** Seconds of the piece to render. */
  seconds?: number;
  /** Seconds to skip before measuring, so the opening fade-in does not count. */
  measureFrom?: number;
  sampleRate?: number;
  volume?: number;
}

export interface OfflineMeasurement {
  seconds: number;
  measureFrom: number;
  /** RMS of the measured stretch, both channels. */
  rms: number;
  /** Largest single sample in the measured stretch. */
  peak: number;
  /** Gated programme loudness (BS.1770) over the whole render. */
  lufs: number;
  truePeakDb: number;
  /** What the engine's own trim was at the end. */
  trimDb: number;
  chords: number;
  grains: number;
}

export async function renderOffline({
  profile,
  seed = 'offline-check',
  seconds = 45,
  measureFrom = 25,
  sampleRate = 48000,
  volume = 1,
}: OfflineOptions): Promise<OfflineMeasurement> {
  const ctx = new OfflineAudioContext(2, Math.round(sampleRate * seconds), sampleRate);
  const conductor = new Conductor(seed);
  const engine = new Engine({ seed, profile, conductor, ctx, volume });
  await engine.start();
  const buffer = await ctx.startRendering();
  const stats = engine.stats();
  engine.stop();

  const left = Float32Array.from(buffer.getChannelData(0));
  const right = Float32Array.from(buffer.getChannelData(1));
  const from = Math.min(left.length - 1, Math.round(sampleRate * measureFrom));
  let sum = 0;
  let peak = 0;
  for (let i = from; i < left.length; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    const mono = (l + r) * 0.5;
    sum += mono * mono;
    const magnitude = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r);
    if (magnitude > peak) peak = magnitude;
  }
  const measured = measure([left, right], sampleRate);
  return {
    seconds,
    measureFrom,
    rms: Math.sqrt(sum / Math.max(1, left.length - from)),
    peak,
    lufs: measured.lufs,
    truePeakDb: measured.truePeakDb,
    trimDb: stats.trimDb,
    chords: stats.chords,
    grains: stats.grains,
  };
}
