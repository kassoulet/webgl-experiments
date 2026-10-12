// The Conductor: the arrangement both the audio and the picture read.
// Aurora: synth-pop at 110–128 bpm under shimmering aurora curtains.

import { Rng } from '@fractal-rave/shared';
import { fbm1, wander, dropFrom } from '@fractal-rave/shared';
import { buildChord, keyLabel, midiToHz, nextDegree, pickKey, placeNotes, bassNote } from './harmony.ts';
import { paletteAt, SECTION_SATURATION } from './palette.ts';
import { FLASH_DEPTH } from './profile.ts';
import type {
  Chord,
  ChordAt,
  ChordEntry,
  DescribedPiece,
  Drift,
  FlashMode,
  ForcedSection,
  GridPosition,
  Key,
  Levels,
  Palette,
  PieceEvent,
  SectionLevels,
  SectionName,
  Seed,
  AuroraSection,
  AuroraSectionVisuals,
  AuroraSectionEntry,
  AuroraSectionBlend,
  AuroraSectionAt,
  AuroraConductorState,
} from './types.ts';

/** The five passages of a synth-pop journey. */
export const SECTIONS: Record<SectionName, AuroraSection> = {
  dawn: {
    name: 'dawn',
    bars: [16, 32],
    bpm: [110, 116],
    kick: 0.6, bass: 0.5, hat: 0.3, clap: 0, perc: 0.1, stab: 0, arp: 0.4, pad: 1.0, fx: 0.2,
    cutoff: 800,
    flash: 0.2,
    visuals: { curtains: 0.7, stars: 0.9, glow: 0.5, particles: 0.3 },
    next: ['verse', 'chorus', 'verse'],
  },
  verse: {
    name: 'verse',
    bars: [16, 32],
    bpm: [112, 120],
    kick: 0.85, bass: 0.8, hat: 0.6, clap: 0.4, perc: 0.3, stab: 0.3, arp: 0.6, pad: 0.8, fx: 0.4,
    cutoff: 2200,
    flash: 0.4,
    visuals: { curtains: 0.9, stars: 0.7, glow: 0.7, particles: 0.5 },
    next: ['chorus', 'bridge'],
  },
  chorus: {
    name: 'chorus',
    bars: [16, 24],
    bpm: [118, 128],
    kick: 1.1, bass: 1.0, hat: 0.9, clap: 1.0, perc: 0.7, stab: 0.8, arp: 0.9, pad: 0.6, fx: 0.6,
    cutoff: 6000,
    flash: 0.8,
    visuals: { curtains: 1.0, stars: 1.0, glow: 1.0, particles: 1.0 },
    next: ['verse', 'bridge', 'finale'],
  },
  bridge: {
    name: 'bridge',
    bars: [8, 16],
    bpm: [108, 114],
    kick: 0.3, bass: 0.4, hat: 0.2, clap: 0, perc: 0.2, stab: 0.2, arp: 0.7, pad: 1.0, fx: 0.5,
    cutoff: 1200,
    flash: 0.25,
    visuals: { curtains: 0.5, stars: 0.8, glow: 0.4, particles: 0.2 },
    next: ['chorus', 'finale', 'verse'],
  },
  finale: {
    name: 'finale',
    bars: [24, 48],
    bpm: [114, 122],
    kick: 1.0, bass: 0.9, hat: 0.8, clap: 0.8, perc: 0.6, stab: 0.7, arp: 1.0, pad: 0.7, fx: 0.8,
    cutoff: 8000,
    flash: 0.6,
    visuals: { curtains: 0.9, stars: 0.9, glow: 0.9, particles: 0.8 },
    next: ['dawn', 'verse'],
  },
};

/** Seconds a section's own change takes to arrive. */
const SECTION_FADE = 1.0;

/** The bass line moves every this many bars. */
const CHORD_BARS: number[] = [8, 8, 8, 16, 8, 16];

/** The shortest a forced section change may take to arrive. */
const MIN_LEAD = 1.0;

const VISUAL_KEYS: (keyof AuroraSectionVisuals)[] = ['curtains', 'stars', 'glow', 'particles'];

export class Conductor {
  readonly seed: Seed;

  private readonly rng: Rng;
  private readonly sectionRng: Rng;
  private readonly chordRng: Rng;
  private readonly eventRng: Rng;
  private readonly noiseSeed: number;

  readonly sections: AuroraSectionEntry[] = [];
  readonly chords: ChordEntry[] = [];
  readonly events: PieceEvent[] = [];

  key: Key;

  /** Written by the audio engine every tick. */
  readonly levels: Levels = {
    kick: 0, bass: 0, hat: 0, stab: 0, pad: 0, brightness: 0.5, peak: 0.3,
  };

