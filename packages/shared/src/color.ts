// Shared color utilities for palettes.

import type { RGB, Palette } from './types.ts';

/** sRGB -> linear. The shader works in linear light. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function toLinear(rgb: RGB | readonly number[]): RGB {
  return [srgbToLinear(rgb[0] ?? 0), srgbToLinear(rgb[1] ?? 0), srgbToLinear(rgb[2] ?? 0)];
}

/** Hex string to linear RGB. */
export function hexToLinear(hex: string): RGB {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return toLinear([
    ((n >> 16) & 255) / 255,
    ((n >> 8) & 255) / 255,
    (n & 255) / 255,
  ]);
}

/** Smoothstep for smooth interpolation. */
export function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** Linear interpolation between two RGB values. */
export function lerp3(a: RGB, b: RGB, t: number): RGB {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/** Mix two palettes. */
export function mixPalette(a: Palette, b: Palette, t: number): Palette {
  return {
    name: t < 0.5 ? a.name : b.name,
    deep: lerp3(a.deep, b.deep, t),
    mid: lerp3(a.mid, b.mid, t),
    hot: lerp3(a.hot, b.hot, t),
    accent: lerp3(a.accent, b.accent, t),
  };
}