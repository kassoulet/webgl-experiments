// Shared device profile detection.

export interface NavigatorHints {
  hardwareConcurrency?: number;
  deviceMemory?: number;
  maxTouchPoints?: number;
}

export interface ProfileBase {
  name: 'mobile' | 'desktop';
  touch: boolean;
  cores: number;
  synthVoices: number;
  reverbSeconds: number;
  visual: Record<string, number | boolean>;
}

export function detectProfileBase(
  nav: NavigatorHints | undefined = typeof navigator !== 'undefined' ? navigator : undefined,
  win: Window & typeof globalThis = typeof window !== 'undefined' ? window : (globalThis as Window & typeof globalThis),
): { mobile: boolean; touch: boolean; cores: number } {
  const coarse = typeof win.matchMedia === 'function' ? win.matchMedia('(pointer: coarse)').matches : false;
  const cores = nav?.hardwareConcurrency ?? 4;
  const memory = nav?.deviceMemory ?? 4;
  const mobile = coarse && (cores <= 8 || memory <= 4);
  const touch = coarse || (nav?.maxTouchPoints ?? 0) > 0;
  return { mobile, touch, cores };
}

export type FlashMode = 'soft' | 'full';

export const DEFAULT_FLASH_MODE: FlashMode = 'soft';

export const FLASH_DEPTH_DEFAULT: Record<FlashMode, number> = {
  soft: 0.22,
  full: 1.0,
};

export type Quality = 'auto' | 'low' | 'high';

export function applyQualitySettings<T extends Record<string, number | boolean>>(
  base: T,
  quality: Quality,
  overrides: Partial<Record<Exclude<Quality, 'auto'>, Partial<T>>> = {}
): T {
  const result = { ...base };
  switch (quality) {
    case 'low':
      return { ...result, ...overrides.low };
    case 'high':
      return { ...result, ...overrides.high };
    default:
      return result;
  }
}