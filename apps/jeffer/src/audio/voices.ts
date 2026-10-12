// The voices: one function per instrument, each scheduling its own nodes on the
// AudioContext's clock and cleaning them up when they have finished.
//
// Nothing here is triggered by a timer. The engine decides *what* plays and
// *when* — by reading the conductor — and calls in here to make a sound at a
// time the audio thread already knows about. Every oscillator is started and
// every source is stopped: an oscillator that is never started is silence, and
// stopping one that already ended throws.
//
// The sound is electro, and the two things that make it electro are here: a
// bass that is a *rolling line* rather than a held note, and a stab that goes
// through a pair of sweeping formants. Everything else on this record is in
// service of those two.

import { midiToHz } from '../harmony.ts';
import { clamp } from './dsp.ts';
import type { PieceEvent } from '../types.ts';

/** Where a voice's output goes, and how hard it is being pushed. */
export interface VoiceOptions {
  velocity: number;
  /** The master low-pass the passage asks for, in Hz. */
  cutoff: number;
  /** Detuned oscillators per synth note: 1 on a phone, 3 on a desktop. */
  voices: number;
}

const EPS = 0.0001;

/** A gain envelope that reaches `peak` at `when` and is silent `decay` later. */
function envelope(
  ctx: BaseAudioContext,
  peak: number,
  when: number,
  decay: number,
  attack = 0.003,
): GainNode {
  const gain = ctx.createGain();
  const level = Math.max(EPS, peak);
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(level, when + attack);
  gain.gain.exponentialRampToValueAtTime(EPS, when + attack + decay);
  return gain;
}

/** A low-pass that falls from `open` to `closed` over the note. */
function filterSweep(
  ctx: BaseAudioContext,
  open: number,
  closed: number,
  when: number,
  decay: number,
  resonance = 6,
): BiquadFilterNode {
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = resonance;
  filter.frequency.setValueAtTime(clamp(open, 40, 18000), when);
  filter.frequency.exponentialRampToValueAtTime(clamp(closed, 40, 18000), when + decay);
  return filter;
}

/**
 * The kick: a sine whose pitch falls from about three times the note to the
 * note in fifty milliseconds, plus a click. Electro kicks are dry and hard —
 * the reference's low end is 62 Hz with almost no tail above it — so this
 * decays fast and is not tuned to be felt more than heard.
 */
export function kick(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, when: number, { velocity }: VoiceOptions): void {
  const tune = 50;
  const decay = 0.4;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(tune * 3.6, when);
  osc.frequency.exponentialRampToValueAtTime(tune, when + 0.045);
  const body = envelope(ctx, velocity * 0.95, when, decay, 0.002);
  osc.connect(body).connect(out);
  osc.start(when);
  osc.stop(when + decay + 0.08);

  // The click is what makes it cut through on a small speaker, and it is the
  // only high-frequency content the kick has.
  const click = ctx.createBufferSource();
  click.buffer = noise;
  click.playbackRate.value = 1.6;
  const clickBand = ctx.createBiquadFilter();
  clickBand.type = 'bandpass';
  clickBand.frequency.value = 1800;
  clickBand.Q.value = 0.8;
  const clickGain = envelope(ctx, velocity * 0.28, when, 0.018, 0.001);
  click.connect(clickBand).connect(clickGain).connect(out);
  click.start(when, 0.1);
  click.stop(when + 0.06);
}

/**
 * The bass. This is the record.
 *
 * A saw and a sub an octave below it, through a resonant filter that opens and
 * closes across the note. The saw is the note and the sub is the weight, and
 * the resonance is what makes a sixteenth line sound like a bass synth rather
 * than a fast arpeggio — the filter is doing the talking, which is the whole
 * trick in electro and the reason this voice has its own bus.
 */
