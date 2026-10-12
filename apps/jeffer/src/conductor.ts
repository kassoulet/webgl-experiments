// The Conductor: the arrangement both the audio and the picture read (spec §2).
//
// It holds a *set*: six kinds of passage, a bar clock, a bass line that moves
// every eight bars or so, and the transitions — risers, impacts, crashes — that
// announce a change. Seeded, so a seed reproduces a set.
//
// The tempo range is not a guess. The reference runs at 126.05 bpm, measured by
// autocorrelating the onset envelope, with the next candidate a quarter as
// strong; the six passages below bracket that number rather than inventing one.
//
// It is pure and time-addressable: `ensure(t)` extends the schedule forward and
// `stateAt(t)` answers for any t the schedule covers. Audio schedules a dozen
// seconds ahead, the picture reads the present, and both see the same set
// because the schedule is only ever appended in order.
//
// Every entry carries its own `hold`: the seconds until the next entry of that
// kind. Queries never draw random numbers, so asking for a time twice can never
// change it. The step patterns are not in this file at all — they are a
// function of `(seed, passage, bar)` (see `src/patterns.ts`), which is why this
// one stays small enough to reason about.

import { Rng } from './rng.ts';
import { fbm1, noise1 } from './noise.ts';
import { buildChord, keyLabel, midiToHz, nextDegree, pickKey, placeNotes, bassNote } from './harmony.ts';
import { paletteAt, SECTION_SATURATION } from './palette.ts';
import { FLASH_DEPTH } from './profile.ts';
import type {
  Chord,
  ChordAt,
  ChordEntry,
  ConductorState,
  DescribedPiece,
  Drift,
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

/**
 * The six passages of a set (spec §2). `next` is where each one tends to go;
 * the choice is seeded, so a set can also surprise itself.
 *
 * The levels are the measured shape of the reference: it is a bass record. The
 * bass is never quieter than the kick for long, the top end is thin, and the
 * master low-pass does most of the work of a build.
 */
export const SECTIONS: Record<SectionName, Section> = {
  intro: {
    name: 'intro',
    bars: [16, 32],
    bpm: [122, 126],
    kick: 0.85, bass: 0.7, hat: 0, clap: 0, perc: 0, stab: 0, arp: 0.3, pad: 0.9, fx: 0.2,
    cutoff: 700,
    flash: 0.35,
    // A near-black frame with a trace on it: the reference is two thirds black
    // and stays that way through its quietest passages.
    visuals: { scope: 0.9, colour: 0.35, vhs: 0.8, glitch: 0.15 },
    next: ['build', 'groove'],
  },
  build: {
    name: 'build',
    bars: [8, 16],
    bpm: [124, 128],
    kick: 1.0, bass: 1.0, hat: 0.7, clap: 0.5, perc: 0.5, stab: 0.3, arp: 0.4, pad: 0.6, fx: 0.6,
    cutoff: 2400,
    flash: 0.7,
    visuals: { scope: 1, colour: 0.65, vhs: 0.5, glitch: 0.4 },
    next: ['drop', 'groove'],
  },
  groove: {
    name: 'groove',
    bars: [16, 32],
    bpm: [124, 128],
    kick: 1.1, bass: 1.15, hat: 0.9, clap: 0.9, perc: 0.7, stab: 0.6, arp: 0.5, pad: 0.5, fx: 0.4,
    cutoff: 6000,
    flash: 0.85,
    visuals: { scope: 1, colour: 0.9, vhs: 0.6, glitch: 0.5 },
    next: ['break', 'build', 'drop'],
  },
  drop: {
    name: 'drop',
    bars: [16, 32],
    bpm: [126, 130],
    kick: 1.2, bass: 1.25, hat: 1, clap: 1, perc: 0.9, stab: 0.95, arp: 0.7, pad: 0.4, fx: 0.5,
    cutoff: 9000,
    flash: 1,
    visuals: { scope: 1, colour: 1, vhs: 0.85, glitch: 0.8 },
    next: ['break', 'groove', 'peak'],
  },
  break: {
    name: 'break',
    bars: [8, 16],
    bpm: [122, 126],
    kick: 0, bass: 0.5, hat: 0.2, clap: 0, perc: 0.3, stab: 0.4, arp: 0.9, pad: 1, fx: 0.5,
    cutoff: 1200,
    flash: 0.3,
    // The tape runs furthest here. The reference's quiet passages are the ones
    // where the picture is at its most degraded, which is what a break is.
    visuals: { scope: 0.65, colour: 0.55, vhs: 1, glitch: 0.2 },
    next: ['build', 'drop'],
  },
  peak: {
    name: 'peak',
    bars: [16, 24],
    bpm: [128, 132],
    kick: 1.2, bass: 1.2, hat: 1, clap: 1, perc: 1, stab: 1, arp: 0.8, pad: 0.5, fx: 0.6,
    cutoff: 11000,
    flash: 1,
    visuals: { scope: 1, colour: 1, vhs: 0.9, glitch: 1 },
    next: ['break', 'groove'],
  },
};

/** Seconds a passage's own change takes to arrive. Fast for a set, and still a
 *  ramp: a drop's kick comes up over a beat, not over a bar. */
const SECTION_FADE = 0.75;

export const EVENT_TYPES: EventType[] = ['riser', 'impact', 'sweep', 'siren', 'crash', 'zap'];

/** The bass line moves every this many bars, most of the time. Electro bass
 *  lines are long: the reference holds one for eight bars at a time. */
const CHORD_BARS: number[] = [8, 8, 8, 16, 8, 16];

/** The shortest a forced passage change may take to arrive. A bar at these
 *  tempos is under two seconds, so this is "the next bar line, and never this
 *  instant" — a cut has to be heard as a change, not as a glitch. */
const MIN_LEAD = 0.75;

/** Drop every entry at or after `t`. The lists this is used on are in
 *  increasing time order, so what goes is the tail. */
function dropFrom<T extends { t: number }>(list: T[], t: number): void {
  let keep = list.length;
  while (keep > 0 && (list[keep - 1] as T).t >= t) keep--;
  list.length = keep;
}

const VISUAL_KEYS: (keyof SectionVisuals)[] = ['scope', 'colour', 'vhs', 'glitch'];

export class Conductor {
  readonly seed: Seed;

  private readonly rng: Rng;
  private readonly sectionRng: Rng;
  private readonly chordRng: Rng;
  private readonly eventRng: Rng;
  private readonly noiseSeed: number;

  readonly sections: SectionEntry[] = [];
  readonly chords: ChordEntry[] = [];
  readonly events: PieceEvent[] = [];

  key: Key;

  /** Written by the audio engine every tick (spec §4: "levels ... shared
   *  memory"). The defaults let the picture run before — or without — sound. */
  readonly levels: Levels = {
    kick: 0, bass: 0, hat: 0, stab: 0, pad: 0, brightness: 0.5, peak: 0.3,
  };

  /** How far ahead the schedule has been extended by `ensure`. */
  scheduled = -1;

  private sectionCursor = 0;
  private chordCursor = 0;
  /** How many of the measured palette runs this set uses. */
  private readonly paletteCount: number;

  constructor(seed: Seed) {
    this.seed = seed;
    this.rng = new Rng(seed);
    const streams = this.rng.fork('streams');
    this.sectionRng = streams.fork('sections');
    this.chordRng = streams.fork('chords');
    this.eventRng = streams.fork('events');
    this.noiseSeed = streams.fork('drift').int(100000);
    this.paletteCount = 2 + streams.fork('palette').int(3);
    this.key = pickKey(streams.fork('key'));
    this.ensure(0);
  }

  /**
   * Extend the schedule to cover time `t`, plus one entry beyond of every kind:
   * a query needs to see what *comes next*, not only what is playing.
   *
   * Every list is generated in increasing time order from its own stream, and
   * every entry depends only on earlier entries, so the schedule is a function
   * of the seed alone — not of when or in what order it is asked for. That is
   * what lets the audio scheduler and the renderer share it.
   */
  ensure(t: number): void {
    if (this.scheduled >= t) return;
    const target = Math.max(t, 0);
    while (this.sections.length === 0 || (this.sections[this.sections.length - 1] as SectionEntry).t <= target) {
      this.#pushSection(this.#nextSectionTime());
    }
    // One entry beyond the target, of every kind. Chords are sparse here — a
    // bass line moves every eight bars or more — so the test is not "one bar
    // past the target" but "one chord that *starts* after it", which is what
    // `chordAt` needs to answer "and then what?".
    for (;;) {
      const last = this.chords[this.chords.length - 1];
      if (last && last.t > target) break;
      this.#pushChord(this.#nextChordBar());
    }
    this.scheduled = Math.max(this.scheduled, target);
  }

  // --- building the schedule -------------------------------------------------

  #nextSectionTime(): number {
    const last = this.sections[this.sections.length - 1];
    return last ? last.t + last.hold : 0;
  }

  #pushSection(t: number): void {
    const previous = this.sections[this.sections.length - 1];
    const name: SectionName = previous
      ? this.sectionRng.pick(SECTIONS[previous.section.name].next)
      : 'intro';
    const section = SECTIONS[name];
    const bpm = this.sectionRng.range(section.bpm[0], section.bpm[1]);
    // Bars come in whole four-bar phrases. It is what a DJ counts in, and it
    // is also what the fills rely on: the last bar of a passage has to be the
    // last bar of a phrase, or a drop can arrive with nothing before it.
    const bars = Math.round(this.sectionRng.range(section.bars[0], section.bars[1]) / 4) * 4;
    const barSeconds = 240 / bpm;
    const entry: SectionEntry = {
      t,
      bar: previous ? previous.bar + previous.bars : 0,
      section,
      previous: previous ? previous.section : section,
      hold: bars * barSeconds,
      bars,
      barSeconds,
      bpm,
    };
    // The riser into this passage lives in the *previous* one, in its last two
    // bars. It cannot be decided when the previous passage was generated,
    // because what comes next is not known until now — and deciding it from
    // the passage's list of possibilities rather than from the choice actually
    // made is how six drops in seven ended up with nothing in front of them.
    if (previous && (name === 'drop' || name === 'peak') && previous.bars >= 8) {
      this.events.push({
        t: t - 2 * previous.barSeconds,
        type: 'riser',
        params: {
          level: 0.85,
          duration: 2 * previous.barSeconds,
          from: 1,
          to: 8,
          pan: 0,
          note: bassNote(this.key.rootPc, 2),
        },
        hold: 2 * previous.barSeconds,
      });
    }
    this.sections.push(entry);
    this.#pushEventsFor(entry);
  }

  /**
   * The events a passage announces, scheduled as it is generated. They all fall
   * inside the passage, so the event list stays in increasing time order without
   * a cursor of its own — but they are collected first and sorted, because a
   * drop pushes its own impact at bar zero and its siren four bars in, and
   * pushing those in generation order would put the list out of order.
   */
  #pushEventsFor(entry: SectionEntry): void {
    const pending: PieceEvent[] = [];
    if (entry.section.name === 'drop' || entry.section.name === 'peak') {
      pending.push({
        t: entry.t,
        type: 'impact',
        params: { level: 1, duration: 1.4, from: 1, to: 1, pan: 0, note: bassNote(this.key.rootPc, 0) },
        hold: 1.4,
      });
      pending.push({
        t: entry.t,
        type: 'crash',
        params: { level: 0.8, duration: 2.2, from: 1, to: 1, pan: this.eventRng.signed() * 0.5, note: 60 },
        hold: 2.2,
      });
      // A long drop earns one siren: a single pitched sweep somewhere inside
      // it, the way a DJ drops a vocal, and never twice in the same place.
      if (this.eventRng.chance(0.6) && entry.bars >= 16) {
        pending.push({
          t: entry.t + this.eventRng.range(4, 8) * entry.barSeconds,
          type: 'siren',
          params: {
            level: 0.55,
            duration: this.eventRng.range(2, 4) * entry.barSeconds,
            from: 1,
            to: this.eventRng.pick([0.5, 1.5, 2]) as number,
            pan: this.eventRng.signed() * 0.6,
            note: bassNote(this.key.rootPc, this.eventRng.int(2)),
          },
          hold: 4 * entry.barSeconds,
        });
      }
      // Electro's own transition: a short downward zap, the sound a bass synth
      // makes when the filter closes on it.
      if (this.eventRng.chance(0.7)) {
        pending.push({
          t: entry.t + 4 * entry.barSeconds,
          type: 'zap',
          params: {
            level: 0.6,
            duration: entry.barSeconds * 0.5,
            from: 6,
            to: 0.4,
            pan: this.eventRng.signed() * 0.4,
            note: bassNote(this.key.rootPc, 1),
          },
          hold: entry.barSeconds * 0.5,
        });
      }
    }
    if (entry.section.name === 'break' && this.eventRng.chance(0.5)) {
      pending.push({
        t: entry.t + this.eventRng.range(2, 6) * entry.barSeconds,
        type: 'sweep',
        params: {
          level: 0.45,
          duration: this.eventRng.range(2, 4) * entry.barSeconds,
          from: 4,
          to: 1,
          pan: this.eventRng.signed() * 0.7,
          note: bassNote(this.key.rootPc, 1),
        },
        hold: 4 * entry.barSeconds,
      });
    }
    pending.sort((a, b) => a.t - b.t);
    for (const event of pending) this.events.push(event);
  }

  /** The bar the next chord lands on. Read off the last chord's own `nextBar`,
   *  so asking never draws a random number — the spacing is rolled once, when
   *  the chord it belongs to is pushed. */
  #nextChordBar(): number {
    const last = this.chords[this.chords.length - 1];
    if (!last) return (this.sections[0] as SectionEntry).bar;
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
      // The bass plays the root an octave and a fifth below middle C, which
      // is where the reference's 62 Hz peak lives.
      bassNotes: [bassNote(chord.bassPc, 0), bassNote(chord.bassPc, 0), bassNote(chord.pcs[2] ?? chord.bassPc, 1)],
      stabNotes: placeNotes(chord.pcs, 60, 12),
      padNotes: placeNotes(chord.pcs, 48, 12),
    });
  }

  /** The passage that owns an absolute bar number. */
  #sectionForBar(bar: number): SectionEntry {
    for (const entry of this.sections) {
      if (bar >= entry.bar && bar < entry.bar + entry.bars) return entry;
    }
    return this.sections[this.sections.length - 1] as SectionEntry;
  }

  /** The time of an absolute bar. Exact, because a passage's tempo is constant
   *  for its whole length — the one place a tempo change happens is a passage
   *  boundary, which is a musical event rather than a drift.
   *
   *  The audio scheduler walks forwards with this: it holds the next bar's
   *  number and asks when that bar is, so it never has to guess where the grid
   *  is or keep its own copy of the tempo.
   */
  timeOfBar(bar: number): number {
    // Passages are extended until one of them *contains* the bar, rather than
    // until the schedule covers some time: `ensure()` is asked for a time, and
    // this is asked for a bar, and guessing between the two used to be a way to
    // ask for a bar nobody has generated yet and get the last passage's tempo
    // back instead.
    for (;;) {
      const last = this.sections[this.sections.length - 1];
      if (last && bar < last.bar + last.bars) break;
      this.#pushSection(last ? last.t + last.hold : 0);
    }
    const t = this.#timeOfBar(bar);
    this.scheduled = Math.max(this.scheduled, t);
    return t;
  }

  /** The time of an absolute bar, from the passages already generated. */
  #timeOfBar(bar: number): number {
    const entry = this.#sectionForBar(bar);
    return entry.t + (bar - entry.bar) * entry.barSeconds;
  }

  // --- queries ---------------------------------------------------------------

  #cursorFor<T extends { t: number }>(list: readonly T[], cursor: number, t: number): number {
    let i = Math.min(Math.max(cursor, 0), list.length - 1);
    while (i + 1 < list.length && (list[i + 1] as T).t <= t) i++;
    while (i > 0 && (list[i] as T).t > t) i--;
    return i;
  }

  sectionAt(t: number): SectionAt {
    // Queries make themselves answerable. `ensure` is monotonic and pure, so
    // this costs nothing and it means no caller can ask about a time the
    // schedule has not reached and get the last entry instead.
    this.ensure(t);
    const i = this.#cursorFor(this.sections, this.sectionCursor, t);
    if (t >= (this.sections[0] as SectionEntry).t) this.sectionCursor = i;
    const entry = this.sections[i] as SectionEntry;
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

  /** Where we are in the bar (spec §4: "if a decision belongs to both halves —
   *  the drums and the picture read the same grid from the same function").
   *
   *  The epsilon is not decoration. `timeOfBar(40)` is `entry.t + 40 *
   *  barSeconds`, and dividing that back by `barSeconds` can land a hair under
   *  40, so bar 40 would read as bar 39 — the kick would be scheduled a bar
   *  late and the flash a bar early, and neither would look like a bug.
   */
  gridAt(t: number): GridPosition {
    const entry = this.sectionAt(t).entry;
    const within = Math.max(0, t - entry.t);
    const barSeconds = entry.barSeconds;
    const beatSeconds = barSeconds / 4;
    const stepSeconds = beatSeconds / 4;
    const bars = within / barSeconds;
    const beats = within / beatSeconds;
    return {
      bar: entry.bar + Math.floor(bars + 1e-7),
      beat: ((Math.floor(beats + 1e-7) % 4) + 4) % 4,
      beatPhase: beats % 1,
      barPhase: bars % 1,
      stepPhase: (within / stepSeconds) % 1,
      barSeconds,
      bpm: entry.bpm,
    };
  }

  /** Events with t in (from, to]. The audio scheduler consumes them in order. */
  eventsBetween(from: number, to: number): PieceEvent[] {
    return this.events.filter((e) => e.t > from && e.t <= to);
  }

  /** The passage's own levels crossing into the next one's (spec §2: layers
   *  enter and leave; nothing in a set ever cuts). */
  sectionBlend(t: number): SectionBlend {
    const at = this.sectionAt(t);
    const fade = Math.min(1, Math.max(0, (t - at.entry.t) / SECTION_FADE));
    // A smootherstep, so the change eases in and out rather than ramping in and
    // snapping at the end of the ramp.
    const f = fade * fade * (3 - 2 * fade);
    const pick = (key: keyof SectionLevels): number => {
      const from = at.entry.previous[key];
      const to = at.entry.section[key];
      return from + (to - from) * f;
    };
    const pickVisual = (key: keyof SectionVisuals): number => {
      const from = at.entry.previous.visuals[key];
      const to = at.entry.section.visuals[key];
      return from + (to - from) * f;
    };
    const levels = {} as SectionLevels;
    for (const key of Object.keys(SECTIONS.intro) as (keyof SectionLevels)[]) {
      if (typeof SECTIONS.intro[key] === 'number') levels[key] = pick(key);
    }
    const visualMix = {} as SectionVisuals;
    for (const key of VISUAL_KEYS) visualMix[key] = pickVisual(key);
    return {
      section: at.entry.section,
      previous: at.entry.previous,
      fade: f,
      levels,
      visualMix,
      cutoff: at.entry.previous.cutoff + (at.entry.section.cutoff - at.entry.previous.cutoff) * f,
      flash: at.entry.previous.flash + (at.entry.section.flash - at.entry.previous.flash) * f,
      saturation: SECTION_SATURATION[at.entry.section.name],
    };
  }

  /**
   * The slow wander of the colour field. Two noises at different rates, so the
   * picture never repeats visibly, and both derived from the seed rather than
   * from a clock — a set describes the same drift on every load.
   */
  drift(t: number): Drift {
    const x = fbm1(t * 0.035, 3, this.noiseSeed);
    const y = fbm1(t * 0.031 + 40, 3, this.noiseSeed + 977);
    const speed = Math.min(1, Math.abs(noise1(t * 0.08, this.noiseSeed + 313)) * 1.6);
    return { x, y, speed };
  }

  /** Everything the picture needs for one moment. */
  stateAt(t: number, flash: FlashMode = 'soft'): ConductorState {
    this.ensure(t);
    const c = this.chordAt(t);
    const at = this.sectionAt(t);
    const blend = this.sectionBlend(t);
    const grid = this.gridAt(t);
    const drift = this.drift(t);
    const palette = this.#paletteFor(c, blend.saturation);

    // The kick envelope, straight off the grid. This is the *only* thing in
    // the picture that flashes, and it is capped below.
    const beat = grid.stepPhase;
    const kick = Math.exp(-beat * 7) * (1 - grid.barPhase * 0.15);
    const pulse = Math.min(1, kick * blend.flash * FLASH_DEPTH[flash]);

    // How broken the tape is right now. Derived from the arrangement rather
    // than rolled per frame, so the scope and the glitch agree about what the
    // music is doing — a drop that is glitching hard on screen while the
    // arrangement thinks it is a breakdown reads as a bug.
    const glitchBase = blend.visualMix.glitch;
    const tear = 0.5 + 0.5 * noise1(t * 1.7, this.noiseSeed + 55);
    const burst = Math.max(0, noise1(t * 0.9, this.noiseSeed + 991) * 1.5);
    const glitch = Math.min(1, Math.max(0, glitchBase * (0.55 + 0.45 * tear) + burst * 0.35));

    // How hard the scope burns. Loud, bright passages burn; a breakdown leaves a
    // trace.
    const loudness = this.levels.brightness;
    const scope = Math.min(1, Math.max(0, blend.visualMix.scope * (0.45 + 0.55 * loudness) + pulse * 0.3));

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
      pulse,
      barsToNext: Math.max(0, at.entry.bars - Math.floor(at.sectionTime / at.entry.barSeconds) - 1),
      glitch,
      scope,
    };
  }

  #paletteFor(chord: ChordAt, saturation: number): Palette {
    return paletteAt({
      chord: chord.entry.chord,
      nextChord: chord.next.chord,
      progress: chord.progress,
      saturation,
      index: this.paletteCount,
    });
  }

  /** The bass note a bar plays, in Hz — what the engine's bass voice reads. */
  bassHz(t: number): number {
    return midiToHz(this.chordAt(t).entry.bassNotes[0] as number);
  }

  /**
   * Force a passage change just after `t`, for the HUD's "skip to the next
   * passage" key. Returns where the change landed, so the caller can tell the
   * engine to re-anchor its cursors and the HUD how long the wait is.
   *
   * The passage in progress is *truncated*: its `hold` and `bars` are cut so
   * that it ends at the change, and everything planned after it is dropped. The
   * cut is placed on a bar line at least `MIN_LEAD` out, rounded up to a
   * four-bar phrase, so the passage still ends on a fill.
   *
   * This is the one place the schedule is rewritten rather than appended to, so
   * it is deliberately *not* seed-deterministic: a set someone has skipped
   * through is not the set the seed alone would have played, and the tests say
   * so rather than pretending otherwise. Everything before the cut is
   * untouched, which is what keeps the picture, the audio and the HUD in
   * agreement for the part of the set that has already been heard.
   */
  forceNextSection(t: number): ForcedSection {
    this.ensure(t);
    const from = this.sectionAt(t);
    const entry = from.entry;
    // The next bar line strictly after `t`, in this passage's own tempo, then
    // as many more bars as it takes to clear `MIN_LEAD`. The epsilon keeps a
    // `t` that is already exactly on a bar line from being pushed a whole bar
    // forward.
    const barsIn = (t - entry.t) / entry.barSeconds;
    let earliest = entry.bar + Math.floor(barsIn + 1e-9) + 1;
    while (entry.t + (earliest - entry.bar) * entry.barSeconds - t < MIN_LEAD) earliest++;
    const cutBar = Math.ceil(earliest / 4) * 4;
    const at = entry.t + (cutBar - entry.bar) * entry.barSeconds;

    // Truncate: the passage in progress now ends at the change.
    entry.bars = cutBar - entry.bar;
    entry.hold = at - entry.t;

    // Everything planned from the change onwards. Passages first — the chords
    // and events hang off their bar numbers, and those bars no longer mean the
    // same thing — then the events and chords themselves. The lists are
    // sorted, so these are suffixes and a length is the whole operation.
    this.sections.length = from.index + 1;
    dropFrom(this.events, at);
    dropFrom(this.chords, at);
    // The cursors were pointing into what was just dropped; `#cursorFor` walks
    // them back on the next query, but clamping keeps the invariant that a
    // cursor never names a dropped entry.
    this.sectionCursor = Math.min(this.sectionCursor, from.index);
    this.chordCursor = Math.min(this.chordCursor, Math.max(0, this.chords.length - 1));
    this.scheduled = at;

    this.#pushSection(at);
    this.scheduled = at;
    // The riser a drop earns is written two bars *before* the passage it
    // belongs to, so pushing a forced drop can put an event earlier than the
    // last retained one. The list is meant to be in time order and
    // `eventsBetween` walks it as if it were, so it is put back in order here.
    this.events.sort((a, b) => a.t - b.t);
    const pushed = this.sections[from.index + 1] as SectionEntry;
    return { name: pushed.section.name, at: pushed.t, bar: pushed.bar, lead: pushed.t - t };
  }

  /** A short line for the HUD. */
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
