// Device profile (spec §4 "Mobile ... the 2D nebula fallback and fewer voices
// there" and §6's frame-rate targets). One place decides how much of the piece
// a device is asked to carry.

import type { Profile, Quality, VisualSettings } from './types.ts';

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
    /** String-machine voices are a desktop luxury (CPU, not size). */
    padLayers: mobile ? 1 : 2,
    /** Grains per second, scaled again by the mood's density. */
    grainScale: mobile ? 0.35 : 1,
    maxGrains: mobile ? 10 : 24,
    reverbSeconds: mobile ? 5 : 9,
    /** A starting guess for the picture; the renderer still measures and adjusts. */
    visual: {
      scale: mobile ? 0.55 : 0.85,
      steps: mobile ? 44 : 92,
      volumetric: !mobile,
      stars: mobile ? 2 : 3,
    },
  };
}

/** Quality is a user choice over the profile's default (spec §4 "visuals
 *  quality (auto / low / high)"). */
export function visualSettings(profile: Profile, quality: Quality): VisualSettings {
  const base = profile.visual;
  switch (quality) {
    case 'low':
      return { ...base, scale: Math.min(base.scale, 0.6), steps: 36, volumetric: false, stars: 2 };
    case 'high':
      return { ...base, scale: 1, steps: 110, volumetric: true, stars: 3 };
    default:
      return { ...base };
  }
}
