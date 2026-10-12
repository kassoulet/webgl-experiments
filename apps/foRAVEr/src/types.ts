// FOraveR-specific types. Shared types are re-exported from @fractal-rave/shared.

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
  Seed,
  SectionLevels,
  SleepState,
  Span,
  VisualSettings as SharedVisualSettings,
} from '@fractal-rave/shared';

/** The four names the arrangement moves between (spec §2). */
export type SectionName = 'intro' | 'build' | 'drop' | 'breakdown' | 'peak';

/** Which visual layers are on the screen: kaleidoscope, plasma, fractal, noise. */
export interface FoRaverSectionVisuals {
  kaleido: number;
  plasma: number;
  fractal: number;
  noise: number;
}

/** FOraveR section type with specific visuals. */
export interface FoRaverSection {
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
  visuals: FoRaverSectionVisuals;
  next: SectionName[];
  [key: string]: number | Span | SectionName | FoRaverSectionVisuals | SectionName[] | string;
}

/** FOraveR section entry. */
export interface FoRaverSectionEntry {
  t: number;
  bar: number;
  section: FoRaverSection;
  previous: FoRaverSection;
  hold: number;
  bars: number;
  barSeconds: number;
  bpm: number;
}

/** FOraveR event types. */
export type FoRaverEventType = 'riser' | 'impact' | 'sweep' | 'siren' | 'crash';

/** FOraveR section blend with specific visuals. */
export interface FoRaverSectionBlend {
  section: FoRaverSection;
  previous: FoRaverSection;
  fade: number;
  levels: SectionLevels;
  visualMix: FoRaverSectionVisuals;
  cutoff: number;
  flash: number;
  saturation: number;
}

/** FOraveR section query result. */
export interface FoRaverSectionAt {
  index: number;
  entry: FoRaverSectionEntry;
  next: FoRaverSectionEntry;
  progress: number;
  sectionTime: number;
}

/** FOraveR conductor state with specific types. */
export interface FoRaverConductorState {
  t: number;
  seed: Seed;
  key: Key;
  keyName: string;
  chord: Chord;
  nextChord: Chord;
  chordProgress: number;
  section: FoRaverSectionBlend;
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

/** FOraveR engine stats. */
export interface FoRaverEngineStats extends SharedEngineStats {
  voices: number;
}

/** FOraveR render stats. */
export interface FoRaverRenderStats {
  available: boolean;
  scale: number;
  iterations: number;
  fps: number;
  layers: [number, number, number, number]; // kaleido, plasma, fractal, noise
  quality: Quality;
  flashMode: FlashMode;
  hdr: boolean;
}

/** FOraveR profile with specific visual settings. */
export interface FoRaverVisualSettings extends SharedVisualSettings {
  iterations: number;
  symmetry: number;
  octaves: number;
  bloom: boolean;
}

export interface FoRaverProfile extends Omit<SharedProfile, 'visual'> {
  visual: FoRaverVisualSettings;
}

/** FOraveR player stats. */
export interface FoRaverPlayerStats {
  started: boolean;
  audioOnly: boolean;
  asleep: boolean;
  clock: number;
  frames: number;
  pulse: number;
  sleep: SleepState;
  audio: FoRaverEngineStats;
  render: FoRaverRenderStats;
  piece: DescribedPiece;
}

// Type aliases for shared types with FOraveR names
export type Profile = FoRaverProfile;
export type VisualSettings = FoRaverVisualSettings;
export type RenderStats = FoRaverRenderStats;
export type EngineStats = FoRaverEngineStats;
export type PlayerStats = FoRaverPlayerStats;

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