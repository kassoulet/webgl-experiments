// The voices: one function per instrument, each scheduling its own nodes on the
// AudioContext's clock and cleaning them up when they have finished.
//
// Nothing here is triggered by a timer. The engine decides *what* plays and
// *when* — by reading the conductor — and calls in here to make a sound at a
// time the audio thread already knows about. Every oscillator is started and
// every source is stopped: an oscillator that is never started is silence, and
// stopping one that already ended throws.

import { midiToHz } from '../harmony.ts';
import { clamp } from './dsp.ts';
import type { PieceEvent } from '../types.ts';

/** Where a voice's output goes, and how hard it is being pushed. */
export interface VoiceOptions {
  velocity: number;
  /** The master low-pass the section asks for, in Hz. */
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

/** A low-pass whose cutoff falls from `open` to `closed` over the note — the
 *  filter sweep that makes a bass note sound like a bass note. */
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
  filter.frequency.setValueAtTime(clamp(open, 60, 18000), when);
  filter.frequency.exponentialRampToValueAtTime(clamp(closed, 60, 18000), when + decay);
  return filter;
}

/**
 * The kick. A sine whose pitch falls from about three times the note to the note
 * in fifty milliseconds, plus a short noise transient for the click a speaker
 * needs to make it audible at all.
 */
export function kick(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, when: number, { velocity }: VoiceOptions): void {
  const tune = 48;
  const decay = 0.42;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(tune * 3.4, when);
  osc.frequency.exponentialRampToValueAtTime(tune, when + 0.05);
  const gain = envelope(ctx, velocity, when, decay, 0.004);
  osc.connect(gain).connect(out);
  osc.start(when);
  osc.stop(when + decay + 0.05);

  const click = ctx.createBufferSource();
  click.buffer = noise;
  click.playbackRate.value = 1.4;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 1400;
  const clickGain = envelope(ctx, velocity * 0.3, when, 0.02, 0.001);
  click.connect(hp).connect(clickGain).connect(out);
  click.start(when);
  click.stop(when + 0.06);
}

/** The clap: three noise bursts a few milliseconds apart, then a body. The
 *  spacing is the whole trick — one burst is a hat. */
export function clap(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, when: number, { velocity }: VoiceOptions): void {
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 1500;
  band.Q.value = 1.1;
  const body = envelope(ctx, velocity * 0.9, when, 0.16, 0.002);
  band.connect(body).connect(out);

  for (let i = 0; i < 3; i++) {
    const at = when + i * 0.009;
    const burst = ctx.createBufferSource();
    burst.buffer = noise;
    burst.playbackRate.value = 1 + i * 0.05;
    const gain = envelope(ctx, velocity * (i === 2 ? 1 : 0.55), at, i === 2 ? 0.14 : 0.02, 0.001);
    burst.connect(gain).connect(band);
    burst.start(at);
    burst.stop(at + 0.2);
  }
}

/** A hat: high-passed noise. `open` lengthens it into an open hat. */
export function hat(
  ctx: BaseAudioContext,
  out: AudioNode,
  noise: AudioBuffer,
  when: number,
  { velocity, open = false }: VoiceOptions & { open?: boolean },
): void {
  const decay = open ? 0.26 : 0.045;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = open ? 6200 : 7800;
  const peak = ctx.createBiquadFilter();
  peak.type = 'peaking';
  peak.frequency.value = 11000;
  peak.gain.value = 6;
  const gain = envelope(ctx, velocity * (open ? 0.5 : 0.42), when, decay, 0.001);
  hp.connect(peak).connect(gain).connect(out);

  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = open ? 1.1 : 1.6;
  src.connect(hp);
  src.start(when);
  src.stop(when + decay + 0.08);
}

/** A percussion hit: a tuned noise burst. `pitch` places it, so the same voice
 *  covers a rimshot at 900 Hz and a tom at 140. */
export function perc(
  ctx: BaseAudioContext,
  out: AudioNode,
  noise: AudioBuffer,
  when: number,
  { velocity, pitch = 900 }: VoiceOptions & { pitch?: number },
): void {
  const decay = 0.09 + 240 / Math.max(120, pitch);
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = clamp(pitch, 120, 9000);
  band.Q.value = 4;
  const gain = envelope(ctx, velocity * 0.6, when, decay, 0.001);
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = 1.2;
  src.connect(band).connect(gain).connect(out);
  src.start(when);
  src.stop(when + decay + 0.08);

  // The body: a short sine at the same place, which is what a listener hears as
  // "that was a drum" rather than "that was a click".
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(pitch, when);
  osc.frequency.exponentialRampToValueAtTime(clamp(pitch * 0.6, 40, 9000), when + decay);
  const oscGain = envelope(ctx, velocity * 0.35, when, decay, 0.002);
  osc.connect(oscGain).connect(out);
  osc.start(when);
  osc.stop(when + decay + 0.05);
}