export function bass(
  ctx: BaseAudioContext,
  out: AudioNode,
  when: number,
  hz: number,
  { velocity, cutoff, accent = false }: VoiceOptions & { accent?: boolean },
): void {
  const decay = accent ? 0.16 : 0.1;
  const open = clamp(cutoff * (accent ? 2.6 : 1.9), 80, 16000);
  const closed = clamp(cutoff * (accent ? 0.6 : 0.4), 40, 16000);
  const filter = filterSweep(ctx, open, closed, when, decay, accent ? 11 : 8);
  const gain = envelope(ctx, velocity * 0.46, when, decay, 0.002);
  filter.connect(gain).connect(out);

  const saw = ctx.createOscillator();
  saw.type = 'sawtooth';
  saw.frequency.value = clamp(hz, 20, 8000);
  saw.connect(filter);
  saw.start(when);
  saw.stop(when + decay + 0.06);

  const sub = ctx.createOscillator();
  sub.type = 'sine';
  sub.frequency.value = clamp(hz / 2, 18, 4000);
  const subGain = envelope(ctx, velocity * 0.5, when, decay * 1.2, 0.003);
  sub.connect(subGain).connect(out);
  sub.start(when);
  sub.stop(when + decay * 1.2 + 0.06);
}

/**
 * The 808 metal: six square oscillators at inharmonic ratios of one base
 * frequency, band-passed. It is the oldest trick in electronic music and it is
 * still the best-sounding hat there is, because the ratios are not integers —
 * the partials never line up into a note, so it reads as metal rather than as
 * a pitch.
 */
const METAL_RATIOS = [2, 3, 4.16, 5.43, 6.79, 8.21];

export function metal(
  ctx: BaseAudioContext,
  out: AudioNode,
  when: number,
  base: number,
  decay: number,
  level: number,
): void {
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = clamp(base * 3.2, 200, 12000);
  band.Q.value = 0.9;
  const high = ctx.createBiquadFilter();
  high.type = 'highpass';
  high.frequency.value = clamp(base * 1.4, 120, 9000);
  const gain = envelope(ctx, level, when, decay, 0.001);
  band.connect(high).connect(gain).connect(out);
  for (const ratio of METAL_RATIOS) {
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = clamp(base * ratio, 60, 18000);
    osc.connect(band);
    osc.start(when);
    osc.stop(when + decay + 0.05);
  }
}

export function hat(
  ctx: BaseAudioContext,
  out: AudioNode,
  when: number,
  { velocity, open = false }: VoiceOptions & { open?: boolean },
): void {
  metal(ctx, out, when, 320, open ? 0.22 : 0.035, velocity * 0.2);
}

/** A metallic percussion hit, pitched by the caller so a bar's fills move. */
export function perc(
  ctx: BaseAudioContext,
  out: AudioNode,
  when: number,
  { velocity, pitch = 900 }: VoiceOptions & { pitch?: number },
): void {
  metal(ctx, out, when, pitch, 0.12, velocity * 0.16);
}

/** The clap: three short bursts and a tail, which is what makes a clap read as
 *  a room full of hands rather than as one hand. */
export function clap(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, when: number, { velocity }: VoiceOptions): void {
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 1500;
  band.Q.value = 1.1;
  band.connect(out);
  // Three bursts, 9 ms apart, then the tail that fills the room.
  for (let i = 0; i < 3; i++) {
    const at = when + i * 0.009;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = 1 + i * 0.04;
    const body = envelope(ctx, velocity * 0.5, at, 0.022, 0.001);
    src.connect(body).connect(band);
    src.start(at, 0.2 + i * 0.01);
    src.stop(at + 0.05);
  }
  const tail = ctx.createBufferSource();
  tail.buffer = noise;
  tail.playbackRate.value = 0.9;
  const tailBody = envelope(ctx, velocity * 0.34, when + 0.018, 0.16, 0.002);
  tail.connect(tailBody).connect(band);
  tail.start(when + 0.018, 0.35);
  tail.stop(when + 0.24);
}

/**
 * The stab — electro's talkbox, built from a saw and two band-pass filters
 * sweeping across it.
 *
 * Two formants is the whole trick: the first sweeps up, the second sweeps
 * down, and a detuned saw through the pair sounds like a voice that never
 * existed. It is the cheapest vocal in electronic music and the reason electro
 * stabs sound the way they do, so it is a real part graph rather than a filter
 * on a note.
 */
