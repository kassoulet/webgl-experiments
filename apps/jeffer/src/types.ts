// The shared contracts. Every module agrees on the shapes in here, and nothing
// else is allowed to invent one: the conductor, the audio engine, the renderer
// and the tools all speak these types (spec §1).
//
// The vocabulary is the app's. A *passage* is a stretch of the arrangement with
// one character; a *phrase* is four bars and the unit the patterns are built
// from; a *section* is a chord plus the bass notes under it. The picture's four
// layers — the oscilloscope, the colour, the tape and the glitch — are named
// here because the conductor decides how much of each is on screen and the
// shader decides what that looks like.

/** A seed is whatever a URL fragment or the seed box can carry. */
export type Seed = string | number;

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export type KeyName = string;
export type ModeName = string;
export type ChordName = string;
export type PaletteName = string;
export type SectionName = 'intro' | 'build' | 'groove' | 'drop' | 'break' | 'peak';

/** Musical key: a root pitch class and a mode. Electro lives in minor, but
 *  not only in one of them — the reference sits in a flat minor and the set
 *  moves. */
export interface Key {
  rootPc: number;
  modeName: ModeName;
  name: KeyName;
}

export interface Chord {
  name: ChordName;
  degree: number;
  /** Pitch classes, root first. */
  pcs: number[];
  /** Bass note, in the register the bass voice actually plays. */
  bassPc: number;
  /** The interval above the bass this chord is voiced from. */
  quality: number[];
}

/** The levels a passage asks for, per instrument, 0..1.2. The buses are ramped
 *  to these; nothing cuts. */
export interface SectionLevels {
  kick: number;
  bass: number;
  hat: number;
  clap: number;
  perc: number;
  stab: number;
  arp: number;
  pad: number;
  fx: number;
}

/** How much of each picture layer is on screen, 0..1. Four layers and a
 *  `vec4`: the shader averages them rather than summing (see shaders.ts), so a
 *  layer at zero genuinely disappears instead of being outvoted. */
export interface SectionVisuals {
  scope: number;
  colour: number;
  vhs: number;
  glitch: number;
}

export interface Section {
  name: SectionName;
  /** Bars in the passage, before the seeded rounding to whole phrases. */
  bars: [number, number];
  /** Beats per minute, before the seeded pick. */
  bpm: [number, number];
  kick: number;
  bass: number;
  hat: number;
  clap: number;
  perc: number;
  stab: number;
  arp: number;
  pad: number;
  fx: number;
  /** The master low-pass on the synths, in Hz. Electro is dark; this is the
   *  single biggest colour on the arrangement. */
  cutoff: number;
  /** How much this passage may flash, 0..1. */
  flash: number;
  visuals: SectionVisuals;
  /** Where this passage tends to go. */
  next: SectionName[];
}

export interface SectionEntry {
  t: number;
  /** The absolute bar number this passage starts on. */
  bar: number;
  section: Section;
  previous: Section;
  /** Seconds until the next passage. */
  hold: number;
  /** Bars in this passage. */
  bars: number;
  /** Seconds per bar: constant for the whole passage. */
  barSeconds: number;
  /** The tempo this passage runs at. */
  bpm: number;
}

/** What a forced passage change did, for the caller that asked for it. */
export interface ForcedSection {
  name: SectionName;
  /** When it starts, on the journey clock. Never in the past. */
  at: number;
  /** The bar it starts on — the same bar the engine's cursor re-anchors to. */
  bar: number;
  /** Seconds between the request and the change. */
  lead: number;
}

export interface ChordEntry {
  t: number;
  bar: number;
  /** The bar the next chord lands on. Stored rather than re-rolled, so asking
   *  for "the next chord" never consumes a random number. */
  nextBar: number;
  chord: Chord;
  /** Seconds until the next chord, as an estimate: exact enough to show, and
   *  the authoritative value is the next entry's own `t`. */
  hold: number;
  /** MIDI notes the bass plays, root first, already in the bass register. */
  bassNotes: number[];
  /** MIDI notes the stabs and arps play, in the mid register. */
  stabNotes: number[];
  /** MIDI notes the pad plays, wide and dark. */
  padNotes: number[];
}

export interface EventParams {
  level: number;
  /** Seconds the event runs for. */
  duration: number;
  /** Start and end of a sweep, as a multiplier on the current frequency. */
  from: number;
  to: number;
  /** Stereo position, -1..1. */
  pan: number;
  /** The bass note a siren bends toward, as a MIDI number. */
  note: number;
}