/**
 * The bass: a saw and a sine an octave below, through a filter that closes as
 * the note decays. This is the sound a techno kick and bass line is built from,
 * and it is why the two live on separate buses in the engine.
 */
export function bass(
  ctx: BaseAudioContext,
  out: AudioNode,
  when: number,
  hz: number,
  { velocity, cutoff, accent = false }: VoiceOptions & { accent?: boolean },
): void {
  const decay = accent ? 0.17 : 0.11;
  const open = clamp(cutoff * (accent ? 2.4 : 1.7), 120, 16000);
  const closed = clamp(cutoff * (accent ? 0.7 : 0.45), 60, 16000);
  const filter = filterSweep(ctx, open, closed, when, decay, accent ? 9 : 6);
  const gain = envelope(ctx, velocity * 0.5, when, decay, 0.003);
  filter.connect(gain).connect(out);

  // The saw is the note; the sine an octave below is the weight a small
  // speaker cannot reproduce otherwise, and the two together are why the bass
  // sits on its own bus and gets its own level.
  const saw = ctx.createOscillator();
  saw.type = 'sawtooth';
  saw.frequency.value = clamp(hz, 20, 8000);
  saw.connect(filter);
  saw.start(when);
  saw.stop(when + decay + 0.06);

  const sub = ctx.createOscillator();
  sub.type = 'sine';
  sub.frequency.value = clamp(hz / 2, 20, 4000);
  const subGain = envelope(ctx, velocity * 0.45, when, decay * 1.3, 0.004);
  sub.connect(subGain).connect(out);
  sub.start(when);
  sub.stop(when + decay * 1.3 + 0.06);
}

/**
 * A synth stab: detuned saws through a filter that opens and closes again,
 * short enough to be a stab and long enough to be heard as a chord.
 */
export function stab(
  ctx: BaseAudioContext,
  out: AudioNode,
  when: number,
  notes: number[],
  { velocity, cutoff, voices }: VoiceOptions,
): void {
  const decay = 0.22;
  const filter = filterSweep(ctx, clamp(cutoff * 1.6, 200, 16000), clamp(cutoff * 0.5, 200, 16000), when, decay, 8);
  const gain = envelope(ctx, velocity * 0.32, when, decay, 0.004);
  filter.connect(gain).connect(out);

  for (const note of notes) {
    const hz = midiToHz(note);
    for (let v = 0; v < Math.max(1, voices); v++) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = hz * (1 + (v - (voices - 1) / 2) * 0.008);
      osc.connect(filter);
      osc.start(when);
      osc.stop(when + decay + 0.08);
    }
  }
}

/** One note of the arpeggio: a single filtered saw, very short. */
export function arp(
  ctx: BaseAudioContext,
  out: AudioNode,
  when: number,
  hz: number,
  { velocity, cutoff }: VoiceOptions,
): void {
  const decay = 0.09;
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.value = clamp(hz, 20, 12000);
  const filter = filterSweep(ctx, clamp(cutoff * 1.4, 300, 16000), clamp(cutoff * 0.4, 300, 16000), when, decay, 10);
  const gain = envelope(ctx, velocity * 0.16, when, decay, 0.002);
  osc.connect(filter).connect(gain).connect(out);
  osc.start(when);
  osc.stop(when + decay + 0.05);
}

/**
 * The pad: sustained detuned saws under everything, long attack and long
 * release, so it carries a whole section and the change is a cross-fade rather
 * than an event. `hold` is how long it will be given.
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
  filter.Q.value = 1.4;
  filter.frequency.setValueAtTime(clamp(cutoff * 0.6, 200, 12000), when);
  filter.frequency.linearRampToValueAtTime(clamp(cutoff, 200, 12000), when + attack + hold * 0.5);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(Math.max(EPS, velocity * 0.13), when + attack);
  gain.gain.setValueAtTime(Math.max(EPS, velocity * 0.13), when + attack + hold);
  gain.gain.linearRampToValueAtTime(0, when + total);
  filter.connect(gain).connect(out);

  for (const note of notes) {
    for (let v = 0; v < Math.max(1, voices); v++) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = midiToHz(note) * (1 + (v - (voices - 1) / 2) * 0.006);
      osc.connect(filter);
      osc.start(when);
      osc.stop(when + total + 0.05);
    }
  }
}

/** The riser: band-passed noise and a saw, both climbing, for the two bars
 *  before a drop. The two of them arriving together is what makes it read as
 *  one thing getting louder rather than two things getting louder. */