export function stab(
  ctx: BaseAudioContext,
  out: AudioNode,
  when: number,
  notes: number[],
  { velocity, cutoff, voices }: VoiceOptions,
): void {
  const decay = 0.24;
  const f1 = ctx.createBiquadFilter();
  f1.type = 'bandpass';
  f1.Q.value = 5.5;
  const low = clamp(cutoff * 0.35, 180, 3000);
  f1.frequency.setValueAtTime(low, when);
  f1.frequency.exponentialRampToValueAtTime(clamp(low * 4, 300, 6000), when + decay * 0.45);
  const f2 = ctx.createBiquadFilter();
  f2.type = 'bandpass';
  f2.Q.value = 7;
  const high = clamp(cutoff * 1.5, 400, 6000);
  f2.frequency.setValueAtTime(clamp(high * 2.2, 500, 8000), when);
  f2.frequency.exponentialRampToValueAtTime(clamp(high * 0.7, 300, 5000), when + decay);

  const gain = envelope(ctx, velocity * 0.3, when, decay, 0.006);
  f1.connect(f2).connect(gain).connect(out);

  for (const note of notes) {
    const hz = midiToHz(note);
    for (let v = 0; v < Math.max(1, voices); v++) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = hz * (1 + (v - (voices - 1) / 2) * 0.009);
      osc.connect(f1);
      osc.start(when);
      osc.stop(when + decay + 0.08);
    }
  }
}

/** One note of the high line: short, square, dark. */
export function arp(
  ctx: BaseAudioContext,
  out: AudioNode,
  when: number,
  hz: number,
  { velocity, cutoff }: VoiceOptions,
): void {
  const decay = 0.085;
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.value = clamp(hz, 20, 12000);
  const filter = filterSweep(ctx, clamp(cutoff * 1.5, 300, 16000), clamp(cutoff * 0.5, 200, 12000), when, decay, 9);
  const gain = envelope(ctx, velocity * 0.13, when, decay, 0.002);
  osc.connect(filter).connect(gain).connect(out);
  osc.start(when);
  osc.stop(when + decay + 0.05);
}

/**
 * The pad: sustained detuned saws under everything, low and dark, so it carries
 * a whole passage and the change is a cross-fade rather than an event. This is
 * the one voice that is allowed to be long, and it is long because the
 * reference's breakdowns are built on a held chord.
 */
export function pad(
  ctx: BaseAudioContext,
  out: AudioNode,
  when: number,
  notes: number[],
  hold: number,
  { velocity, cutoff, voices }: VoiceOptions,
): void {
  const attack = Math.min(2.5, Math.max(0.4, hold * 0.3));
  const release = Math.min(3.5, Math.max(0.6, hold * 0.35));
  const total = attack + hold + release;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 1.2;
  filter.frequency.setValueAtTime(clamp(cutoff * 0.5, 150, 9000), when);
  filter.frequency.linearRampToValueAtTime(clamp(cutoff, 150, 9000), when + attack + hold * 0.5);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(Math.max(EPS, velocity * 0.12), when + attack);
  gain.gain.setValueAtTime(Math.max(EPS, velocity * 0.12), when + attack + hold);
  gain.gain.linearRampToValueAtTime(0, when + total);
  filter.connect(gain).connect(out);

  for (const note of notes) {
    for (let v = 0; v < Math.max(1, voices); v++) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = midiToHz(note) * (1 + (v - (voices - 1) / 2) * 0.007);
      osc.connect(filter);
      osc.start(when);
      osc.stop(when + total + 0.05);
    }
  }
}

// --- the transitions -------------------------------------------------------

/** The riser: band-passed noise and a saw, both climbing, for the two bars
 *  before a drop. The two of them arriving together is what makes it read as
 *  one thing getting louder rather than two things getting louder. */
