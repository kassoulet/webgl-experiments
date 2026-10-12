// The Conductor: the long-horizon state both the audio and the picture read
// (spec §5). Key, mode, the current chord and the next one, the mood, and when
// the far-away events happen. Seeded, so a journey can be reproduced.
//
// It is pure and time-addressable: `ensure(t)` extends the schedule forward and
// `stateAt(t)` answers for any t the schedule covers. Audio schedules ahead (a
// few seconds), visuals read the present, and both see the same journey because
// the schedule is only ever appended in order.
//
// Each entry carries its own `hold`: the seconds until the next entry of that
// kind. Queries never draw random numbers, so asking for a time twice can never
// change it.

import { Rng } from './rng.ts';
import { fbm1, wander } from './noise.ts';
import {
  MODES,
  MODE_NAMES,
  DRONE_REGISTER,
  buildChord,
  keyName,
  midiToHz,
  modulate,
  nextDegree,
  pickShape,
  voiceLead,
} from './harmony.ts';
import { paletteAt } from './palette.ts';
import type {
  Camera,
  ChordAt,
  ChordEntry,
  ConductorState,
  DescribedPiece,
  Drift,
  EventParams,
  EventType,
  Flare,
  Levels,
  Mood,
  MoodBlend,
  PieceEvent,
  SectionAt,
  SectionEntry,
  Seed,
  Span,
} from './types.ts';

/** Moods are the piece's slow weather. They never cut: the audio crossfades
 *  between two moods over `MOOD_FADE` seconds, and the picture leans on the same
 *  numbers (brightness, warp). */
export const MOODS: Mood[] = [
  {
    name: 'void',
    density: 0.30, brightness: 0.42, drone: 1.00, pad: 0.45, scape: 0.70, shimmer: 0.32,
    warmth: 0.85, motion: 0.5, warp: 1.30, grains: 0.45, march: 0.75,
    chord: [40, 90], section: [240, 600], event: [55, 140],
  },
  {
    name: 'drift',
    density: 0.65, brightness: 0.60, drone: 1.00, pad: 0.65, scape: 0.55, shimmer: 0.50,
    warmth: 1.00, motion: 0.8, warp: 1.00, grains: 0.75, march: 0.9,
    chord: [30, 80], section: [240, 540], event: [50, 120],
  },
  {
    name: 'dawning',
    density: 0.85, brightness: 0.86, drone: 0.62, pad: 0.95, scape: 0.50, shimmer: 0.70,
    warmth: 1.12, motion: 0.75, warp: 0.90, grains: 1.10, march: 1.1,
    chord: [20, 60], section: [200, 480], event: [40, 100],
  },
  {
    name: 'coalescence',
    density: 1.10, brightness: 0.95, drone: 0.70, pad: 1.00, scape: 0.40, shimmer: 0.85,
    warmth: 1.15, motion: 1.05, warp: 1.45, grains: 1.35, march: 1.3,
    chord: [20, 50], section: [180, 420], event: [35, 90],
  },
  {
    name: 'deep field',
    density: 0.50, brightness: 0.32, drone: 1.15, pad: 0.50, scape: 0.80, shimmer: 0.26,
    warmth: 0.80, motion: 0.4, warp: 1.05, grains: 0.60, march: 0.6,
    chord: [45, 90], section: [280, 620], event: [70, 160],
  },
];

export const moodByName = (name: string): Mood => MOODS.find((m) => m.name === name) ?? (MOODS[1] as Mood);

export const EVENT_TYPES: EventType[] = ['distantTone', 'risingSweep', 'shimmerBurst', 'dustCloud', 'farBell'];

const CHORD_FADE = 6; // seconds a chord takes to settle (the audio crossfades longer)
const MOOD_FADE = 25; // seconds a mood takes to take over
/** Seconds a lit star takes to come up: the event's answer is never a flash
 *  (spec §3 "Slow and continuous ... no flashes"). */
const FLARE_RISE = 2.5;

/**
 * Where in the sky an event lights its star. The event already carries a pan and
 * an offset for the sound, so the star comes up on the same side as the sound:
 * a far-away tone on the left lights a star to the left. Deterministic — two
 * pages with the same seed put the star in the same place.
 */
function flareDirection(event: PieceEvent): [number, number, number] {
  const azimuth = event.params.pan * Math.PI * 1.4;
  const elevation = event.params.offset * 0.55;
  const ce = Math.cos(elevation);
  return [ce * Math.sin(azimuth), Math.sin(elevation), ce * Math.cos(azimuth)];
}

export class Conductor {
  readonly seed: Seed;

