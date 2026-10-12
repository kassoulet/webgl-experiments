// Base Conductor utilities: shared functions for the arrangement both the audio
// and the picture read. Apps extend with their specific logic.

import { Rng } from './rng.ts';
import { fbm1, wander } from './noise.ts';
import type {
  Chord,
  ChordAt,
  ChordEntry,
  ConductorState,
  DescribedPiece,
  Drift,
  EventParams,
  EventType,
  FlashMode,
  ForcedSection,
  GridPosition,
  Key,
  Levels,
  Palette,
  PieceEvent,
  Section,
  SectionAt,
  SectionBlend,
  SectionEntry,
  SectionLevels,
  SectionName,
  SectionVisuals,
  Seed,
} from './types.ts';

/** Drop every entry at or after `t`. The lists this is used on are in
 *  increasing time order, so what goes is the tail. */
export function dropFrom<T extends { t: number }>(list: T[], t: number): void {
  let keep = list.length;
  while (keep > 0 && (list[keep - 1] as T).t >= t) keep--;
  list.length = keep;
}

/** The epsilon used in gridAt to keep bar arithmetic exact. */
export const GRID_EPSILON = 1e-7;

/** Find the cursor position in a time-ordered list. */
export function cursorFor<T extends { t: number }>(list: readonly T[], cursor: number, t: number): number {
  let i = Math.min(Math.max(cursor, 0), list.length - 1);
  while (i + 1 < list.length && (list[i + 1] as T).t <= t) i++;
  while (i > 0 && (list[i] as T).t > t) i--;
  return i;
}

/** Default drift function using shared noise. */
export function defaultDrift(t: number, noiseSeed: number): Drift {
  const n = noiseSeed;
  return {
    spin: wander(t, 46, 0.09, 0.14, n + 11, 2),
    warp: wander(t, 33, 1, 0.45, n + 23),
    zoom: wander(t, 71, 0.06, 0.05, n + 31),
    breathe: wander(t, 12, 1, 0.06, n + 47),
    hue: fbm1(t / 190, 3, n + 53),
    glow: wander(t, 58, 0.6, 0.3, n + 61),
  };
}

/** Default pulse calculation. */
export function defaultPulseAt(
  t: number,
  flash: FlashMode,
  blend: SectionBlend,
  grid: GridPosition,
): number {
  const envelope = Math.exp(-grid.beatPhase * 5.5);
  const backbeat = grid.beat % 2 === 1 ? 0.55 : 1;
  const FLASH_DEPTH: Record<FlashMode, number> = { soft: 0.22, full: 1.0 };
  return Math.min(1, envelope * backbeat * blend.flash * FLASH_DEPTH[flash]);
}

/** Default gridAt calculation. */
export function defaultGridAt(t: number, sectionAt: SectionAt): GridPosition {
  const entry = sectionAt.entry;
  const within = Math.max(0, t - entry.t);
  const barSeconds = entry.barSeconds;
  const beatSeconds = barSeconds / 4;
  const stepSeconds = beatSeconds / 4;
  const bars = within / barSeconds;
  const beats = within / beatSeconds;
  const barPhase = bars % 1;
  const beatPhase = beats % 1;
  return {
    bar: entry.bar + Math.floor(bars + GRID_EPSILON),
    beat: ((Math.floor(beats + GRID_EPSILON) % 4) + 4) % 4,
    beatPhase,
    barPhase,
    stepPhase: (within / stepSeconds) % 1,
    barSeconds,
    bpm: entry.bpm,
  };
}

/** Default sectionBlend calculation. */
export interface SectionBlendOptions {
  sectionAt: SectionAt;
  sectionFade: number;
  visualKeys: (keyof SectionVisuals)[];
  getSectionSaturation: (name: string) => number;
}

export function defaultSectionBlend(opts: SectionBlendOptions): SectionBlend {
  const { sectionAt, sectionFade, visualKeys, getSectionSaturation } = opts;
  const at = sectionAt;
  const fade = Math.min(1, Math.max(0, (at.sectionTime) / sectionFade));
  const f = fade * fade * (3 - 2 * fade);
  const pick = (key: keyof SectionLevels): number => {
    const from = at.entry.previous[key] as number;
    const to = at.entry.section[key] as number;
    return from + (to - from) * f;
  };
  const levels: SectionLevels = {} as SectionLevels;
  for (const key of Object.keys(at.entry.section) as (keyof SectionLevels)[]) {
    const val = at.entry.section[key];
    if (typeof val === 'number') levels[key] = pick(key);
  }
  const visualMix: SectionVisuals = {} as SectionVisuals;
  for (const key of visualKeys) {
    const from = at.entry.previous.visuals[key] as number;
    const to = at.entry.section.visuals[key] as number;
    visualMix[key] = from + (to - from) * f;
  }
  return {
    section: at.entry.section,
    previous: at.entry.previous,
    fade: f,
    levels,
    visualMix,
    cutoff: at.entry.previous.cutoff + (at.entry.section.cutoff - at.entry.previous.cutoff) * f,
    flash: at.entry.previous.flash + (at.entry.section.flash - at.entry.previous.flash) * f,
    saturation: getSectionSaturation(at.entry.section.name),
  };
}

/** Default forceNextSection implementation. */
export interface ForceNextSectionOptions {
  sectionAt: (t: number) => SectionAt;
  pushSection: (t: number) => void;
  sections: SectionEntry[];
  chords: ChordEntry[];
  events: PieceEvent[];
  sectionCursor: number;
  chordCursor: number;
  scheduled: number;
  minLead: number;
  sectionFade: number;
}

export function defaultForceNextSection(
  t: number,
  opts: ForceNextSectionOptions,
): ForcedSection {
  opts.sectionAt(t);
  const from = opts.sectionAt(t);
  const entry = from.entry;
  const barsIn = (t - entry.t) / entry.barSeconds;
  let earliest = entry.bar + Math.floor(barsIn + 1e-9) + 1;
  while (entry.t + (earliest - entry.bar) * entry.barSeconds - t < opts.minLead) earliest++;
  const cutBar = Math.ceil(earliest / 4) * 4;
  const at = entry.t + (cutBar - entry.bar) * entry.barSeconds;

  entry.bars = cutBar - entry.bar;
  entry.hold = at - entry.t;

  opts.sections.length = from.index + 1;
  dropFrom(opts.events, at);
  dropFrom(opts.chords, at);
  opts.sectionCursor = Math.min(opts.sectionCursor, from.index);
  opts.chordCursor = Math.min(opts.chordCursor, Math.max(0, opts.chords.length - 1));
  opts.scheduled = at;

  opts.pushSection(at);
  opts.scheduled = at;
  opts.events.sort((a, b) => a.t - b.t);
  const pushed = opts.sections[from.index + 1] as SectionEntry;
  return { name: pushed.section.name, at: pushed.t, bar: pushed.bar, lead: pushed.t - t };
}

/** Default describe implementation. */
export function defaultDescribe(state: ConductorState): DescribedPiece {
  return {
    key: state.keyName,
    chord: state.chord.name,
    next: state.nextChord.name,
    section: state.sectionName,
    bpm: Math.round(state.grid.bpm),
    bar: state.grid.bar,
    palette: state.palette.name,
  };
}