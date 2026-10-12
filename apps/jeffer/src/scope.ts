// The oscilloscope's data, and the only part of the picture that is measured
// rather than drawn.
//
// It lives here, between `audio/` and `visuals/`, because both halves need it
// and neither should have to know about the other: the engine fills these two
// arrays from its AnalyserNode, the renderer uploads them as a texture and draws
// from it, and neither imports the other's module. It is also where the trigger
// search lives, because a trigger is a property of the signal and not of the
// GPU — and because that makes it testable without a graphics context.

/** How many points the trace is drawn from. Small enough to upload as a
 *  256x2 texture every frame, large enough that the trace has a shape rather
 *  than being a handful of steps. */
export const SCOPE_BINS = 256;

/** The texture is two rows: the waveform on top, the spectrum underneath. */
export const SCOPE_ROWS = 2;

/** Where each row's centre sits in the texture's 0..1 vertical coordinate. The
 *  shader samples at these and nothing else, so the two can never bleed into
 *  one another. */
export const WAVE_ROW = 0.25;
export const SPECTRUM_ROW = 0.75;

/**
 * Where the trace starts, in bins: the first upward crossing of the signal's
 * own mean, searching the first half of the buffer only.
 *
 * A real scope does not begin its sweep at an arbitrary point in the buffer. It
 * waits for the signal to cross its trigger level, and that is the whole reason
 * a trace on a scope stands still while the music carries on underneath it. If
 * the trace is drawn from bin 0 every frame it slides sideways continuously and
 * reads as a smear rather than as a waveform — which is the single most common
 * way a fake scope gives itself away.
 *
 * Half, because the scope shows one window: a trigger found in the second half
 * would start the trace further along than the window being drawn, which is the
 * same as having no trigger at all.
 *
 * The mean, not zero, because this material's bass sits well above zero and a
 * zero-crossing trigger on a signal with an offset finds its crossing on the
 * steepest part of the wave rather than the flattest, which is where a
 * waveform spends least of its time and looks worst.
 *
 * A flat or near-flat signal has no crossing worth finding, so it returns 0 and
 * the trace is simply drawn from the start.
 */
export function findTrigger(wave: ArrayLike<number> | null | undefined): number {
  if (!wave) return 0;
  const half = wave.length >> 1;
  if (half < 4) return 0;
  let mean = 0;
  for (let i = 0; i < half; i++) mean += wave[i] ?? 0;
  mean /= half;
  let peak = 0;
  for (let i = 0; i < half; i++) {
    const d = Math.abs((wave[i] ?? 0) - mean);
    if (d > peak) peak = d;
  }
  // Hunting for a crossing in a signal that has none would latch onto the
  // noise floor, and the trace would jump to a random place every frame.
  if (peak < 0.01) return 0;
  for (let i = 1; i < half; i++) {
    if ((wave[i - 1] ?? 0) <= mean && (wave[i] ?? 0) > mean) return i;
  }
  return 0;
}
