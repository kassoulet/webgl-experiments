// Nebula palettes. Pure: harmony in, three colours out (spec §3 "palettes from
// real emission nebulae (H-alpha red, O-III teal, S-II gold) and a few imaginary
// ones, changing slowly with the music's harmony").
//
// Colours are stored as sRGB hex and handed to the shader as linear RGB, so the
// raymarch's emission and absorption add up in a sensible space.

import type { Chord, Key, Palette, RGB } from './types.ts';

/** Three colours per palette: the floor of the cloud, its body, and its hottest
 *  glowing core. Star tints ride on the same hues. */
export const PALETTES = [
  { name: 'H-alpha Bloom', deep: '#1b0a12', mid: '#7a1f2b', hot: '#ff5a4a' },
  { name: 'O-III Veil', deep: '#04121a', mid: '#0e5a63', hot: '#58e6d9' },
  { name: 'S-II Gold', deep: '#21140a', mid: '#7a5220', hot: '#ffc266' },
  { name: 'Sagittarius Dust', deep: '#150f1e', mid: '#4a3a6e', hot: '#d8a6ff' },
  { name: 'Trapezium Blue', deep: '#050b18', mid: '#1b3a6b', hot: '#8fc4ff' },
  { name: 'Crab Rust', deep: '#170b08', mid: '#6b2f1b', hot: '#ff9b57' },
  { name: 'Veil Green', deep: '#06140e', mid: '#14603c', hot: '#7dffb0' },
  { name: 'Violet Rift', deep: '#0b0416', mid: '#45127a', hot: '#ff4fd0' },
  { name: 'Cold Ember', deep: '#0a0b10', mid: '#2b3050', hot: '#ffd9a0' },
  { name: 'Thin Air', deep: '#07090c', mid: '#39434a', hot: '#cfe6ff' },
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

/** Palette index for the current harmonic state. The key chooses the family;
 *  the degree nudges it, so a progression walks the palette slowly instead of
 *  jumping between unrelated colours. */
export function paletteIndexFor(harmony: Chord | Key | (Key & { degree?: number })): number {
  const degree = 'degree' in harmony ? (harmony.degree ?? 0) : 0;
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
  };
}

/** The palette only ever reads a mood's warmth, so that is all it asks for. */
export type Warmth = { warmth: number };

export interface PaletteQuery {
  chord: Chord | Key;
  nextChord?: Chord | Key;
  progress?: number;
  mood?: Warmth | null;
  previousMood?: Warmth | null;
  moodBlend?: number;
}

/** The palette for a moment: the current chord's palette fading into the next
 *  chord's over the chord's own crossfade, plus a mood's warmth — which fades
 *  too, so nothing in the picture ever steps. */
export function paletteAt({
  chord,
  nextChord,
  progress = 0,
  mood = null,
  previousMood = null,
  moodBlend = 1,
}: PaletteQuery): Palette {
  const from = paletteLinear(paletteIndexFor(chord));
  const to = paletteLinear(paletteIndexFor(nextChord ?? chord));
  const mixed = mixPalette(from, to, smoothstep(progress));
  const warmthPrevious = previousMood?.warmth ?? mood?.warmth ?? 1;
  const warmthNow = mood?.warmth ?? 1;
  const warmth = warmthPrevious + (warmthNow - warmthPrevious) * smoothstep(moodBlend);
  if (warmth !== 1) {
    // Moods push the picture hot or cold without changing the palette family.
    mixed.hot = mixed.hot.map((c) => Math.min(1.6, c * warmth)) as RGB;
    mixed.mid = mixed.mid.map((c) => Math.min(1.4, c * (0.6 + 0.4 * warmth))) as RGB;
  }
  return mixed;
}

/** Kelvin-ish star tint, used by the starfield's per-star colour. */
export function starTint(t: number): RGB {
  const warm = toLinear(hexToRgb('#ffd2a1'));
  const cool = toLinear(hexToRgb('#cfe0ff'));
  return lerp3(cool, warm, Math.min(1, Math.max(0, t)));
}
