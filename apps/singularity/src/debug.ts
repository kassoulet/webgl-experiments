// The shape of the one global the app creates: a diagnostic hook the headless
// smoke test reads (and anyone with the console open can). It lives here so the
// app and the tools agree about it — `main.ts` builds one, `tools/smoke.ts`
// drives it through the page.

import type { OfflineMeasurement, OfflineOptions } from './offline.ts';
import type { Camera, DescribedPiece, Flare, PlayerStats, Profile, RenderStats, Seed } from './types.ts';

/**
 * What a diagnostic draw may hold still. Everything else comes from the
 * conductor, exactly as the app asks for it — this is the same shader, the same
 * state and the same camera, with a few numbers chosen instead of measured.
 */
export interface DrawOptions {
  /**
   * A moment in the journey, in seconds. Given one, the picture is pinned there
   * (the frame loop redraws that same moment) so a capture cannot race it. Call
   * `draw()` again with no `time` to follow the journey once more.
   */
  time?: number;
  /** A camera to look from, over the conductor's own drift. */
  camera?: Camera;
  /** Star layers, 0–3. 0 is a starless sky, Milky Way included. */
  stars?: number;
  /** Nebula density. 0 leaves the sky empty but for the stars. */
  density?: number;
  /** Force the volumetric march, or the 2D layered fallback. */
  volumetric?: boolean;
  /** 0..1, over the brightness the audio asks for. */
  brightness?: number;
  /** How bright the picture is (the sleep fade); 1 by default. */
  dim?: number;
  /** Force a lit star's brightness, to capture the sky with and without one. */
  flare?: number;
}

export interface SingularityDebug {
  /** The journey this page is playing. */
  seed: Seed;
  /** The device profile the piece settled on. */
  profile: Profile;
  /** Render the real engine offline and measure the master (see offline.ts). */
  offline(options?: Omit<OfflineOptions, 'profile'>): Promise<OfflineMeasurement>;
  /** Everything one frame of the app knows, for a HUD or a test. */
  stats(): PlayerStats;
  /**
   * The piece as it stands at an absolute time on the journey clock. The
   * conductor is pure and time-addressable, so this is the app's own answer for
   * "what was playing at t" — two pages with the same seed describe the same
   * piece here, hours in, which is what a seed link promises.
   */
  pieceAt(seconds: number): DescribedPiece;
  /**
   * Whether a far-away event is lighting a star at an absolute time, and which
   * way. The audio scheduler sees events as they come; this is how a capture can
   * find a moment when the sky is answering one (spec §3).
   */
  flareAt(seconds: number): Flare | null;
  /**
   * Arm the sleep timer with an explicit duration. The HUD's smallest step is
   * 15 minutes, which takes 15 minutes to watch; this runs the same path the
   * HUD does (`setSleep`) for anyone — a console, or the smoke test — who wants
   * to see the whole fade, the suspend and the resume in a few seconds.
   */
  armSleep(seconds: number): void;
  /**
   * Draw one frame of the real picture at a chosen moment, with the knobs a
   * capture needs — the picture's counterpart to `offline()`, which renders the
   * real engine and measures the samples. Without a `time` the picture follows
   * the journey again. Returns the renderer's own stats for the frame drawn.
   */
  draw(options?: DrawOptions): RenderStats;
}

declare global {
  /** Set once, by main.ts. Also reachable as `window.__singularity`. */
  var __singularity: SingularityDebug | undefined;
}
