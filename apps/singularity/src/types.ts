// Types shared across the app. The conductor's state is the contract between the
// two halves (spec §5), so it is described once, here, and both the audio engine
// and the renderer read it.

export type Seed = string | number;

/** Linear RGB, three channels. */
export type RGB = [number, number, number];

export type Quality = 'auto' | 'low' | 'high';

export interface VisualSettings {
  scale: number;
  steps: number;
  volumetric: boolean;
  stars: number;
}

export interface Profile {
  name: 'mobile' | 'desktop';
  touch: boolean;
  cores: number;
  /** String-machine voices: 1 on a phone, 2 on a desktop. */
  padLayers: number;
  grainScale: number;
  maxGrains: number;
  reverbSeconds: number;
  /** A starting guess; the renderer still measures and adjusts. */
  visual: VisualSettings;
}

export interface Mode {
  name: string;
  intervals: number[];
  flavour: string;
}

export type ShapeName =
  | 'sus2' | 'sus4' | 'quartal' | 'add9' | 'sixth'
  | 'triad' | 'seventh' | 'ninth' | 'eleventh';

export interface Chord {
  degree: number;
  rootPc: number;
  modeName: string;
  shape: ShapeName;
  /** Pitch classes, root first. */
  pcs: number[];
  /** Semitone intervals above the chord's own root. */
  intervals: number[];
  name: string;
}

export interface Key {
  rootPc: number;
  modeName: string;
}

export interface Register {
  lo: number;
  hi: number;
  span: number;
  center: number;
}

/** A scale range, `[min, max]`, in seconds. */
export type Span = [number, number];

/** The piece's slow weather (spec §5's "mood/section"). */
export interface Mood {
  name: string;
  density: number;
  brightness: number;
  drone: number;
  pad: number;
  scape: number;
  shimmer: number;
  warmth: number;
  motion: number;
  warp: number;
  grains: number;
  march: number;
  chord: Span;
  section: Span;
  event: Span;
}

/** The mood's numeric fields: everything a level can be read from. */
export type MoodLevel = Exclude<keyof Mood, 'name' | 'chord' | 'section' | 'event'>;

export interface ChordEntry {
  t: number;
  chord: Chord;
  /** MIDI notes, voice-led from the previous chord. */
  voicing: number[];
  /** MIDI notes for the drone bed, below the pads. */
  drone: number[];
  /** Seconds until the next chord entry. */
  hold: number;
}

export interface SectionEntry {
  t: number;
  mood: Mood;
  previous: Mood;
  hold: number;
}

export type EventType = 'distantTone' | 'risingSweep' | 'shimmerBurst' | 'dustCloud' | 'farBell';

export interface EventParams {
  level: number;
  brightness: number;
  offset: number;
  interval: number;
  pan: number;
  duration: number;
}

export interface PieceEvent {
  t: number;
  type: EventType;
  params: EventParams;
  hold: number;
}

export interface Palette {
  name: string;
  deep: RGB;
  mid: RGB;
  hot: RGB;
}

/**
 * A far-away event lighting a star (spec §3 "far-away sound events can light a
 * distant star"). The conductor says *where* in the sky and how brightly; the
 * shader draws a star of the same field there. Present only while an event runs.
 */
export interface Flare {
  /** 0..1, the event's own envelope: rises over seconds, fades over its duration. */
  level: number;
  /** Where in the sky the lit star sits, unit length. */
  dir: [number, number, number];
}

/** Written by the audio engine, read by the picture (spec §5). */
export interface Levels {
  pad: number;
  drone: number;
  scape: number;
  shimmer: number;
  brightness: number;
  peak: number;
}

export interface Drift {
  brightness: number;
  warp: number;
  motion: number;
  density: number;
  shimmer: number;
  detune: number;
}

export interface Camera {
  position: [number, number, number];
  yaw: number;
  pitch: number;
}

export interface ChordAt {
  index: number;
  entry: ChordEntry;
  next: ChordEntry;
  progress: number;
  hold: number;
  chordTime: number;
}

export interface SectionAt {
  index: number;
  entry: SectionEntry;
  next: SectionEntry;
  progress: number;
  moodTime: number;
}

export interface MoodBlend {
  mood: Mood;
  previous: Mood;
  fade: number;
  progress: number;
}

/** Everything one frame needs, from one call. */
export interface ConductorState {
  t: number;
  seed: Seed;
  key: Key;
  keyName: string;
  chord: Chord;
  nextChord: Chord;
  voicing: number[];
  droneHz: number[];
  chordProgress: number;
  chordFade: number;
  chordTime: number;
  mood: Mood;
  previousMood: Mood;
  moodBlend: number;
  moodProgress: number;
  drift: Drift;
  palette: Palette;
  levels: Levels;
  /** The star a far-away event is lighting right now, or null between events. */
  flare: Flare | null;
}

export interface DescribedPiece {
  key: string;
  chord: string;
  next: string;
  mood: string;
  held: string;
  palette: string;
}

export interface EngineStats {
  lufs: number;
  truePeakDb: number;
  trimDb: number;
  /** Chords playing right now — zero would mean the schedule ran dry. */
  chords: number;
  /** Grains spawned since the engine started: cumulative, so it only grows. */
  grains: number;
  /** The journey clock (the audio context's own time). */
  clock: number;
  /**
   * Loudness messages received from the meter worklet, cumulative. This is the
   * one signal that proves the audio thread is still *processing*: the context
   * clock keeps advancing even if the graph renders silence, so a soak needs
   * both — the clock for the device, this for the graph.
   */
  messages: number;
  /** Whether the meter worklet loaded at all (false where it is unavailable). */
  meterAvailable: boolean;
}

export interface RenderStats {
  available: boolean;
  scale: number;
  steps: number;
  fps: number;
  volumetric: boolean;
  quality: Quality;
}

/** The sleep timer as the app sees it (spec §4's "slow fade-out"). */
export interface SleepState {
  /** The deadline the fade is heading for, on the journey clock; null if off. */
  at: number | null;
  /** Seconds of fade left, or null when no timer runs. */
  secondsLeft: number | null;
  /** 1 → 0 over the fade: what the picture is multiplied by. */
  dim: number;
}

export interface PlayerStats {
  started: boolean;
  audioOnly: boolean;
  asleep: boolean;
  clock: number;
  frames: number;
  sleep: SleepState;
  audio: EngineStats;
  render: RenderStats;
  piece: DescribedPiece;
}
