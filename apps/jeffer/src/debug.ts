// The shape of the one global the app creates: a diagnostic hook the headless
// smoke test reads (and anyone with the console open can). It lives here so the
// app and the tools agree about it — `main.ts` builds one, `tools/smoke.ts`
// drives it through the page.

import type { OfflineMeasurement, OfflineOptions } from './offline.ts';
import type {
  DescribedPiece,
  DrawOptions,
  ForcedSection,
  PlayerStats,
  Profile,
  RenderStats,
  Seed,
} from './types.ts';

export interface JefferDebug {
  /** The set this page is playing. */
  seed: Seed;
  /** The device profile the set settled on. */
  profile: Profile;
  /** Render the real engine offline and measure the master (see offline.ts). */
  offline(options?: Omit<OfflineOptions, 'profile'>): Promise<OfflineMeasurement>;
  /** Everything one frame of the app knows, for a HUD or a test. */
  stats(): PlayerStats;
  /**
   * The set as it stands at an absolute time on the journey clock. The
   * conductor is pure and time-addressable, so this is the app's own answer for
   * "what was playing at t" — two pages with the same seed describe the same
   * set here, hours in, which is what a seed link promises.
   */
  pieceAt(seconds: number): DescribedPiece;
  /**
   * Arm the sleep timer with an explicit duration. The HUD's smallest step is
   * 15 minutes, which takes 15 minutes to watch; this runs the same path the HUD
   * does (`setSleep`) for anyone — a console, or the smoke test — who wants to
   * see the whole fade, the suspend and the resume in a few seconds.
   */
  armSleep(seconds: number): void;
  /**
   * Cut the passage in progress short and start a new one, now — the same path
   * the HUD's key takes. Returns where the change landed and how far off it is,
   * because "skip to the next passage" is a claim about latency and that is the
   * number a test has to be able to read.
   */
  skipSection(): ForcedSection;
  /**
   * Draw one frame of the real picture at a chosen moment, with the knobs a
   * capture needs — the picture's counterpart to `offline()`. Without a `time`
   * the picture follows the set again. Returns the renderer's stats for the
   * frame drawn.
   */
  draw(options?: DrawOptions): RenderStats;
}

declare global {
  /** Set once, by main.ts. Also reachable as `window.__jeffer`. */
  var __jeffer: JefferDebug | undefined;
}
