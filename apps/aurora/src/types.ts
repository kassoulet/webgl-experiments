// Aurora-specific types. Shared types are re-exported from @fractal-rave/shared.

import type {
  Chord,
  ChordAt,
  ChordEntry,
  ConductorState,
  DescribedPiece,
  Drift,
  EngineStats as SharedEngineStats,
  EventParams,
  FlashMode,
  ForcedSection,
  GridPosition,
  Key,
  Levels,
  Mode,
  Palette,
  PieceEvent,
  Profile as SharedProfile,
  Quality,
  RGB,
  SectionLevels,
  Seed,
  SleepState,
  Span,
  VisualSettings as SharedVisualSettings,
} from '@fractal-rave/shared';

/** The passage names the arrangement moves between. */
export type SectionName = 'dawn' | 'verse' | 'chorus' | 'bridge' | 'finale';

/** Visual layers: aurora curtains, starfield, glow, particles. */
export interface AuroraSectionVisuals {
  curtains: number;
  stars: number;
  glow: number;
  particles: number;
}

/** Aurora section type with specific visuals. */
export interface AuroraSection {
  name: SectionName;
  bars: Span;
  bpm: Span;
  kick: number;
  bass: number;
  hat: number;
  clap: number;
  perc: number;
  stab: number;
  arp: number;
  pad: number;
  fx: number;
  cutoff: number;
  flash: number;
  visuals: AuroraSectionVisuals;
  next: SectionName[];
  [key: string]: number | Span | SectionName | AuroraSectionVisuals | SectionName[] | string;
}

/** Aurora section entry. */
export interface AuroraSectionEntry {
  t: number;
  bar: number;
  section: AuroraSection;
  previous: AuroraSection;
  hold: number;
  bars: number;
  barSeconds: number;
  bpm: number;
}

/** Aurora event types. */
export type AuroraEventType = 'swell' | 'sparkle' | 'wave' | 'flare' | 'shimmer';

/** Aurora section blend with specific visuals. */
export interface AuroraSectionBlend {
  section: AuroraSection;
  previous: AuroraSection;
  fade: number;
  levels: SectionLevels;
  visualMix: AuroraSectionVisuals;
  cutoff: number;
  flash: number;
  saturation: number;
}

/** Aurora section query result. */
export interface AuroraSectionAt {
  index: number;
  entry: AuroraSectionEntry;
  next: AuroraSectionEntry;
  progress: number;
  sectionTime: number;
}

/** Aurora conductor state with specific types. */
export interface AuroraConductorState {
  t: number;
  seed: Seed;
  key: Key;
  keyName: string;
  chord: Chord;
  nextChord: Chord;
  chordProgress: number;
  section: AuroraSectionBlend;
  sectionName: SectionName;
  sectionProgress: number;
  sectionTime: number;
  grid: GridPosition;
  drift: Drift;
  palette: Palette;
  levels: Levels;
  pulse: number;
  barsToNext: number;
}

/** Aurora engine stats. */
export interface AuroraEngineStats extends SharedEngineStats {
  voices: number;
}

/** Aurora render stats. */
export interface AuroraRenderStats {
  available: boolean;
  scale: number;
  steps: number;
  fps: number;
  layers: [number, number, number, number]; // curtains, stars, glow, particles
  quality: Quality;
  flashMode: FlashMode;
  hdr: boolean;
}

/** Aurora profile with specific visual settings. */
export interface AuroraVisualSettings extends SharedVisualSettings {
  steps: number;
  volumetric: boolean;
  stars: number;
}

export interface AuroraProfile extends Omit<SharedProfile, 'visual'> {
  padLayers: number;
  grainScale: number;
  maxGrains: number;
  reverbSeconds: number;
  visual: AuroraVisualSettings;
}

/** Aurora player stats. */
export interface AuroraPlayerStats {
  started: boolean;
  audioOnly: boolean;
  asleep: boolean;
  clock: number;
  frames: number;
  pulse: number;
  sleep: SleepState;
  audio: AuroraEngineStats;
  render: AuroraRenderStats;
  piece: DescribedPiece;
}

// Type aliases for shared types with Aurora names
export type Profile = AuroraProfile;
export type VisualSettings = AuroraVisualSettings;
export type RenderStats = AuroraRenderStats;
export type EngineStats = AuroraEngineStats;
export type PlayerStats = AuroraPlayerStats;

// Re-export shared types
export type {
  Chord,
  ChordAt,
  ChordEntry,
  ConductorState,
  DescribedPiece,
  Drift,
  EventParams,
  FlashMode,
  ForcedSection,
  GridPosition,
  Key,
  Levels,
  Mode,
  Palette,
  PieceEvent,
  Quality,
  RGB,
  SectionLevels,
  Seed,
  SleepState,
  Span,
};
