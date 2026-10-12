// Psychedelic palettes. Pure: harmony and section in, four colours out (spec §3
// "palettes ... changing with the music"). Colours are stored as sRGB hex and
// handed to the shader as linear RGB, so the shader's mixes and tone mapping
// happen in light rather than in gamma space.

import type { Chord, Key, Palette, RGB, SectionName } from './types.ts';

/**
 * Four colours per palette: the floor of the picture, its body, its hottest
 * highlight, and the accent the kaleidoscope's seams are drawn in. A rave
 * palette needs the fourth colour — a two-colour ramp cannot produce the acid
 * greens and violets a fractal palette lookup is built out of.
 */
export const PALETTES = [
  { name: 'Acid Circuit', deep: '#07090a', mid: '#0f7a2e', hot: '#c8ff3d', accent: '#ff2d95' },
  { name: 'Ultraviolet', deep: '#08040f', mid: '#3a0f7a', hot: '#b07bff', accent: '#28f0d0' },
  { name: 'Magma Floor', deep: '#0c0403', mid: '#7a1c05', hot: '#ffb03d', accent: '#ff3b2f' },
  { name: 'Cyanotype', deep: '#03060d', mid: '#0d3a7a', hot: '#6fd8ff', accent: '#ffe14d' },
  { name: 'Solar Rot', deep: '#0d0704', mid: '#7a5205', hot: '#ffe27a', accent: '#ff5a2f' },
  { name: 'Deep Chlorophyll', deep: '#04100a', mid: '#0b5a3a', hot: '#63ffb0', accent: '#ff6ad5' },
  { name: 'Ink & Magenta', deep: '#06060a', mid: '#161a3a', hot: '#ff4fd0', accent: '#4dfff0' },
  { name: 'Rust Bloom', deep: '#0b0605', mid: '#5c2410', hot: '#ff8a4a', accent: '#8affa0' },
  { name: 'Pistachio', deep: '#080b04', mid: '#3f6a0d', hot: '#dcff6a', accent: '#3b6bff' },
  { name: 'Tidepool', deep: '#020a0c', mid: '#0a5a5c', hot: '#4dffe8', accent: '#ff4d6a' },
  { name: 'Bruise', deep: '#07050c', mid: '#2f1160', hot: '#8f5fff', accent: '#ffd24d' },
  { name: 'Sodium Lamp', deep: '#0a0803', mid: '#6b5a05', hot: '#fff07a', accent: '#3d7bff' },
] as const;

export type PaletteRecipe = (typeof PALETTES)[number];

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** sRGB -> linear. The shader works in linear light. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function toLinear(rgb: RGB | readonly number[]): RGB {
  return [srgbToLinear(rgb[0] ?? 0), srgbToLinear(rgb[1] ?? 0), srgbToLinear(rgb[2] ?? 0)];
}

/**
 * Palette index for the current harmonic state. The key chooses the family and
 * the degree nudges it, so a bass line walking the scale walks the colour wheel
 * with it instead of jumping between unrelated worlds.
 */
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

/**
 * Which way a section pushes the picture. A drop is hotter and more saturated
 * than a breakdown; the change rides the same blend the audio's levels do, so
 * the colour arrives with the kick rather than ahead of it.
 */
export const SECTION_SATURATION: Record<SectionName, number> = {
  intro: 0.72,
  build: 0.95,
  drop: 1.25,
  breakdown: 0.6,
  peak: 1.35,
};

export interface PaletteQuery {
  chord: Chord | Key;
  nextChord?: Chord | Key;
  /** 0..1 through the chord's own span: the crossfade into the next one. */
  progress?: number;
  /**
   * How saturated this moment is, already blended between the two sections by
   * the conductor (spec §5 — the same blend the audio's levels ride). 1 is
   * neutral; a drop asks for more, a breakdown for less.
   */
  saturation?: number;
}

/**
 * The palette for a moment: the current chord's palette fading into the next
 * chord's over the chord's own span, then saturated by the section. Neither
 * blend ever steps, so the colour arrives with the change rather than before it.
 */
export function paletteAt({
  chord,
  nextChord,
  progress = 0,
  saturation = 1,
}: PaletteQuery): Palette {
  const from = paletteLinear(paletteIndexFor(chord));
  const to = paletteLinear(paletteIndexFor(nextChord ?? chord));
  const mixed = mixPalette(from, to, smoothstep(progress));
  const s = Math.min(1.6, Math.max(0.25, saturation));
  mixed.mid = mixed.mid.map((c) => Math.min(1.8, c * (0.65 + 0.35 * s))) as RGB;
  mixed.hot = mixed.hot.map((c) => Math.min(2, c * s)) as RGB;
  mixed.accent = mixed.accent.map((c) => Math.min(1.8, c * (0.7 + 0.3 * s))) as RGB;
  return mixed;
}