  private readonly rng: Rng;
  private readonly chordRng: Rng;
  private readonly shapeRng: Rng;
  private readonly sectionRng: Rng;
  private readonly moodRng: Rng;
  private readonly eventRng: Rng;
  private readonly keyRng: Rng;
  private readonly noiseSeed: number;

  readonly chords: ChordEntry[] = [];
  readonly sections: SectionEntry[] = [];
  readonly events: PieceEvent[] = [];

  key: { rootPc: number; modeName: string };

  /** Written by the audio engine every frame (spec §5: "levels, events (shared
   *  memory)"). Defaults let the picture run before — or without — the audio. */
  readonly levels: Levels = { pad: 0.5, drone: 0.75, scape: 0.5, shimmer: 0.35, brightness: 0.55, peak: 0.4 };

  private readonly firstEventGap: number;
  private chordCursor = 0;
  private sectionCursor = 0;
  /** How far ahead the schedule has been extended by `ensure`. */
  scheduled = -1;

  constructor(seed: Seed) {
    this.seed = seed;
    this.rng = new Rng(seed);
    const r = this.rng.fork('streams');
    this.chordRng = r.fork('chords');
    this.shapeRng = r.fork('shapes');
    this.sectionRng = r.fork('sections');
    this.moodRng = r.fork('moods');
    this.eventRng = r.fork('events');
    this.keyRng = r.fork('keys');
    this.noiseSeed = r.fork('drift').int(100000);

    this.key = {
      rootPc: this.keyRng.int(12),
      modeName: this.keyRng.pick(['aeolian', 'dorian', 'phrygian', 'lydian', 'mixolydian']),
    };

    this.firstEventGap = this.eventRng.range(25, 70);
    this.ensure(0);
  }

  /** Extend the schedule to cover time `t`, plus one entry beyond of every
   *  kind: a query needs to see the *next* chord, not only the current one.
   *
   *  Every list is generated in increasing time order from its own stream, and
   *  every entry depends only on earlier entries in that list, so the schedule
   *  is a function of the seed alone — not of when or in what order it is asked
   *  for. (That is what lets the audio scheduler and the renderer share it.) */
  ensure(t: number): void {
    if (this.scheduled >= t) return;
    const target = Math.max(t, 0);
    // "Until the last one starts after target": that is what puts one entry
    // beyond target in the list, where a query can see it as the next change.
    while (this.sections.length === 0 || (this.sections[this.sections.length - 1] as SectionEntry).t <= target) {
      this.#pushSection(this.#nextSectionTime());
    }
    while (this.chords.length === 0 || (this.chords[this.chords.length - 1] as ChordEntry).t <= target) {
      const at = this.#nextChordTime();
      this.#coverSections(at);
      this.#pushChord(at);
    }
    while (this.#nextEventTime() <= target) {
      const at = this.#nextEventTime();
      this.#coverSections(at);
      this.#pushEvent(at);
    }
    this.scheduled = Math.max(this.scheduled, target);
  }

