// The palette, measured rather than chosen.
//
// Every colour here comes from sampling the reference video: 40 frames across
// four minutes, each reduced to a 64x22 grid, and the pixels counted. The
// result was 64.9% pure black, and what was left is a narrow run — a cool
// branch climbing through indigo to an electric blue-violet, and a warm branch
// climbing through maroon to a dull red. Nothing in the reference is bright,
// and nothing in it is neutral. That is the whole palette.
//
// `void` is a colour here rather than a placeholder. On this material the
// background is two thirds of the picture, and a shader that treats black as
// "nothing" leaves two thirds of the frame doing nothing at all.

import type { Chord, Palette, RGB, SectionName } from './types.ts';

function rgb(r: number, g: number, b: number): RGB {
  return { r, g, b };
}

/**
 * The measured runs, as anchors. `hot` is the brightest colour the reference
 * actually reaches — #4924b6 and #6d2424 — and the shader is allowed to push
 * past it for the scope's core, but the *field* stays inside these.
 */
const RUNS: { name: string; deep: RGB; mid: RGB; hot: RGB; accent: RGB }[] = [
  {
    // The dominant run: black, indigo, electric violet.
    name: 'Cathode',
    deep: rgb(10, 10, 36),
    mid: rgb(36, 36, 109),
    hot: rgb(73, 36, 182),
    accent: rgb(109, 36, 36),
  },
  {
    // Deeper and bluer, the branch that dominates the first half.
    name: 'Indigo',
    deep: rgb(8, 8, 30),
    mid: rgb(30, 32, 86),
    hot: rgb(60, 48, 150),
    accent: rgb(96, 32, 48),
  },
  {
    // The warm run: maroon into red, which the reference reaches around its
    // loudest passages.
    name: 'Ember',
    deep: rgb(30, 8, 10),
    mid: rgb(84, 30, 34),
    hot: rgb(140, 48, 48),
    accent: rgb(48, 36, 140),
  },
  {
    // Violet, the one that leans furthest from the reference's blue.
    name: 'Ultraviolet',
    deep: rgb(16, 8, 36),
    mid: rgb(58, 30, 110),
    hot: rgb(104, 52, 168),
    accent: rgb(120, 40, 40),
  },
  {
    // Almost monochrome: the reference's greys with a cold cast.
    name: 'Tapehead',
    deep: rgb(20, 20, 24),
    mid: rgb(58, 58, 66),
    hot: rgb(112, 112, 124),
    accent: rgb(40, 44, 96),
  },
  {
    // The deepest blue, for the breakdowns, where the reference is darkest.
    name: 'Coldframe',
    deep: rgb(4, 6, 22),
    mid: rgb(20, 26, 64),
    hot: rgb(44, 60, 128),
    accent: rgb(72, 28, 40),
  },
];

const BY_NAME = new Map(RUNS.map((p) => [p.name, p]));

/** How colourful each passage is allowed to be. A breakdown in this material is
 *  a nearly black frame with a trace on it. */
export const SECTION_SATURATION: Record<SectionName, number> = {
  intro: 0.55,
  build: 0.75,
  groove: 0.85,
  drop: 1.0,
  break: 0.6,
  peak: 1.0,
};

/** How many of the runs this seed may use. A set that cycles all six reads as a
 *  filter being turned; a set that uses two reads as a record. */
export const PALETTE_COUNT = 4;

function mix(a: RGB, b: RGB, t: number): RGB {
  return rgb(
    Math.round(a.r + (b.r - a.r) * t),
    Math.round(a.g + (a.g === b.g ? 0 : (b.g - a.g) * t)),
    Math.round(a.b + (b.b - a.b) * t),
  );
}

/**
 * The palette for a moment, from the chord underneath it.
 *
 * The warm and cool branches alternate with the harmony, which is the one
 * place the picture is allowed to be a function of the music beyond the scope
 * itself: a bass line that moves to a different chord changes the colour of
 * the room. `progress` crossfades towards the *next* chord's branch over the
 * chord's length, so the change is a slide rather than a cut.
 */
export function paletteAt({
  chord,
  nextChord,
  progress,
  saturation,
  index = 0,
}: {
  chord: Chord;
  nextChord: Chord;
  progress: number;
  saturation: number;
  index?: number;
}): Palette {
  const count = Math.max(1, Math.min(PALETTE_COUNT, RUNS.length));
  const now = RUNS[((index % count) + count) % count] as (typeof RUNS)[number];
  const ahead = RUNS[((index + 1) % count) as number] as (typeof RUNS)[number];
  const t = Math.min(1, Math.max(0, progress));

  // A chord whose root is a third or more above the last one is the warm
  // branch; below, the cool one. The reference moves between them exactly
  // where the harmony does.
  const lift = nextChord.bassPc - chord.bassPc;
  const warm = lift > 2 || lift < -9;
  const target = warm ? ahead : now;

  const sat = Math.min(1.15, Math.max(0, saturation));
  return {
    name: target.name,
    void: rgb(0, 0, 0),
    deep: mix(now.deep, target.deep, t),
    mid: mix(mix(now.mid, target.mid, t), now.deep, (1 - sat) * 0.55),
    hot: mix(mix(now.hot, target.hot, t), now.mid, (1 - sat) * 0.35),
    accent: mix(now.accent, target.accent, t),
  };
}

/** The run names, for the HUD and for the tests. */
export function paletteNames(): string[] {
  return RUNS.map((p) => p.name);
}

/** One run by name, for the tests. */
export function paletteByName(name: string): Palette | null {
  const found = BY_NAME.get(name);
  if (!found) return null;
  return {
    name: found.name,
    void: rgb(0, 0, 0),
    deep: found.deep,
    mid: found.mid,
    hot: found.hot,
    accent: found.accent,
  };
}

/** Linear blend between two palettes, for a passage change that should not cut. */
export function blendPalettes(a: Palette, b: Palette, t: number): Palette {
  const k = Math.min(1, Math.max(0, t));
  return {
    name: k < 0.5 ? a.name : b.name,
    void: mix(a.void, b.void, k),
    deep: mix(a.deep, b.deep, k),
    mid: mix(a.mid, b.mid, k),
    hot: mix(a.hot, b.hot, k),
    accent: mix(a.accent, b.accent, k),
  };
}
