// The drum and synth patterns, and how they are chosen.
//
// This is the one part of the app that is a *function* rather than a schedule:
// a pattern is looked up from `(seed, section, phrase, instrument)` and nowhere
// else, so asking for the pattern of bar 900 after having asked for bar 9000
// gives the same sixteen steps back. That is what lets the audio scheduler and
// the picture agree about a bar without either of them owning a list.
//
// The vocabulary is a hand-written bank of sixteen-step templates, because a
// uniformly random pattern is noise and a techno pattern is not. Generosity
// comes from which template is drawn, from the ghosts layered on top, and from
// the fills — not from the sixteen steps themselves.

import { hashUnit } from '@fractal-rave/shared';

/** `x` an accent, `o` a normal hit, `.` a rest. Sixteen characters, always. */
type Template = string;

const KICK: Template[] = [
  'x...x...x...x...',
  'x...x...x...x.o.',
  'x..xx...x...x...',
  'x...x..xx...x...',
  'x...x...x...x..o',
  'x...x...x..xx...',
];

const BASS: Template[] = [
  'x.x.x.x.x.x.x.x.',
  'x..x..x.x..x.x.',
  'x.xx..x.x.xx..x',
  'x...x.xx..x.x..',
  'x.x..x..x.x..xx',
  'x..x.x..x.x.x.x.',
  'x.x.x.x.x.xx.xxx',
];

const HAT: Template[] = [
  'o.o.o.o.o.o.o.o.',
  'oo.oo.oo.oo.oo.o',
  'o.ooo.oo.o.ooo.o',
  'o.o.o.o.oo.o.o.o',
  'ooxoooxoooxoooxoo',
  '..o...o...o...o.',
  'o.oo.ooo.o.oo.oo',
];

const CLAP: Template[] = [
  '....x.......x...',
  '....o...o...o...',
  '....x...x...x...',
  '....x.......x.o.',
  '....x...x.......',
  '..o.x.......x...',
];

const PERC: Template[] = [
  '..x..x...x..x...',
  '.x..x..x.x..x..x',
  'x..x..x...x..x..',
  '...x...x.x...x.',
  '.x...x...x...x..',
  'x...x.x...x.x...',
];

const STAB: Template[] = [
  '..x...x...x.....',
  '..x..x..x..x..x.',
  '..x.....x.....x.',
  '....x...x...x...',
  '..x...x.........',
  '..o...o...o...o.',
];

const ARP: Template[] = [
  'x.x.x.x.x.x.x.x.',
  'x..xx..xx..xx..x',
  'x.xxx.xxx.xxx.xx',
  'xxxxxxxxxxxxxxxx',
  'x.xx.xxx.xx.xxx.',
  'x..x..x.x..x..xx',
  'xxx.x.xxx.x.xxx.',
];

const BANKS = { kick: KICK, bass: BASS, hat: HAT, clap: CLAP, perc: PERC, stab: STAB, arp: ARP } as const;

export type Instrument = keyof typeof BANKS;

export const INSTRUMENTS = Object.keys(BANKS) as Instrument[];

/** How many chord tones a synth voice may reach into. */
export const VOICE_TONES = 4;

export const STEP_COUNT = 16;

/**
 * One instrument over one bar. `velocity` is 0..255 (the engine divides by 255)
 * and `tone` is an index into the chord the conductor currently holds, or 255
 * for "no note here" — which is how a synth layer says nothing.
 */
export interface StepPattern {
  velocity: Uint8Array;
  tone: Uint8Array;
}

/** Every instrument's bar. One object per bar, freshly built, never stored. */
export interface BarPatterns {
  kick: StepPattern;
  bass: StepPattern;
  hat: StepPattern;
  clap: StepPattern;
  perc: StepPattern;
  stab: StepPattern;
  arp: StepPattern;
  /** True when this bar carries a fill: the last bar of a phrase, or the last
   *  bar before a section that wants one. */
  fill: boolean;
  /** The phrase this bar belongs to, so two bars of a phrase look alike. */
  phrase: number;
}

const NO_TONE = 255;

const ACCENT = 235;
const NORMAL = 150;
const GHOST = 105;

function parseTemplate(template: Template, tone: (step: number) => number): StepPattern {
  const velocity = new Uint8Array(STEP_COUNT);
  const tones = new Uint8Array(STEP_COUNT).fill(NO_TONE);
  for (let step = 0; step < STEP_COUNT; step++) {
    const mark = template.charAt(step);
    if (mark === 'x') velocity[step] = ACCENT;
    else if (mark === 'o') velocity[step] = NORMAL;
    else continue;
    tones[step] = tone(step);
  }
  return { velocity, tone: tones };
}

/**
 * How a synth line walks the chord. Chosen per phrase, so an arp holds its
 * shape for four bars and then finds a new one.
 */
