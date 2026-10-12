// Device profile for Aurora.

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
    padLayers: mobile ? 1 : 2,
    grainScale: mobile ? 0.4 : 1,
    maxGrains: mobile ? 12 : 28,
    reverbSeconds: mobile ? 4 : 8,
    synthVoices: mobile ? 0.5 : 1,
    visual: {
      scale: mobile ? 0.55 : 0.85,
      steps: mobile ? 48 : 96,
      volumetric: !mobile,
      stars: mobile ? 2 : 3,
    },
  };
}

export function visualSettings(profile: Profile, quality: Quality): VisualSettings {
  const base = profile.visual;
  switch (quality) {
    case 'low':
      return { ...base, scale: Math.min(base.scale, 0.55), steps: 40, volumetric: false, stars: 1 };
    case 'high':
      return { ...base, scale: 1, steps: 120, volumetric: true, stars: 4 };
    default:
      return { ...base };
  }
}

export const DEFAULT_FLASH_MODE: FlashMode = 'soft';

export const FLASH_DEPTH: Record<FlashMode, number> = {
  soft: 0.15,
  full: 1.0,
};