export function riser(
  ctx: BaseAudioContext,
  out: AudioNode,
  noise: AudioBuffer,
  when: number,
  { duration, from, to, velocity, pan, note, cutoff, voices }: VoiceOptions & {
    duration: number;
    from: number;
    to: number;
    pan: number;
    note: number;
  },
): void {
  const panner = ctx.createStereoPanner();
  panner.pan.value = clamp(pan, -1, 1);
  panner.connect(out);

  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = 1.6;
  band.frequency.setValueAtTime(clamp(cutoff * 0.4 * from, 80, 16000), when);
  band.frequency.exponentialRampToValueAtTime(clamp(cutoff * 0.4 * to, 80, 18000), when + duration);
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.001, when);
  noiseGain.gain.exponentialRampToValueAtTime(Math.max(EPS, velocity * 0.5), when + duration * 0.92);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
  src.connect(band).connect(noiseGain).connect(panner);
  src.start(when);
  src.stop(when + duration + 0.1);

  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(clamp(midiToHz(note) * from, 20, 8000), when);
  osc.frequency.exponentialRampToValueAtTime(clamp(midiToHz(note) * to, 20, 12000), when + duration);
  const oscGain = ctx.createGain();
  oscGain.gain.setValueAtTime(0.001, when);
  oscGain.gain.exponentialRampToValueAtTime(Math.max(EPS, velocity * 0.22), when + duration * 0.9);
  oscGain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
  osc.connect(oscGain).connect(panner);
  osc.start(when);
  osc.stop(when + duration + 0.1);
  void voices;
}

/** The siren: one pitched sweep inside a long passage, the way a DJ drops a
 *  vocal. Never twice in the same place. */
export function siren(
  ctx: BaseAudioContext,
  out: AudioNode,
  when: number,
  { duration, from, to, velocity, pan, note, cutoff }: VoiceOptions & {
    duration: number;
    from: number;
    to: number;
    pan: number;
    note: number;
  },
): void {
  const panner = ctx.createStereoPanner();
  panner.pan.value = clamp(pan, -1, 1);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = clamp(cutoff * 0.7, 200, 12000);
  filter.Q.value = 3;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.001, when);
  gain.gain.linearRampToValueAtTime(Math.max(EPS, velocity * 0.3), when + duration * 0.2);
  gain.gain.setValueAtTime(Math.max(EPS, velocity * 0.3), when + duration * 0.6);
  gain.gain.linearRampToValueAtTime(0.0001, when + duration);
  filter.connect(gain).connect(panner).connect(out);
  for (let v = 0; v < 3; v++) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const hz = midiToHz(note) * (1 + (v - 1) * 0.008);
    osc.frequency.setValueAtTime(clamp(hz * from, 20, 8000), when);
    osc.frequency.exponentialRampToValueAtTime(clamp(hz * to, 20, 12000), when + duration);
    osc.connect(filter);
    osc.start(when);
    osc.stop(when + duration + 0.1);
  }
}

/** The impact on a drop: a sub hit with a noise transient, which is what the
 *  reference's loudest passages are built on. */
export function impact(
  ctx: BaseAudioContext,
  out: AudioNode,
  noise: AudioBuffer,
  when: number,
  { duration, velocity, note }: VoiceOptions & { duration: number; note: number },
): void {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(clamp(midiToHz(note) * 2.2, 20, 400), when);
  osc.frequency.exponentialRampToValueAtTime(clamp(midiToHz(note), 20, 400), when + duration * 0.5);
  const gain = envelope(ctx, velocity * 0.6, when, duration, 0.003);
  osc.connect(gain).connect(out);
  osc.start(when);
  osc.stop(when + duration + 0.1);

  const src = ctx.createBufferSource();
  src.buffer = noise;
  const low = ctx.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.value = 900;
  const nGain = envelope(ctx, velocity * 0.4, when, duration * 0.4, 0.001);
  src.connect(low).connect(nGain).connect(out);
  src.start(when, 0.5);
  src.stop(when + duration + 0.1);
}