function contourFor(seed: number, section: number, phrase: number, count: number): number[] {
  const shape = Math.floor(hashUnit(seed, section, phrase, 991) * 4);
  const contour: number[] = [];
  for (let i = 0; i < count; i++) {
    switch (shape) {
      case 0: contour.push(i % count); break;                    // up
      case 1: contour.push((count - 1 - i) % count); break;      // down
      case 2: contour.push(triangle(i, count)); break;           // up and back
      default: contour.push(Math.floor(hashUnit(seed, section, phrase, 1200 + i) * count) % count); break;
    }
  }
  return contour;
}

const triangle = (i: number, n: number): number => {
  const period = Math.max(1, n - 1) * 2;
  const at = i % period;
  return (at < n ? at : period - at) % n;
};

/**
 * A ghost note: a rest becomes a quiet hit. This is where the variety comes
 * from — the template stays recognisable for the whole phrase, and the ghosts
 * are drawn per *bar*, so four bars of the same template are four slightly
 * different bars rather than one bar played four times.
 */
function addGhosts(
  pattern: StepPattern,
  seed: number,
  section: number,
  bar: number,
  tag: number,
  probability: number,
  tone: (step: number) => number,
): void {
  for (let step = 0; step < STEP_COUNT; step++) {
    if (pattern.velocity[step] !== 0) continue;
    if (hashUnit(seed, section, bar, tag * 31 + step) > probability) continue;
    pattern.velocity[step] = GHOST;
    pattern.tone[step] = tone(step);
  }
}

/**
 * A fill: the backbeat turns into a roll. Applied to a bar, it is the last four
 * steps filling with hits of rising velocity — the oldest trick in techno and
 * still the best way to tell a listener the drop is two seconds away.
 */
function applyFill(pattern: StepPattern, from: number, tag: number, seed: number, phrase: number): void {
  const hits = 2 + (Math.floor(hashUnit(seed, phrase, tag, 41) * 3) % 3);
  const span = STEP_COUNT - from;
  for (let i = 0; i < hits; i++) {
    const step = from + Math.floor(((i + 1) / (hits + 1)) * span);
    if (step < 0 || step >= STEP_COUNT) continue;
    pattern.velocity[step] = GHOST + Math.floor(((i + 1) / hits) * (ACCENT - GHOST));
    if (pattern.tone[step] === NO_TONE) pattern.tone[step] = 0;
  }
}

/**
 * Is this the bar that fills? The last bar of every four-bar phrase, and that is
 * all — because every passage is 8, 16, 24 or 32 bars long, so the last bar of
 * a passage is always the last bar of a phrase too. A drop is therefore always
 * announced, without this function having to guess what is coming next: it
 * cannot know, and a guess made from the section's list of *possibilities* is
 * how six drops in seven ended up with no riser in front of them.
 */
export function isFillBar(bar: number): boolean {
  return ((bar % 4) + 4) % 4 === 3;
}

/**
 * Every instrument's pattern for one bar.
 *
 * `bar` is the absolute bar number and `sectionIndex` says which passage of the
 * set it falls in, which is what separates a breakdown's hats from a drop's.
 * Nothing here reads a clock or a stream, so the same arguments always give the
 * same bar — which is the whole contract the scheduler relies on.
 */
export function patternsFor(seed: number, bar: number, sectionIndex: number): BarPatterns {
  const phrase = Math.floor(bar / 4);
  const fill = isFillBar(bar);

  const draw = (instrument: Instrument, bank: readonly Template[]): string => {
    const at = INSTRUMENTS.indexOf(instrument);
    const pick = Math.floor(hashUnit(seed, sectionIndex, phrase, 7 + at * 13) * bank.length) % bank.length;
    return bank[pick] as string;
  };

  const rootTone = (): number => 0;

  const stabContour = contourFor(seed, sectionIndex, phrase, 2);
  const stabTone = (step: number): number => stabContour[step % stabContour.length] as number;
  const arpContour = contourFor(seed, sectionIndex, phrase, VOICE_TONES);
  const arpTone = (step: number): number => arpContour[step % arpContour.length] as number;

  const build = (instrument: Instrument, tone: (step: number) => number): StepPattern =>
    parseTemplate(draw(instrument, BANKS[instrument]), tone);

  const kick = build('kick', rootTone);
  const bass = build('bass', rootTone);
  const hat = build('hat', rootTone);
  const clap = build('clap', rootTone);
  const perc = build('perc', rootTone);
  const stab = build('stab', stabTone);
  const arp = build('arp', arpTone);

  addGhosts(kick, seed, sectionIndex, bar, 1, 0.06, rootTone);
  addGhosts(bass, seed, sectionIndex, bar, 2, 0.1, rootTone);
  addGhosts(hat, seed, sectionIndex, bar, 3, 0.14, rootTone);
  addGhosts(perc, seed, sectionIndex, bar, 4, 0.12, rootTone);
  addGhosts(stab, seed, sectionIndex, bar, 5, 0.07, stabTone);

  if (fill) {
    applyFill(clap, 8, 3, seed, phrase);
    applyFill(hat, 8, 4, seed, phrase);
    // The bass gets a run into the change, which is what makes a transition
    // sound like one rather than like the drums simply stopping.
    applyFill(bass, 8, 5, seed, phrase);
  }

  return { kick, bass, hat, clap, perc, stab, arp, fill, phrase };
}
