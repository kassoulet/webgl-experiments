// Aurora palettes: synth-pop colors inspired by northern lights.

import type { Chord, Key, Palette, RGB, SectionName } from './types.ts';

/** Four colours per palette: deep sky, aurora green, bright pink/purple, shimmer accent. */
export const PALETTES = [
  { name: 'Borealis', deep: '#040814', mid: '#00b36b', hot: '#00ffe0', accent: '#ff3de0' },
  { name: 'Australis', deep: '#080414', mid: '#6b00b3', hot: '#e000ff', accent: '#3dffb3' },
  { name: 'Midnight Sun', deep: '#140804', mid: '#b36b00', hot: '#ffe000', accent: '#00b3ff' },
  { name: 'Polar Dawn', deep: '#041410', mid: '#006bb3', hot: '#00b3ff', accent: '#ffb300' },
  { name: 'Neon Sky', deep: '#0a0414', mid: '#4d00b3', hot: '#b34dff', accent: '#00ffe0' },
  { name: 'Ice Crystal', deep: '#041414', mid: '#0080b3', hot: '#4dffff', accent: '#ff4db3' },
  { name: 'Green Ray', deep: '#041408', mid: '#1ab300', hot: '#6bff00', accent: '#ff00b3' },
  { name: 'Violet Crown', deep: '#0a0414', mid: '#3300b3', hot: '#804dff', accent: '#00ffb3' },
] as const;

export type PaletteRecipe = (typeof PALETTES)[number];

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function toLinear(rgb: RGB | readonly number[]): RGB {
  return [srgbToLinear(rgb[0] ?? 0), srgbToLinear(rgb[1] ?? 0), srgbToLinear(rgb[2] ?? 0)];
}

export function paletteIndexFor(harmony: Chord | Key): number {
  const degree = 'degree' in harmony ? harmony.degree : 0;
  const family = (harmony.rootPc * 5 + harmony.modeName.length * 3) % PALETTES.length;
  return (family + Math.floor(degree / 2)) % PALETTES.length;
}

const smoothstep = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

function paletteLinear(index: number): Palette {
  const p = PALETTES[((index % PALETTES.length) + PALETTES.length) % PALETTES.length] as PaletteRecipe;
  return {
    name: p.name,
    deep: toLinear(hexToRgb(p.deep)),
    mid: toLinear(hexToRgb(p.mid)),
    hot: toLinear(hexToRgb(p.hot)),
    accent: toLinear(hexToRgb(p.accent)),
  };
}

const lerp3 = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

function mixPalette(a: Palette, b: Palette, t: number): Palette {
  return {
    name: t < 0.5 ? a.name : b.name,
    deep: lerp3(a.deep, b.deep, t),
    mid: lerp3(a.mid, b.mid, t),
    hot: lerp3(a.hot, b.hot, t),
    accent: lerp3(a.accent, b.accent, t),
  };
}

export const SECTION_SATURATION: Record<SectionName, number> = {
  dawn: 0.6,
  verse: 0.85,
  chorus: 1.2,
  bridge: 0.55,
  finale: 1.1,
};

export interface PaletteQuery {
  chord: Chord | Key;
  nextChord?: Chord | Key;
  progress?: number;
  saturation?: number;
}

export function paletteAt({
  chord,
  nextChord,
  progress = 0,
  saturation = 1,
}: PaletteQuery): Palette {
  const from = paletteLinear(paletteIndexFor(chord));
  const to = paletteLinear(paletteIndexFor(nextChord ?? chord));
  const mixed = mixPalette(from, to, smoothstep(progress));
  const s = Math.min(1.5, Math.max(0.3, saturation));
  mixed.mid = mixed.mid.map((c) => Math.min(1.6, c * (0.7 + 0.3 * s))) as RGB;
  mixed.hot = mixed.hot.map((c) => Math.min(1.8, c * s)) as RGB;
  mixed.accent = mixed.accent.map((c) => Math.min(1.7, c * (0.75 + 0.25 * s))) as RGB;
  return mixed;
}