  scheduled = -1;
  private sectionCursor = 0;
  private chordCursor = 0;

  constructor(seed: Seed) {
    this.seed = seed;
    this.rng = new Rng(seed);
    const streams = this.rng.fork('streams');
    this.sectionRng = streams.fork('sections');
    this.chordRng = streams.fork('chords');
    this.eventRng = streams.fork('events');
    this.noiseSeed = streams.fork('drift').int(100000);
    this.key = pickKey(streams.fork('key'));
    this.ensure(0);
  }

  ensure(t: number): void {
    if (this.scheduled >= t) return;
    const target = Math.max(t, 0);
    while (this.sections.length === 0 || (this.sections[this.sections.length - 1] as AuroraSectionEntry).t <= target) {
      this.#pushSection(this.#nextSectionTime());
    }
    for (;;) {
      const last = this.chords[this.chords.length - 1];
      if (last && last.t > target) break;
      this.#pushChord(this.#nextChordBar());
    }
    this.scheduled = Math.max(this.scheduled, target);
  }

  #nextSectionTime(): number {
    const last = this.sections[this.sections.length - 1];
    return last ? last.t + last.hold : 0;
  }

  #pushSection(t: number): void {
    const previous = this.sections[this.sections.length - 1];
    const name: SectionName = previous
      ? this.sectionRng.pick(SECTIONS[previous.section.name].next)
      : 'dawn';
    const section = SECTIONS[name];
    const bpm = this.sectionRng.range(section.bpm[0], section.bpm[1]);
    const bars = Math.round(this.sectionRng.range(section.bars[0], section.bars[1]) / 4) * 4;
    const barSeconds = 240 / bpm;
    const entry: AuroraSectionEntry = {
      t,
      bar: previous ? previous.bar + previous.bars : 0,
      section,
      previous: previous ? previous.section : section,
      hold: bars * barSeconds,
      bars,
      barSeconds,
      bpm,
    };
    // A swell into chorus/finale lives in the previous section.
    if (previous && (name === 'chorus' || name === 'finale') && previous.bars >= 8) {
      this.events.push({
        t: t - 2 * previous.barSeconds,
        type: 'swell',
        params: {
          level: 0.75,
          duration: 2 * previous.barSeconds,
          from: 1,
          to: 4,
          pan: 0,
          note: bassNote(this.key.rootPc, 1),
        },
        hold: 2 * previous.barSeconds,
      });
    }
    this.sections.push(entry);
    this.#pushEventsFor(entry);
  }

  #pushEventsFor(entry: AuroraSectionEntry): void {
    const pending: PieceEvent[] = [];
    if (entry.section.name === 'chorus' || entry.section.name === 'finale') {
      pending.push({
        t: entry.t,
        type: 'sparkle',
        params: { level: 0.9, duration: 1.2, from: 1, to: 1, pan: 0, note: bassNote(this.key.rootPc, 0) },
        hold: 1.2,
      });
      pending.push({
        t: entry.t,
        type: 'flare',
        params: { level: 0.7, duration: 2.0, from: 1, to: 1, pan: this.eventRng.signed() * 0.4, note: 60 },
        hold: 2.0,
      });
      if (this.eventRng.chance(0.5) && entry.bars >= 16) {
        pending.push({
          t: entry.t + this.eventRng.range(4, 8) * entry.barSeconds,
          type: 'wave',
          params: {
            level: 0.5,
            duration: this.eventRng.range(3, 5) * entry.barSeconds,
            from: 1,
            to: this.eventRng.pick([0.5, 1.5]) as number,
            pan: this.eventRng.signed() * 0.5,
            note: bassNote(this.key.rootPc, this.eventRng.int(2)),
          },
          hold: 4 * entry.barSeconds,
        });
      }
    }
    if (entry.section.name === 'bridge' && this.eventRng.chance(0.4)) {
      pending.push({
        t: entry.t + this.eventRng.range(2, 4) * entry.barSeconds,
        type: 'shimmer',
        params: {
          level: 0.4,
          duration: this.eventRng.range(2, 3) * entry.barSeconds,
          from: 3,
          to: 1,
          pan: this.eventRng.signed() * 0.6,
          note: bassNote(this.key.rootPc, 1),
        },
        hold: 4 * entry.barSeconds,
      });
    }
    pending.sort((a, b) => a.t - b.t);
    for (const event of pending) this.events.push(event);
  }

  #nextChordBar(): number {
    const last = this.chords[this.chords.length - 1];
    if (!last) return (this.sections[0] as AuroraSectionEntry).bar;
    return last.nextBar;
  }

  #pushChord(bar: number): void {
    const section = this.#sectionForBar(bar);
    const previous = this.chords[this.chords.length - 1];
    const degree = previous ? nextDegree(this.chordRng, previous.chord.degree) : this.chordRng.int(7);
    const chord: Chord = buildChord({ rootPc: this.key.rootPc, modeName: this.key.modeName, degree });
    const nextBar = bar + (this.chordRng.pick(CHORD_BARS) as number);
    this.chords.push({
      t: this.timeOfBar(bar),
      bar,
      nextBar,
      chord,
      hold: (nextBar - bar) * section.barSeconds,
      bassNotes: [bassNote(chord.rootPc, 0), bassNote(chord.rootPc, 0), bassNote(chord.pcs[2] ?? chord.rootPc, 0)],
      stabNotes: placeNotes(chord.pcs, 64, 2),
      padNotes: placeNotes(chord.pcs, 52, 16),
    });
  }

  #sectionForBar(bar: number): AuroraSectionEntry {
    for (const entry of this.sections) {
      if (bar >= entry.bar && bar < entry.bar + entry.bars) return entry;
    }
    return this.sections[this.sections.length - 1] as AuroraSectionEntry;
  }

  timeOfBar(bar: number): number {
    for (;;) {
      const last = this.sections[this.sections.length - 1];
      if (last && bar < last.bar + last.bars) break;
      this.#pushSection(last ? last.t + last.hold : 0);
    }
    const t = this.#timeOfBar(bar);
    this.scheduled = Math.max(this.scheduled, t);
    return t;
  }

  #timeOfBar(bar: number): number {
    const entry = this.#sectionForBar(bar);
    return entry.t + (bar - entry.bar) * entry.barSeconds;
  }

  #cursorFor<T extends { t: number }>(list: readonly T[], cursor: number, t: number): number {
    let i = Math.min(Math.max(cursor, 0), list.length - 1);
    while (i + 1 < list.length && (list[i + 1] as T).t <= t) i++;
    while (i > 0 && (list[i] as T).t > t) i--;
    return i;
  }

  sectionAt(t: number): AuroraSectionAt {
    this.ensure(t);
    const i = this.#cursorFor(this.sections, this.sectionCursor, t);
    if (t >= (this.sections[0] as AuroraSectionEntry).t) this.sectionCursor = i;
    const entry = this.sections[i] as AuroraSectionEntry;
    const next = this.sections[i + 1] ?? entry;
    const span = Math.max(1e-6, next.t - entry.t);
    const progress = entry === next ? 1 : Math.min(1, Math.max(0, (t - entry.t) / span));
    return { index: i, entry, next, progress, sectionTime: t - entry.t };
  }

  chordAt(t: number): ChordAt {
    this.ensure(t);
    const i = this.#cursorFor(this.chords, this.chordCursor, t);
    if (t >= (this.chords[0] as ChordEntry).t) this.chordCursor = i;
    const entry = this.chords[i] as ChordEntry;
    const next = this.chords[i + 1] ?? entry;
    const span = Math.max(1e-6, next.t - entry.t);
    const progress = entry === next ? 1 : Math.min(1, Math.max(0, (t - entry.t) / span));
    return { index: i, entry, next, progress, hold: entry.hold };
  }

  gridAt(t: number): GridPosition {
    const entry = this.sectionAt(t).entry;
    const within = Math.max(0, t - entry.t);
    const barSeconds = entry.barSeconds;
    const beatSeconds = barSeconds / 4;
    const stepSeconds = beatSeconds / 4;
    const bars = within / barSeconds;
    const beats = within / beatSeconds;
    const barPhase = bars % 1;
    const beatPhase = beats % 1;
    return {
      bar: entry.bar + Math.floor(bars + 1e-7),
      beat: ((Math.floor(beats + 1e-7) % 4) + 4) % 4,
      beatPhase,
      barPhase,
      stepPhase: (within / stepSeconds) % 1,
      barSeconds,
      bpm: entry.bpm,
    };
  }

  eventsBetween(from: number, to: number): PieceEvent[] {
    return this.events.filter((e) => e.t > from && e.t <= to);
  }

  sectionBlend(t: number): AuroraSectionBlend {
    const at = this.sectionAt(t);
    const fade = Math.min(1, Math.max(0, (t - at.entry.t) / SECTION_FADE));
    const f = fade * fade * (3 - 2 * fade);
    const pick = (key: keyof SectionLevels): number => {
      const from = at.entry.previous[key] as number;
      const to = at.entry.section[key] as number;
      return from + (to - from) * f;
    };
    const levels: SectionLevels = {
      kick: pick('kick'), bass: pick('bass'), hat: pick('hat'), clap: pick('clap'),
      perc: pick('perc'), stab: pick('stab'), arp: pick('arp'), pad: pick('pad'), fx: pick('fx'),
    };
    const visualMix: AuroraSectionVisuals = { curtains: 0, stars: 0, glow: 0, particles: 0 };
    for (const key of VISUAL_KEYS) {
      const from = at.entry.previous.visuals[key] as number;
      const to = at.entry.section.visuals[key] as number;
      visualMix[key] = from + (to - from) * f;
    }
    const saturation =
      SECTION_SATURATION[at.entry.previous.name] +
      (SECTION_SATURATION[at.entry.section.name] - SECTION_SATURATION[at.entry.previous.name]) * f;
    return {
      section: at.entry.section,
      previous: at.entry.previous,
      fade: f,
      levels,
      visualMix,
      cutoff: at.entry.previous.cutoff + (at.entry.section.cutoff - at.entry.previous.cutoff) * f,
      flash: at.entry.previous.flash + (at.entry.section.flash - at.entry.previous.flash) * f,
      saturation,
    };
  }

  drift(t: number): Drift {
    const n = this.noiseSeed;
    return {
      spin: wander(t, 60, 0.05, 0.08, n + 11, 2),
      warp: wander(t, 40, 0.5, 0.3, n + 23),
      zoom: wander(t, 90, 0.04, 0.03, n + 31),
      breathe: wander(t, 15, 1, 0.04, n + 47),
      hue: fbm1(t / 240, 3, n + 53),
      glow: wander(t, 70, 0.4, 0.2, n + 61),
    };
  }

  pulseAt(t: number, flash: FlashMode, blend: AuroraSectionBlend): number {
    const grid = this.gridAt(t);
    const envelope = Math.exp(-grid.beatPhase * 4.0);
    const backbeat = grid.beat % 2 === 1 ? 0.6 : 1;
    return Math.min(1, envelope * backbeat * blend.flash * FLASH_DEPTH[flash]);
  }

  stateAt(t: number, flash: FlashMode = 'soft'): AuroraConductorState {
    this.ensure(t);
    const c = this.chordAt(t);
    const at = this.sectionAt(t);
    const blend = this.sectionBlend(t);
    const grid = this.gridAt(t);
    const drift = this.drift(t);
    const palette = this.#paletteFor(c, blend.saturation);
    return {
      t,
      seed: this.seed,
      key: this.key,
      keyName: keyLabel(this.key),
      chord: c.entry.chord,
      nextChord: c.next.chord,
      chordProgress: c.progress,
      section: blend,
      sectionName: at.entry.section.name,
      sectionProgress: at.progress,
      sectionTime: at.sectionTime,
      grid,
      drift,
      palette,
      levels: this.levels,
      pulse: this.pulseAt(t, flash, blend),
      barsToNext: Math.max(0, at.entry.bars - Math.floor(at.sectionTime / at.entry.barSeconds) - 1),
    };
  }

  #paletteFor(chord: ChordAt, saturation: number): Palette {
    return paletteAt({
      chord: chord.entry.chord,
      nextChord: chord.next.chord,
      progress: chord.progress,
      saturation,
    });
  }

  bassHz(t: number): number {
    return midiToHz(this.chordAt(t).entry.bassNotes[0] as number);
  }

  forceNextSection(t: number): ForcedSection {
    this.ensure(t);
    const from = this.sectionAt(t);
    const entry = from.entry;
    const barsIn = (t - entry.t) / entry.barSeconds;
    let earliest = entry.bar + Math.floor(barsIn + 1e-9) + 1;
    while (entry.t + (earliest - entry.bar) * entry.barSeconds - t < MIN_LEAD) earliest++;
    const cutBar = Math.ceil(earliest / 4) * 4;
    const at = entry.t + (cutBar - entry.bar) * entry.barSeconds;

    entry.bars = cutBar - entry.bar;
    entry.hold = at - entry.t;

    this.sections.length = from.index + 1;
    dropFrom(this.events, at);
    dropFrom(this.chords, at);
    this.sectionCursor = Math.min(this.sectionCursor, from.index);
    this.chordCursor = Math.min(this.chordCursor, Math.max(0, this.chords.length - 1));
    this.scheduled = at;

    this.#pushSection(at);
    this.scheduled = at;
    this.events.sort((a, b) => a.t - b.t);
    const pushed = this.sections[from.index + 1] as AuroraSectionEntry;
    return { name: pushed.section.name, at: pushed.t, bar: pushed.bar, lead: pushed.t - t };
  }

  describe(t: number): DescribedPiece {
    const state = this.stateAt(t);
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
}