export type EventType = 'riser' | 'impact' | 'sweep' | 'siren' | 'crash' | 'zap';

export interface PieceEvent {
  t: number;
  type: EventType;
  params: EventParams;
  hold: number;
}

/**
 * The palette. Measured off the reference video, not invented: 64.9% of every
 * sampled frame is pure black, and what is left is a narrow run of electric
 * blue-violet and a red. `void` is therefore a real colour here rather than a
 * placeholder — on this material the background *is* the picture.
 */
export interface Palette {
  name: PaletteName;
  /** The black the picture sits on. */
  void: RGB;
  /** Deep — the shadowed end of the wash. */
  deep: RGB;
  /** Mid — the body of the colour. */
  mid: RGB;
  /** Hot — the bright end, where the scope burns out. */
  hot: RGB;
  /** Accent — the one colour that is not a step on the ramp. */
  accent: RGB;
}

/**
 * What the picture is fed by the sound, written by the audio engine and read by
 * the renderer (spec §4). Each is a smoothed envelope, 0..1.
 */
export interface Levels {
  kick: number;
  bass: number;
  hat: number;
  stab: number;
  pad: number;
  /** Loudness as a 0..1 brightness the tape noise can breathe with. */
  brightness: number;
  peak: number;
}

export interface Drift {
  /** Slow wander of the colour field, -1..1 per axis. */
  x: number;
  y: number;
  /** How fast the drift is moving, 0..1. */
  speed: number;
}

export interface GridPosition {
  /** Absolute bar number. */
  bar: number;
  beat: number;
  beatPhase: number;
  barPhase: number;
  stepPhase: number;
  barSeconds: number;
  bpm: number;
}

export interface SectionAt {
  index: number;
  entry: SectionEntry;
  next: SectionEntry;
  /** 0..1 through this passage. */
  progress: number;
  /** Seconds since this passage started. */
  sectionTime: number;
}

export interface ChordAt {
  index: number;
  entry: ChordEntry;
  next: ChordEntry;
  progress: number;
  hold: number;
}

export interface SectionBlend {
  section: Section;
  previous: Section;
  /** 0 at the change, 1 once the new passage has fully arrived. */
  fade: number;
  /** The blended levels, which is what both halves actually use. */
  levels: SectionLevels;
  visualMix: SectionVisuals;
  cutoff: number;
  flash: number;
  saturation: number;
}

/**
 * The picture's flash budget right now: the kick envelope multiplied by the
 * passage's flash allowance and the user's flash mode. Zero means the picture
 * never flashes, whatever the drums are doing.
 */
export type FlashMode = 'soft' | 'full';

export interface ConductorState {
  t: number;
  seed: Seed;
  key: Key;
  keyName: KeyName;
  chord: Chord;
  nextChord: Chord;
  chordProgress: number;
  section: SectionBlend;
  sectionName: SectionName;
  sectionProgress: number;
  /** Seconds since the current passage began. */
  sectionTime: number;
  grid: GridPosition;
  drift: Drift;
  palette: Palette;
  levels: Levels;
  pulse: number;
  /** Bars until the next passage begins, or 0 while the last bar is playing. */
  barsToNext: number;
  /** How glitchy the picture is allowed to be right now, 0..1. Derived from
   *  the arrangement rather than rolled per frame, so the tape and the scope
   *  agree about what the music is doing. */
  glitch: number;
  /** How bright the scope burns, 0..1. */
  scope: number;
}

/** A short description of the set, for the HUD. */
export interface DescribedPiece {
  key: KeyName;
  chord: ChordName;
  next: ChordName;
  section: SectionName;
  bpm: number;
  bar: number;
  palette: PaletteName;
}

export interface EngineStats {
  /** Gated short-term loudness, LUFS. -Infinity until the meter has blocks. */
  lufs: number;
  /** True peak, dBTP. -Infinity until the meter has blocks. */
  truePeakDb: number;
  /** The leveller's own trim, dB. */
  trimDb: number;
  /** Bars written into the schedule: cumulative, so a stall is visible. */
  bars: number;
  /** Voices started: cumulative. */
  voices: number;
  clock: number;
  /** Metering messages from the audio thread: cumulative. */
  messages: number;
  /** False when the AudioWorklet is unavailable and the trim stays put. */
  meterAvailable: boolean;
  /** True once the analyser has produced a waveform, i.e. the scope is real. */
  scopeAvailable: boolean;
  /** Audio-only: the picture is stopped and the music is on its own. */
  audioOnly: boolean;
}