/** The crash. Sparse on the reference, so this one is short and dark. */
export function crash(
  ctx: BaseAudioContext,
  out: AudioNode,
  noise: AudioBuffer,
  when: number,
  { duration, velocity, pan }: VoiceOptions & { duration: number; pan: number },
): void {
  const panner = ctx.createStereoPanner();
  panner.pan.value = clamp(pan, -1, 1);
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = 1.3;
  // A high-pass, because the reference has almost nothing above 8 kHz and a
  // full-spectrum crash would be the one sound on the record that is not in it.
  const high = ctx.createBiquadFilter();
  high.type = 'highpass';
  high.frequency.value = 3500;
  const gain = envelope(ctx, velocity * 0.3, when, duration, 0.002);
  src.connect(high).connect(gain).connect(panner).connect(out);
  src.start(when, 0.6);
  src.stop(when + duration + 0.1);
}

/** A filter sweep, for a breakdown that wants to move without drums. */
export function sweep(
  ctx: BaseAudioContext,
  out: AudioNode,
  noise: AudioBuffer,
  when: number,
  { duration, from, to, velocity, pan, cutoff }: VoiceOptions & {
    duration: number;
    from: number;
    to: number;
    pan: number;
  },
): void {
  const panner = ctx.createStereoPanner();
  panner.pan.value = clamp(pan, -1, 1);
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = 4;
  band.frequency.setValueAtTime(clamp(cutoff * from * 0.2, 80, 16000), when);
  band.frequency.exponentialRampToValueAtTime(clamp(cutoff * to * 0.2, 80, 16000), when + duration);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.001, when);
  gain.gain.linearRampToValueAtTime(Math.max(EPS, velocity * 0.4), when + duration * 0.7);
  gain.gain.linearRampToValueAtTime(0.0001, when + duration);
  src.connect(band).connect(gain).connect(panner).connect(out);
  src.start(when);
  src.stop(when + duration + 0.1);
}

/**
 * The zap: electro's own transition, a short downward sweep on a bass note.
 * It is the sound a bass synth makes when the filter closes on it, and it is
 * what a lot of electro records use instead of a crash.
 */
export function zap(
  ctx: BaseAudioContext,
  out: AudioNode,
  when: number,
  { duration, from, to, velocity, pan, note }: VoiceOptions & {
    duration: number;
    from: number;
    to: number;
    pan: number;
    note: number;
  },
): void {
  const panner = ctx.createStereoPanner();
  panner.pan.value = clamp(pan, -1, 1);
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.setValueAtTime(clamp(midiToHz(note) * from, 20, 8000), when);
  osc.frequency.exponentialRampToValueAtTime(clamp(midiToHz(note) * to, 20, 8000), when + duration);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(clamp(from * 900, 200, 16000), when);
  filter.frequency.exponentialRampToValueAtTime(220, when + duration);
  const gain = envelope(ctx, velocity * 0.3, when, duration, 0.002);
  osc.connect(filter).connect(gain).connect(panner).connect(out);
  osc.start(when);
  osc.stop(when + duration + 0.06);
}

/** Play one conductor event. */
export function playEvent(
  ctx: BaseAudioContext,
  out: AudioNode,
  noise: AudioBuffer,
  when: number,
  event: PieceEvent,
  { cutoff, voices }: { cutoff: number; voices: number },
): void {
  const options: VoiceOptions & { duration: number; from: number; to: number; note: number } = {
    velocity: event.params.level,
    cutoff,
    voices,
    duration: event.params.duration,
    from: event.params.from,
    to: event.params.to,
    note: event.params.note,
  };
  switch (event.type) {
    case 'riser':
      riser(ctx, out, noise, when, { ...options, pan: event.params.pan });
      break;
    case 'siren':
      siren(ctx, out, when, { ...options, pan: event.params.pan });
      break;
    case 'impact':
      impact(ctx, out, noise, when, options);
      break;
    case 'crash':
      crash(ctx, out, noise, when, { ...options, pan: event.params.pan });
      break;
    case 'sweep':
      sweep(ctx, out, noise, when, { ...options, pan: event.params.pan });
      break;
    case 'zap':
      zap(ctx, out, when, { ...options, pan: event.params.pan });
      break;
    default:
      break;
  }
}
