// Device profile (spec §4 "Mobile: ... fewer voices there" and §6's frame-rate
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
    reverbSeconds: mobile ? 3.5 : 7,
    /** A starting guess for the picture; the renderer still measures and adjusts. */
    visual: {
      scale: mobile ? 0.5 : 0.85,
      iterations: mobile ? 40 : 88,
      symmetry: mobile ? 6 : 8,
      octaves: mobile ? 3 : 5,
      bloom: !mobile,
    },
  };
}

/** Quality is a user choice over the profile's default (spec §4 "visuals
 *  quality (auto / low / high)"). */
export function visualSettings(profile: Profile, quality: Quality): VisualSettings {
  const base = profile.visual;
  switch (quality) {
    case 'low':
      return { ...base, scale: Math.min(base.scale, 0.55), iterations: 28, octaves: 3, bloom: false };
    case 'high':
      return { ...base, scale: 1, iterations: 120, octaves: 6, bloom: true };
    default:
      return { ...base };
  }
}

/**
 * The flash mode every set starts in (spec §3's photosensitivity rule): `soft`,
 * the capped pulse. `full` is offered in the HUD as a deliberate opt-in for
 * anyone who wants the strobe, and it is never selected automatically —
 * including on a device that has asked for reduced motion, which is exactly who
 * must not be handed one by default.
 */
export const DEFAULT_FLASH_MODE: FlashMode = 'soft';

/** How deep a pulse may go, in `soft` and in `full` (spec §3). A `soft` picture
 *  never gains more than a fifth of its brightness from the kick; a `full` one
 *  is allowed to double it, which is a strobe you can see but not a strobe that
 *  takes the whole screen. */
export const FLASH_DEPTH: Record<FlashMode, number> = {
  soft: 0.22,
  full: 1.0,
};