/**
 * The oscilloscope's data for one frame, read from a real AnalyserNode on the
 * master bus. This is the one thing in the picture that is measured rather than
 * drawn: the trace is the signal that is coming out of the limiter.
 */
export interface ScopeFrame {
  /** Time domain, -1..1, `SCOPE_BINS` samples. */
  wave: Float32Array;
  /** Frequency domain, 0..1, `SCOPE_BINS` bins, log-spaced. */
  spectrum: Float32Array;
  /** Peak of the time-domain buffer, 0..1 — what the trace is drawn around. */
  peak: number;
  /** 0..1, how much of the frame the signal is filling. */
  rms: number;
}

/**
 * The scope's data as a plain array, for the diagnostic hook. A Float32Array
 * survives `JSON.stringify` as an object with the numbers as *keys* — which is
 * truthy, has no `length`, and reads as an empty object to anything that treats
 * it as an array. That is a bad thing to hand a console, and a worse thing to
 * hand a test, so the one place the data leaves the app as data converts it.
 * Inside the app the Float32Array is what the texture upload wants and stays.
 */
export interface ScopeSnapshot {
  wave: number[];
  spectrum: number[];
  peak: number;
  rms: number;
}

export interface RenderStats {
  available: boolean;
  /** Frames per second, smoothed. */
  fps: number;
  /** Device pixels per CSS pixel actually drawn. */
  scale: number;
  /** Internal resolution actually allocated. */
  width: number;
  height: number;
  /** How much light is in the frame, 0..1. A 32x32 point-sampled reduction of
   *  the tone-mapped frame, read back a few times a second: enough to tell a
   *  black canvas from a lit one without stalling the pipeline every frame. */
  mean: number;
  flashMode: FlashMode;
  /** The four picture layers as they are on screen right now: scope, colour,
   *  vhs, glitch. */
  layers: [number, number, number, number];
  /** True when the float render targets are real rather than the fallback. */
  hdr: boolean;
  /** Points the trace is drawn from, or 0 when there is no analyser. */
  scopeBins: number;
  /** Noise octaves in the colour field — the quality knob. */
  octaves: number;
  quality: Quality;
}

export interface SleepState {
  /** The journey time the fade finishes, or null. */
  at: number | null;
  secondsLeft: number | null;
  /** 0..1, how bright the picture is while the timer runs. */
  dim: number;
}

export interface PlayerStats {
  started: boolean;
  audioOnly: boolean;
  asleep: boolean;
  /** The journey clock: the AudioContext's, or wall time without one. */
  clock: number;
  frames: number;
  /** The pulse the picture is actually drawing, after the flash cap. */
  pulse: number;
  sleep: SleepState;
  audio: EngineStats;
  render: RenderStats;
  scope: ScopeSnapshot;
  piece: DescribedPiece;
}

export type Quality = 'auto' | 'low' | 'high';

export interface Profile {
  name: 'mobile' | 'desktop';
  touch: boolean;
  cores: number;
  /** Detuned voices per synth hit: CPU, not taste. */
  synthVoices: number;
  reverbSeconds: number;
  visual: VisualSettings;
}

export interface VisualSettings {
  scale: number;
  /** Noise octaves in the colour field. There is no fractal in this picture, so
   *  this is the only shader loop that is a quality knob. */
  octaves: number;
  bloom: boolean;
  /** Scanlines across the frame. A property of the *output*, not of the drawing
   *  buffer, so the tape looks the same at every resolution scale. */
  scanLines: number;
}

/** Per-frame overrides, for a diagnostic draw and for nothing else. */
export interface DrawOptions {
  time?: number;
  /** Explicit layer mix: scope, colour, vhs, glitch. */
  layers?: [number, number, number, number];
  /** Brightness multiplier, 1 = as the set asks. */
  pulse?: number;
  /** Freeze the slow drift, so two captures differ only in what was asked for. */
  drift?: boolean;
  /** Overall brightness. */
  dim?: number;
  /** Force the oscilloscope's deflection gain, for a capture with and without
   *  auto-ranging. 1 is the auto-ranging the app draws. */
  scopeGain?: number;
  /**
   * Pin the oscilloscope's data instead of reading the live analyser.
   *
   * Without this, a capture cannot be compared with another one: two draws of
   * the same pinned moment still get two different waveforms, because the
   * analyser keeps running, so a difference between the two frames is as likely
   * to be the music as it is to be the thing under test. Pinning the signal
   * alongside the arrangement is what makes "the same picture with the scope
   * turned off" an experiment rather than two photographs.
   */
  scope?: ScopeFrame | null;
}
