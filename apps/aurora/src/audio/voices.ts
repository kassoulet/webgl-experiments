// Aurora voices: synth-pop sounds.

// DOM audio node types come from the compiler's DOM lib, not the shared
// package (which is environment-agnostic).

import type { AuroraSection } from '../types.ts';
import type { Instrument } from '../patterns.ts';

export type { Instrument };

export interface Voice {
  free: boolean;
  play: (when: number, freq: number, level: number, section: AuroraSection, barSeconds: number) => void;
}

interface VoicePool {
  ctx: BaseAudioContext;
  master: GainNode;
  sidechain: GainNode;
  noise: AudioBuffer;
  saturation: Float32Array<ArrayBuffer>;
  maxVoices: number;
}

export function create(
  inst: Instrument,
  ctx: BaseAudioContext,
  master: GainNode,
  sidechain: GainNode,
  noise: AudioBuffer,
  saturation: Float32Array<ArrayBuffer>,
  maxVoices: number,
): Voice[] {
  const pool: VoicePool = { ctx, master, sidechain, noise, saturation, maxVoices };
  const voices: Voice[] = [];

  for (let i = 0; i < maxVoices; i++) {
    voices.push(makeVoice(inst, pool));
  }
  return voices;
}

function makeVoice(inst: Instrument, pool: VoicePool): Voice {
  let free = true;

  return {
    get free() { return free; },
    play(when: number, freq: number, level: number, section: AuroraSection, barSeconds: number) {
      if (!free) return;
      free = false;

      const ctx = pool.ctx;
      const gain = ctx.createGain();
      gain.gain.value = level;
      gain.connect(pool.master);

      // A shared saturator for the driven voices: kick and bass through the
      // tanh curve keeps them from scrubbing when the section pushes level.
      const shaper = inst === 'kick' || inst === 'bass' ? ctx.createWaveShaper() : null;
      if (shaper) {
        shaper.curve = pool.saturation;
        shaper.oversample = '2x';
        shaper.connect(gain);
      }
      const tail: AudioNode = shaper ?? gain;

      let osc: OscillatorNode | null = null;
      let noiseSrc: AudioBufferSourceNode | null = null;
      let filter: BiquadFilterNode | null = null;

      try {
        switch (inst) {
          case 'kick': {
            osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(150, when);
            osc.frequency.exponentialRampToValueAtTime(40, when + 0.4);
            osc.connect(tail);
            gain.gain.setValueAtTime(1, when);
            gain.gain.exponentialRampToValueAtTime(0.001, when + 0.5);
            osc.start(when);
            osc.stop(when + 0.6);
            break;
          }
          case 'bass': {
            osc = ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.value = freq;
            filter = ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = section.cutoff;
            filter.Q.value = 2;
            osc.connect(filter).connect(tail);
            gain.gain.setValueAtTime(0.6, when);
            gain.gain.exponentialRampToValueAtTime(0.001, when + barSeconds * 0.8);
            osc.start(when);
            osc.stop(when + barSeconds);
            break;
          }
          case 'pad': {
            osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.value = freq;
            filter = ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = section.cutoff * 0.5;
            osc.connect(filter).connect(gain);
            gain.gain.setValueAtTime(0.3, when);
            gain.gain.exponentialRampToValueAtTime(0.001, when + barSeconds * 4);
            osc.start(when);
            osc.stop(when + barSeconds * 4);
            break;
          }
          case 'arp': {
            osc = ctx.createOscillator();
            osc.type = 'triangle';
            osc.frequency.value = freq;
            filter = ctx.createBiquadFilter();
            filter.type = 'bandpass';
            filter.frequency.value = section.cutoff;
            filter.Q.value = 5;
            osc.connect(filter).connect(gain);
            gain.gain.setValueAtTime(0.4, when);
            gain.gain.exponentialRampToValueAtTime(0.001, when + 0.3);
            osc.start(when);
            osc.stop(when + 0.4);
            break;
          }
          case 'stab': {
            osc = ctx.createOscillator();
            osc.type = 'square';
            osc.frequency.value = freq;
            filter = ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = section.cutoff;
            filter.Q.value = 3;
            osc.connect(filter).connect(gain);
            gain.gain.setValueAtTime(0.5, when);
            gain.gain.exponentialRampToValueAtTime(0.001, when + 0.2);
            osc.start(when);
            osc.stop(when + 0.3);
            break;
          }
          default: {
            // hat, clap, perc, fx - noise based
            noiseSrc = ctx.createBufferSource();
            noiseSrc.buffer = pool.noise;
            filter = ctx.createBiquadFilter();
            filter.type = inst === 'hat' ? 'highpass' : 'bandpass';
            filter.frequency.value = inst === 'hat' ? 8000 : inst === 'clap' ? 2000 : 4000;
            filter.Q.value = inst === 'hat' ? 1 : 3;
            noiseSrc.connect(filter).connect(gain);
            gain.gain.setValueAtTime(0.5, when);
            gain.gain.exponentialRampToValueAtTime(0.001, when + 0.15);
            noiseSrc.start(when);
            noiseSrc.stop(when + 0.2);
            break;
          }
        }

        const cleanup = () => {
          free = true;
          try { osc?.disconnect(); } catch {}
          try { noiseSrc?.disconnect(); } catch {}
          try { filter?.disconnect(); } catch {}
          try { shaper?.disconnect(); } catch {}
          try { gain.disconnect(); } catch {}
        };

        const end = when + (inst === 'pad' ? barSeconds * 4 : inst === 'bass' ? barSeconds : 0.5);
        setTimeout(cleanup, (end - ctx.currentTime) * 1000 + 100);
      } catch {
        free = true;
      }
    },
  };
}