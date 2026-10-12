// The scope's data layer, and nothing else. `findTrigger` is the one piece of
// the picture that is a measurement rather than a drawing, and it is the piece
// a fake scope gets wrong: drawn from bin 0 every frame, a trace slides
// sideways and reads as a smear. These tests are what a real scope's trigger
// does, stated as claims.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SCOPE_BINS, SCOPE_ROWS, SPECTRUM_ROW, WAVE_ROW, findTrigger } from '../src/scope.ts';

/** A sine of `cycles` over `length` bins, offset by `dc` so it crosses `dc`. */
function sine(length: number, cycles: number, dc = 0, amplitude = 1): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = dc + amplitude * Math.sin((i / length) * cycles * Math.PI * 2);
  }
  return out;
}

test('the texture is two rows, and the shader reads each one where it was put', () => {
  // The waveform and the spectrum share one 256x2 texture. If these two ever
  // stop being quarter and three-quarter, the two signals bleed into one
  // another and neither is checkable any more.
  assert.equal(SCOPE_BINS, 256);
  assert.equal(SCOPE_ROWS, 2);
  assert.equal(WAVE_ROW, 0.25);
  assert.equal(SPECTRUM_ROW, 0.75);
  assert.ok(WAVE_ROW > 0 && WAVE_ROW < 0.5, 'the wave row must be the upper one');
  assert.ok(SPECTRUM_ROW > 0.5 && SPECTRUM_ROW < 1, 'the spectrum row must be the lower one');
});

test('a signal with no trigger in it is drawn from the start', () => {
  // Silence, a flat line, and a buffer too short to search: all of them say
  // "there is nothing to trigger on", and all of them must not throw or invent
  // a crossing out of the noise floor.
  assert.equal(findTrigger(null), 0);
  assert.equal(findTrigger(undefined), 0);
  assert.equal(findTrigger(new Float32Array(0)), 0);
  assert.equal(findTrigger(new Float32Array(8).fill(0.5)), 0);
  // A little noise is still nothing to trigger on: the search refuses to latch
  // onto the noise floor, because a trace that jumps to a random place every
  // frame is worse than one that does not hold still at all.
  const noise = Float32Array.from({ length: SCOPE_BINS }, (_, i) => ((i * 37) % 11) * 0.0004 - 0.002);
  assert.equal(findTrigger(noise), 0);
});

test('the trigger is the first upward crossing of the signal’s own mean', () => {
  // A sine whose mean is its own offset, so the crossings are findable by hand:
  // the first one after a downward slope is where the trace should start.
  const wave = sine(SCOPE_BINS, 4, 0.25, 0.5);
  let mean = 0;
  for (let i = 0; i < SCOPE_BINS / 2; i++) mean += wave[i] as number;
  mean /= SCOPE_BINS / 2;
  const at = findTrigger(wave);
  assert.ok(at > 0 && at < SCOPE_BINS / 2, `trigger ${at} is not inside the searched half`);
  assert.ok((wave[at - 1] as number) <= mean, 'the sample before the trigger is above the level');
  assert.ok((wave[at] as number) > mean, 'the sample at the trigger is not above the level');
  // Nothing earlier in the buffer qualifies.
  for (let i = 1; i < at; i++) {
    const crossed = (wave[i - 1] as number) <= mean && (wave[i] as number) > mean;
    assert.ok(!crossed, `an earlier crossing at ${i} was skipped`);
  }
});

test('the trigger follows a signal that sits above zero', () => {
  // Electro's bass is well above zero, so a trigger on *zero* would find its
  // crossing on the steepest part of the wave and start the trace in the one  // place a waveform spends least of its time. The mean is the right level, and
  // this is the case that says so: with an offset of 0.6 the mean-crossing and
  // the zero-crossing are in different places, and only one of them is stable.
  const wave = sine(SCOPE_BINS, 6, 0.6, 0.2);
  const at = findTrigger(wave);
  assert.ok(at > 0, 'a signal that never reaches zero still has a trigger');
  let mean = 0;
  for (let i = 0; i < SCOPE_BINS / 2; i++) mean += wave[i] as number;
  mean /= SCOPE_BINS / 2;
  assert.ok((wave[at - 1] as number) <= mean && (wave[at] as number) > mean);
});

test('the trace holds still while the music carries on underneath it', () => {
  // The whole point of a trigger: the same signal, read again, gives the same
  // answer. A scope asked twice about one buffer must not draw two different
  // pictures of it, and neither must the same buffer read through a copy.
  const wave = sine(SCOPE_BINS, 5, 0.1, 0.7);
  const first = findTrigger(wave);
  assert.equal(findTrigger(wave), first);
  assert.equal(findTrigger(Float32Array.from(wave)), first);
  // A plain array of the same numbers is the same signal: the search reads an
  // ArrayLike, because that is what a snapshot handed to a test or a console is.
  assert.equal(findTrigger(Array.from(wave)), first);
  // And a signal rotated to *begin* at a crossing triggers one period later,
  // which is the honest answer: the crossing it began on is bin 0, and the
  // search starts at bin 1. Five cycles over 256 bins is 51.2 bins a period.
  const rotated = new Float32Array(SCOPE_BINS);
  for (let i = 0; i < SCOPE_BINS; i++) rotated[i] = wave[(i + first) % SCOPE_BINS] as number;
  const period = SCOPE_BINS / 5;
  const rotatedAt = findTrigger(rotated);
  assert.ok(
    Math.abs(rotatedAt - period) <= 1,
    `a rotated signal triggered at ${rotatedAt}, not one period (${period.toFixed(1)}) on`,
  );
});
