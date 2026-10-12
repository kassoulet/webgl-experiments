// Device profile (spec §5 "Mobile: fewer voices there", and §5's frame-rate
// targets). One place decides how much of the set a device is asked to carry.

import type { FlashMode, Profile, Quality, VisualSettings } from './types.ts';

interface NavigatorHints {
  hardwareConcurrency?: number;
  deviceMemory?: number;
  maxTouchPoints?: number;
}

export function detectProfile(
  nav: NavigatorHints | undefined = globalThis.navigator as NavigatorHints | undefined,
  win: Window & typeof globalThis = globalThis as Window & typeof globalThis,
): Profile {
  const coarse = typeof win.matchMedia === 'function' ? win.matchMedia('(pointer: coarse)').matches : false;
  const cores = nav?.hardwareConcurrency ?? 4;
  const memory = nav?.deviceMemory ?? 4;
  const mobile = coarse && (cores <= 8 || memory <= 4);
  const touch = coarse || (nav?.maxTouchPoints ?? 0) > 0;

  return {
    name: mobile ? 'mobile' : 'desktop',
    touch,
    cores,
    /** Detuned voices per synth hit: CPU, not taste. */
    synthVoices: mobile ? 1 : 3,
    reverbSeconds: mobile ? 2.5 : 5,
    /** A starting guess for the picture; the renderer still measures and adjusts. */
    visual: {
      scale: mobile ? 0.5 : 0.85,
      // There is no fractal in this picture: the oscilloscope is a line and the
      // colour field is a wash, so the only shader loop is the noise, and the
      // only quality knob is how deep it goes.
      octaves: mobile ? 2 : 3,
      bloom: !mobile,
      // 240 lines is a little under NTSC's 243.5, which is as close to "an old
      // tape" as a number gets.
      scanLines: 240,
    },
  };
}

/** Quality is a user choice over the profile's default. */
export function visualSettings(profile: Profile, quality: Quality): VisualSettings {
  const base = profile.visual;
  switch (quality) {
    case 'low':
      return { ...base, scale: Math.min(base.scale, 0.55), octaves: 1, bloom: false };
    case 'high':
      return { ...base, scale: 1, octaves: 5, bloom: true };
    default:
      return { ...base };
  }
}

/**
 * The flash mode every set starts in: `soft`, the capped pulse. `full` is
 * offered in the HUD as a deliberate opt-in for anyone who wants the strobe,
 * and it is never selected automatically — including on a device that has asked
 * for reduced motion, which is exactly who must not be handed one by default.
 *
 * The cap is low on purpose. This picture is mostly black with a bright trace
 * on it, which is the worst possible combination for photosensitivity: the
 * contrast ratio between "nothing" and "the scope at full" is enormous, so a
 * small multiplicative cap still reads as a hard flash.
 */
export const DEFAULT_FLASH_MODE: FlashMode = 'soft';

export const FLASH_DEPTH: Record<FlashMode, number> = {
  soft: 0.18,
  full: 1.0,
};
