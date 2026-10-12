// Shared types across FractalRave web apps.
// Each app extends these with its own app-specific types.

/** A seed is whatever a URL fragment or the seed box can carry. */
export type Seed = string | number;

/** Linear RGB, three channels. */
export type RGB = [number, number, number];

export type Quality = 'auto' | 'low' | 'high';

export type FlashMode = 'soft' | 'full';

/** A range, `[min, max]`; in seconds for time spans, in bars for counts. */
export type Span = [number, number];

/** Musical key: a root pitch class and a mode. */
export interface Key {
  rootPc: number;
  modeName: string;
}

export interface Mode {
  name: string;
  intervals: number[];
  flavour: string;
}

/** A chord with its degree, root, and pitch classes. */
export interface Chord {
  degree: number;
  rootPc: number;
  modeName: string;
  pcs: number[];
  name: string;
}

/** A chord schedule entry. */
export interface ChordEntry {
  t: number;
  bar: number;
  nextBar: number;
  chord: Chord;
  hold: number;
  bassNotes: number[];
  stabNotes: number[];
  padNotes: number[];
}

/** What the picture is fed by the sound, written by the audio engine. */
export interface Levels {
  kick: number;
  bass: number;
  hat: number;
  stab: number;
  pad: number;
  brightness: number;
  peak: number;
}

/** Slow, continuous parameter wander. Nothing here ever jumps. */
export interface Drift {
  spin: number;
  warp: number;
  zoom: number;
  breathe: number;
  hue: number;
  glow: number;
}

/** The palette for the visuals. */
export interface Palette {
  name: string;
  deep: RGB;
  mid: RGB;
  hot: RGB;
  accent: RGB;
}

/** Where the journey is in the bar, recomputed from time on every call. */
export interface GridPosition {
  bar: number;
  beat: number;
  beatPhase: number;
  barPhase: number;
  stepPhase: number;
  barSeconds: number;
  bpm: number;
}

/** Section blend for crossfading between passages. */
export interface SectionBlend {
  section: Section;
  previous: Section;
  fade: number;
  levels: SectionLevels;
  visualMix: SectionVisuals;
  cutoff: number;
  flash: number;
  saturation: number;
}

/** The numeric face of a Section: everything that is not a name or a range. */
export type SectionLevels = Pick<
  Section,
  'kick' | 'bass' | 'hat' | 'clap' | 'perc' | 'stab' | 'arp' | 'pad' | 'fx'
>;

/** Section schedule entry. */
export interface SectionEntry {
  t: number;
  bar: number;
  section: Section;
  previous: Section;
  hold: number;
  bars: number;
  barSeconds: number;
  bpm: number;
}

/** What a forced section change did, for the caller that asked for it. */
export interface ForcedSection {
  name: SectionName;
  at: number;
  bar: number;
  lead: number;
}

/** Piece event (riser, impact, etc.). The aurora app appends its own event
 *  names (swell, sparkle, wave, flare, shimmer); a shared event list would
 *  either grow forever or fork, so the type is open-ended by design and the
 *  apps narrow it themselves. */
export type EventType = 'riser' | 'impact' | 'sweep' | 'siren' | 'crash' | 'zap' | (string & {});

export interface EventParams {
  level: number;
  duration: number;
  from: number;
  to: number;
  pan: number;
  note: number;
}

export interface PieceEvent {
  t: number;
  type: EventType;
  params: EventParams;
  hold: number;
}

/** A short description of the set, for the HUD. */
export interface DescribedPiece {
  key: string;
  chord: string;
  next: string;
  section: string;
  bpm: number;
  bar: number;
  palette: string;
}

export interface EngineStats {
  lufs: number;
  truePeakDb: number;
  trimDb: number;
  bars: number;
  voices: number;
  clock: number;
  messages: number;
  meterAvailable: boolean;
}

export interface RenderStats {
  available: boolean;
  scale: number;
  fps: number;
  quality: Quality;
  flashMode: FlashMode;
  hdr: boolean;
}

/** The sleep timer as the app sees it. */
export interface SleepState {
  at: number | null;
  secondsLeft: number | null;
  dim: number;
}

export interface PlayerStats {
  started: boolean;
  audioOnly: boolean;
  asleep: boolean;
  clock: number;
  frames: number;
  pulse: number;
  sleep: SleepState;
  audio: EngineStats;
  render: RenderStats;
  piece: DescribedPiece;
}

/** Base section type - apps extend with their specific visuals. */
export interface Section {
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
  visuals: SectionVisuals;
  next: SectionName[];
}

/** Section visuals - apps define their own. */
export interface SectionVisuals {
  [key: string]: number;
}

/** Section name - apps define their own set. */
export type SectionName = string;

/** Section query result. */
export interface SectionAt {
  index: number;
  entry: SectionEntry;
  next: SectionEntry;
  progress: number;
  sectionTime: number;
}

/** Chord query result. */
export interface ChordAt {
  index: number;
  entry: ChordEntry;
  next: ChordEntry;
  progress: number;
  hold: number;
}

/** Conductor state returned by stateAt(). */
export interface ConductorState {
  t: number;
  seed: Seed;
  key: Key;
  keyName: string;
  chord: Chord;
  nextChord: Chord;
  chordProgress: number;
  section: SectionBlend;
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

/** Profile for mobile/desktop. */
export interface Profile {
  name: 'mobile' | 'desktop';
  touch: boolean;
  cores: number;
  synthVoices: number;
  reverbSeconds: number;
  visual: VisualSettings;
}

export interface VisualSettings {
  scale: number;
  [key: string]: number | boolean;
}