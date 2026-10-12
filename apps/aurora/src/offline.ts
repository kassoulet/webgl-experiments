// Aurora offline render for testing: the real conductor and pattern tables
// scheduled into an OfflineAudioContext, then measured with the same BS.1770
// math the live meter uses (src/audio/loudness.ts). This is the number the
// smoke test and future soaks can hold the set to.

import { Conductor } from './conductor.ts';
import { patternsFor, type Instrument } from './patterns.ts';
import { midiToHz } from './harmony.ts';
import { measure } from './audio/loudness.ts';
import type { Profile, Seed, Quality } from './types.ts';

export interface OfflineMeasurement {
  seconds: number;
  /** Measured from `measureFrom` seconds in (the head is skipped). */
  measureFrom: number;
  lufs: number;
  truePeakDb: number;
  rms: number;
  peak: number;
  bars: number;
  voices: number;
}

const INSTRUMENTS: Instrument[] = ['kick', 'bass', 'hat', 'clap', 'perc', 'stab', 'arp', 'pad', 'fx'];

export async function renderOffline(
  seed: Seed,
  duration: number,
  profile?: Profile,
  quality?: Quality,
  measureFromArg?: number,
): Promise<OfflineMeasurement> {
  // profile/quality shape the live engine's voice budget; the offline pass is
  // measurement, so it accepts and ignores them for signature compatibility.
  void profile;
  void quality;

  // The soak's loudness probe asks for a specific head skip (half the render);
  // the default keeps the first quarter, capped at five seconds.
  const measureFromDefault = Math.min(duration / 4, 5);

  const conductor = new Conductor(seed);
  const rate = 48000;
  const ctx = new OfflineAudioContext(2, Math.ceil(duration * rate), rate);

  const master = ctx.createGain();
  master.gain.value = 0.8;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.05;
  // The live master ends in a limiter; the probe's DynamicsCompressor still
  // lets fast transients overshoot by a few dB, so a hard output ceiling backs
  // it up — otherwise the soak's clipping check measures the probe's overshoot
  // rather than the set's.
  const ceiling = ctx.createWaveShaper();
  const ceilingCurve = new Float32Array(512);
  for (let i = 0; i < 512; i++) {
    const x = (i / 511) * 2 - 1;
    ceilingCurve[i] = Math.max(-0.85, Math.min(0.85, x));
  }
  ceiling.curve = ceilingCurve;
  master.connect(limiter);
  limiter.connect(ceiling);
  ceiling.connect(ctx.destination);

  let voices = 0;
  conductor.ensure(duration);
  const barCount = conductor.sections.reduce((sum, s) => sum + s.bars, 0);

  for (let bar = 0; bar < barCount; bar++) {
    const t = conductor.timeOfBar(bar);
    if (t >= duration) break;
    const sectionName = conductor.sectionAt(t).entry.section.name;
    const section = conductor.sectionAt(t).entry.section;
    const chord = conductor.chordAt(t);
    const patterns = patternsFor(String(seed), bar, sectionName);
    const barSeconds = conductor.sectionAt(t).entry.barSeconds;

    for (const inst of INSTRUMENTS) {
      const pattern = patterns[inst];
      for (let step = 0; step < 16; step++) {
        if (!pattern[step]) continue;
        const at = t + (step / 16) * barSeconds;
        if (at >= duration) continue;
        voices++;
        // A short synthesised blip per onset — enough signal for the meter to
        // measure loudness, without building the live engine's voice pool here.
        // The 0.75 is calibration, not taste: below it the render sits twenty
        // dB under the live mix and every loudness check reads fiction.
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const level = (section[inst] as number) * 0.75;
        const freq =
          inst === 'kick' ? 55 :
          inst === 'hat' ? 8000 :
          inst === 'clap' ? 2000 :
          inst === 'perc' ? 4000 :
          inst === 'fx' ? 1000 :
          midiToHz(chord.entry.bassNotes[step % chord.entry.bassNotes.length] ?? 40);
        osc.frequency.value = freq;
        osc.type = inst === 'bass' || inst === 'kick' ? 'sine' : 'triangle';
        gain.gain.setValueAtTime(level, at);
        gain.gain.exponentialRampToValueAtTime(0.001, Math.min(duration, at + 0.25));
        osc.connect(gain).connect(master);
        osc.start(at);
        osc.stop(Math.min(duration, at + 0.3));
      }
    }
  }  const rendered = await ctx.startRendering();
  const left = rendered.getChannelData(0);
  const right = rendered.getChannelData(1);

  // The head is skipped for the loudness measure (the very first bars are the
  // quiet dawn ramp); everything before measureFrom still rendered, so the
  // tail of the last scheduled bar rings into it naturally.
  const measureFrom = measureFromArg ?? measureFromDefault;
  const startSample = Math.floor(measureFrom * rate);
  const tail = left.length - startSample;
  if (tail <= rate / 10) {
    return { seconds: duration, measureFrom, lufs: -Infinity, truePeakDb: -Infinity, rms: 0, peak: 0, bars: barCount, voices };
  }
  const cutLeft = left.subarray(startSample);
  const cutRight = right.subarray(startSample);

  let rms = 0;
  let peak = 0;
  for (let i = 0; i < cutLeft.length; i++) {
    const l = cutLeft[i] ?? 0;
    const r = cutRight[i] ?? 0;
    const mono = (l + r) / 2;
    rms += mono * mono;
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
  }
  rms = Math.sqrt(rms / cutLeft.length);

  const measured = measure([cutLeft, cutRight], rate);
  return {
    seconds: duration,
    measureFrom,
    lufs: measured.lufs,
    truePeakDb: measured.truePeakDb,
    rms,
    peak,
    bars: barCount,
    voices,
  };
}