  /** The mood in force at `t`, so an entry's weather is the same no matter what
   *  has been generated since. */
  #moodAtTime(t: number): Mood {
    let mood = MOODS[1] as Mood;
    for (const section of this.sections) {
      if (section.t > t) break;
      mood = section.mood;
    }
    return mood;
  }

  /** Sections are generated first so that a chord or an event starting at `t`
   *  reads the weather it will actually be under. */
  #coverSections(t: number): void {
    while (this.#nextSectionTime() <= t) this.#pushSection(this.#nextSectionTime());
  }

  #nextSectionTime(): number {
    const last = this.sections[this.sections.length - 1];
    return last ? last.t + last.hold : 0;
  }

  #nextChordTime(): number {
    const last = this.chords[this.chords.length - 1];
    return last ? last.t + last.hold : 0;
  }

  #nextEventTime(): number {
    const last = this.events[this.events.length - 1];
    return last ? last.t + last.hold : this.firstEventGap;
  }

  #pushSection(t: number): void {
    const previous = this.sections[this.sections.length - 1];
    let mood: Mood;
    if (!previous) {
      mood = this.moodRng.pick(MOODS);
    } else {
      const i = MOODS.indexOf(previous.mood);
      // Weather drifts to a neighbouring mood most of the time.
      mood = this.moodRng.chance(0.7)
        ? (MOODS[Math.min(MOODS.length - 1, Math.max(0, i + (this.moodRng.chance(0.5) ? 1 : -1)))] as Mood)
        : this.moodRng.pick(MOODS.filter((m) => m !== previous.mood));
    }
    if (previous && this.moodRng.chance(0.55)) {
      this.key = modulate(this.keyRng, this.key);
    }
    this.sections.push({
      t,
      mood,
      previous: previous ? previous.mood : mood,
      hold: this.sectionRng.range(mood.section[0], mood.section[1]),
    });
  }

  #pushChord(t: number): void {
    const mood = this.#moodAtTime(t);
    const previous = this.chords[this.chords.length - 1];
    const degree = previous ? nextDegree(this.chordRng, previous.chord.degree) : this.chordRng.int(7);
    const shape = pickShape(this.shapeRng, MODES[this.key.modeName]?.flavour ?? 'melancholy');
    const chord = buildChord({ rootPc: this.key.rootPc, modeName: this.key.modeName, degree, shape });
    const voicing = voiceLead(previous ? previous.voicing : [], chord.pcs);
    // Drones sit below the pads: root and fifth, which the engine also takes an
    // octave down for the sub.
    const droneNotes = [chord.pcs[0] as number, chord.pcs[2] ?? (chord.pcs[0] as number)];
    const drone = voiceLead(previous ? previous.drone : [], droneNotes, DRONE_REGISTER);
    this.chords.push({ t, chord, voicing, drone, hold: this.chordRng.range(mood.chord[0], mood.chord[1]) });
  }

  #pushEvent(t: number): void {
    const mood = this.#moodAtTime(t);
    const type = this.eventRng.pick(EVENT_TYPES);
    const params: EventParams = {
      level: this.eventRng.range(0.6, 1),
      brightness: mood.brightness,
      offset: this.eventRng.signed(),
      interval: this.eventRng.pick([0, 3, 4, 5, 7, 10]),
      pan: this.eventRng.signed() * 0.7,
      duration: 0,
    };
    // Drawn after the rest, as it always has been: the order is part of the seed.
    params.duration = type === 'risingSweep' ? this.eventRng.range(14, 36) : this.eventRng.range(6, 26);
    // The gap is at least the event's own length plus a breath of quiet. That is
    // not decoration: a lit star has to finish fading before the next event can
    // light another, or the sky would swap one bright star for another in a
    // single frame — a cut, which §3 rules out.
    const hold = Math.max(
      this.eventRng.range(mood.event[0], mood.event[1]),
      params.duration + 2,
    );
    this.events.push({ t, type, params, hold });
  }

  // --- queries ---------------------------------------------------------------

  #cursorFor<T extends { t: number }>(list: readonly T[], cursor: number, t: number): number {
    let i = Math.min(Math.max(cursor, 0), list.length - 1);
    while (i + 1 < list.length && (list[i + 1] as T).t <= t) i++;
    while (i > 0 && (list[i] as T).t > t) i--;
    return i;
  }

  chordAt(t: number): ChordAt {
    const i = this.#cursorFor(this.chords, this.chordCursor, t);
    if (t >= (this.chords[0] as ChordEntry).t) this.chordCursor = i;
    const entry = this.chords[i] as ChordEntry;
    const next = this.chords[i + 1] ?? entry;
    const span = Math.max(1e-6, next.t - entry.t);
    const progress = entry === next ? 1 : Math.min(1, Math.max(0, (t - entry.t) / span));
    return { index: i, entry, next, progress, hold: entry.hold, chordTime: t - entry.t };
  }

  sectionAt(t: number): SectionAt {
    const i = this.#cursorFor(this.sections, this.sectionCursor, t);
    if (t >= (this.sections[0] as SectionEntry).t) this.sectionCursor = i;
    const entry = this.sections[i] as SectionEntry;
    const next = this.sections[i + 1] ?? entry;
    const span = Math.max(1e-6, next.t - entry.t);
    const progress = entry === next ? 1 : Math.min(1, Math.max(0, (t - entry.t) / span));
    return { index: i, entry, next, progress, moodTime: t - entry.t };
  }

  /** The mood being faded from, and how far the fade has come. Audio uses this
   *  to crossfade weather instead of switching it. */
  moodBlend(t: number): MoodBlend {
    const s = this.sectionAt(t);
    const fade = Math.min(1, Math.max(0, (t - s.entry.t) / MOOD_FADE));
    return { mood: s.entry.mood, previous: s.entry.previous, fade, progress: s.progress };
  }

  /** Events with t in (from, to]. The audio scheduler consumes them in order. */
  eventsBetween(from: number, to: number): PieceEvent[] {
    return this.events.filter((e) => e.t > from && e.t <= to);
  }

  /**
   * The far-away event lighting a star at t, or null between events (spec §3
   * "far-away sound events can light a distant star"). The envelope rises over
   * `FLARE_RISE` seconds and fades over the rest of the event's own duration, so
   * the sky answers the sound without anything ever flashing. Pure: the same t
   * always gives the same star.
   */
  #flare(t: number): Flare | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const event = this.events[i] as PieceEvent;
      if (event.t > t) continue;
      const age = t - event.t;
      if (age >= event.params.duration) break; // this one has faded; so has every older one
      const rise = Math.min(1, age / Math.min(FLARE_RISE, event.params.duration * 0.4));
      const smooth = rise * rise * (3 - 2 * rise);
      const level = event.params.level * smooth * (1 - age / event.params.duration);
      // At the instant the event starts the star is only just coming up, and
      // "nothing is lit" is the honest answer (as it is between events).
      return level > 0 ? { level, dir: flareDirection(event) } : null;
    }
    return null;
  }

  flareAt(t: number): Flare | null {
    this.ensure(t);
    return this.#flare(t);
  }

  /** Slow parameter wander, free of jumps: the same t always gives the same
   *  values, so audio and picture cannot disagree. */
  drift(t: number): Drift {
    const n = this.noiseSeed;
    return {
      brightness: fbm1(t / 420, 3, n + 11),
      warp: wander(t, 300, 1, 0.45, n + 23),
      motion: wander(t, 520, 1, 0.35, n + 31),
      density: wander(t, 260, 1, 0.3, n + 47),
      shimmer: wander(t, 350, 1, 0.35, n + 53),
      detune: wander(t, 180, 1, 0.5, n + 61),
    };
  }

  /** A slow, continuous camera path: minutes to cross a nebula, no cuts. */
  camera(t: number): Camera {
    const n = this.noiseSeed;
    return {
      position: [
        (fbm1(t / 190, 2, n + 71) * 2 - 1) * 1.6,
        (fbm1(t / 240, 2, n + 79) * 2 - 1) * 0.55,
        (fbm1(t / 170, 2, n + 83) * 2 - 1) * 1.6,
      ],
      yaw: wander(t, 260, 0, 1.1, n + 89, 2),
      pitch: wander(t, 340, 0, 0.22, n + 97, 2),
    };
  }

  cameraAt(t: number): Camera {
    this.ensure(t);
    return this.camera(t);
  }

  /** Everything one frame needs, in one object. */
  stateAt(t: number): ConductorState {
    this.ensure(t);
    const c = this.chordAt(t);
    const s = this.sectionAt(t);
    const blend = this.moodBlend(t);
    const drift = this.drift(t);
    const palette = paletteAt({
      chord: c.entry.chord,
      nextChord: c.next.chord,
      progress: c.progress,
      mood: blend.mood,
      previousMood: blend.previous,
      moodBlend: blend.fade,
    });
    return {
      t,
      seed: this.seed,
      key: this.key,
      keyName: keyName(this.key),
      chord: c.entry.chord,
      nextChord: c.next.chord,
      voicing: c.entry.voicing,
      droneHz: c.entry.drone.map(midiToHz),
      chordProgress: c.progress,
      chordFade: Math.min(1, Math.max(0, (t - c.entry.t) / CHORD_FADE)),
      chordTime: c.chordTime,
      mood: blend.mood,
      previousMood: blend.previous,
      moodBlend: blend.fade,
      moodProgress: s.progress,
      drift,
      palette,
      levels: this.levels,
      flare: this.#flare(t),
    };
  }

  /** Force a section (mood) change at or just after `t`. Returns the new mood name. */
  forceNextSection(t: number): string {
    this.ensure(t);
    const at = Math.max(t, this.#nextSectionTime());
    this.#coverSections(at + 0.1);
    this.#pushSection(at + 0.1);
    this.scheduled = Math.max(this.scheduled, at + 0.1);
    const newMood = this.sections[this.sections.length - 1].mood.name;
    return newMood;
  }

  /** A short line for the UI. */
  describe(t: number): DescribedPiece {
    const state = this.stateAt(t);
    const mins = Math.floor(state.chordTime / 60);
    const secs = Math.floor(state.chordTime % 60);
    return {
      key: state.keyName,
      chord: state.chord.name,
      next: state.nextChord.name,
      mood: state.mood.name,
      held: mins > 0 ? `${mins}m${String(secs).padStart(2, '0')}s` : `${secs}s`,
      palette: state.palette.name,
    };
  }
}

/** Pitch classes of a state's key, for pads and drones to lean on. */
export function keyPitchClasses(state: ConductorState): number[] {
  const mode = MODES[state.key.modeName] ?? MODES.aeolian;
  return (mode?.intervals ?? []).map((iv) => (state.key.rootPc + iv) % 12);
}

export { MODE_NAMES };
export type { Span };