export function riser(
  ctx: BaseAudioContext,
  out: AudioNode,
  noise: AudioBuffer,
  when: number,
  { velocity, duration }: VoiceOptions & { duration: number },
): void {
  const end = when + duration;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = 3.5;
  band.frequency.setValueAtTime(320, when);
  band.frequency.exponentialRampToValueAtTime(9000, end);
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(EPS, when);
  noiseGain.gain.exponentialRampToValueAtTime(Math.max(EPS, velocity * 0.4), end);
  noiseGain.gain.linearRampToValueAtTime(0, end + 0.08);
  band.connect(noiseGain).connect(out);

  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  src.connect(band);
  src.start(when);
  src.stop(end + 0.12);

  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(110, when);
  osc.frequency.exponentialRampToValueAtTime(440, end);
  const oscGain = ctx.createGain();
  oscGain.gain.setValueAtTime(EPS, when);
  oscGain.gain.exponentialRampToValueAtTime(Math.max(EPS, velocity * 0.18), end);
  oscGain.gain.linearRampToValueAtTime(0, end + 0.08);
  osc.connect(oscGain).connect(out);
  osc.start(when);
  osc.stop(end + 0.12);
}

/** The siren: one note bent up or down by a whole interval, with a vibrato
 *  that only opens up towards the end. */
export function siren(
  ctx: BaseAudioContext,
  out: AudioNode,
  when: number,
  { velocity, duration, from, to, note }: VoiceOptions & { duration: number; from: number; to: number; note: number },
): void {
  const end = when + duration;
  const hz = midiToHz(note);
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(hz * clamp(from, 0.25, 4), when);
  osc.frequency.exponentialRampToValueAtTime(hz * clamp(to, 0.25, 4), end);
  const vibrato = ctx.createOscillator();
  vibrato.frequency.value = 5.5;
  const depth = ctx.createGain();
  depth.gain.setValueAtTime(0, when);
  depth.gain.linearRampToValueAtTime(hz * 0.05, end);
  vibrato.connect(depth).connect(osc.frequency);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 5200;
  const gain = envelope(ctx, velocity * 0.3, when, duration, Math.min(0.6, duration * 0.2));
  osc.connect(filter).connect(gain).connect(out);
  vibrato.start(when);
  vibrato.stop(end + 0.2);
  osc.start(when);
  osc.stop(end + 0.2);
}

/** The impact on a drop: a low sine falling into the sub, plus a body of noise. */
export function impact(
  ctx: BaseAudioContext,
  out: AudioNode,
  noise: AudioBuffer,
  when: number,
  { velocity }: VoiceOptions,
): void {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(140, when);
  osc.frequency.exponentialRampToValueAtTime(32, when + 0.7);
  const gain = envelope(ctx, velocity * 0.7, when, 0.9, 0.004);
  osc.connect(gain).connect(out);
  osc.start(when);
  osc.stop(when + 1);

  const body = ctx.createBufferSource();
  body.buffer = noise;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(4000, when);
  lp.frequency.exponentialRampToValueAtTime(200, when + 0.8);
  const bodyGain = envelope(ctx, velocity * 0.45, when, 0.8, 0.002);
  body.connect(lp).connect(bodyGain).connect(out);
  body.start(when);
  body.stop(when + 0.9);
}

/** The crash: bright noise, two seconds, no pitch. */
export function crash(
  ctx: BaseAudioContext,
  out: AudioNode,
  noise: AudioBuffer,
  when: number,
  { velocity }: VoiceOptions,
): void {
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 4200;
  const gain = envelope(ctx, velocity * 0.4, when, 2.1, 0.002);
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = 1.3;
  src.connect(hp).connect(gain).connect(out);
  src.start(when);
  src.stop(when + 2.3);
}

/** The breakdown sweep: noise falling through a band-pass, the sound of a
 *  filter closing as a section ends. */
export function sweep(
  ctx: BaseAudioContext,
  out: AudioNode,
  noise: AudioBuffer,
  when: number,
  { velocity, duration, from, to }: VoiceOptions & { duration: number; from: number; to: number },
): void {
  const end = when + duration;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = 2.2;
  band.frequency.setValueAtTime(clamp(from * 1200, 80, 14000), when);
  band.frequency.exponentialRampToValueAtTime(clamp(to * 1200, 80, 14000), end);
  const peakAt = when + duration * 0.8;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(EPS, when);
  gain.gain.exponentialRampToValueAtTime(Math.max(EPS, velocity * 0.35), peakAt);
  gain.gain.linearRampToValueAtTime(0, end);
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  src.connect(band).connect(gain).connect(out);
  src.start(when);
  src.stop(end + 0.1);
}

/** Play one of the conductor's events (spec §2's "transitions"). */
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
      riser(ctx, out, noise, when, options);
      break;
    case 'siren':
      siren(ctx, out, when, options);
      break;
    case 'impact':
      impact(ctx, out, noise, when, options);
      break;
    case 'crash':
      crash(ctx, out, noise, when, options);
      break;
    case 'sweep':
      sweep(ctx, out, noise, when, options);
      break;
    default:
      break;
  }
}
