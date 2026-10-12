// The metering: K-weighted, gated, and the reason the master sits where it does.
//
// The numbers here are the ones the reference was measured with — 126.05 bpm,
// −5.98 LUFS, +6.02 dBTP — and the two deliberate deviations from them are
// written down in `loudness.ts` and asserted here, so that a deviation cannot
// quietly become an accident.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LoudnessMeter,
  TRUE_PEAK_CEILING_DB,
  TARGET_LUFS,
  dbToGain,
  gainToDb,
  measure,
  truePeak,
} from '../src/audio/loudness.ts';

const RATE = 48000;

/** A sine at `db` full scale, long enough to fill several 400 ms blocks. */
function tone(db: number, seconds = 4, rate = RATE): Float32Array {
  const gain = dbToGain(db);
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = gain * Math.sin((i / rate) * 440 * 2 * Math.PI);
  return out;
}

test('the targets are the ones the app documents, and they are deviations', () => {
  // The reference is −5.98 LUFS with +6.02 dBTP peaks. This app deliberately
  // plays ten decibels quieter and a third of a dBTP lower, because an endless
  // set that clips is a set nobody leaves on. Both numbers are claims, so both
  // are asserted.
  assert.equal(TARGET_LUFS, -10.5);
  assert.equal(TRUE_PEAK_CEILING_DB, -0.3);
  assert.ok(TARGET_LUFS < -5.98, 'the target is no quieter than the reference');
  assert.ok(TRUE_PEAK_CEILING_DB < 6.02, 'the ceiling is above the reference’s peaks');
  assert.ok(TRUE_PEAK_CEILING_DB < 0, 'the ceiling does not actually prevent clipping');
});

test('a tone at a known level is measured at that level', () => {
  // A full-scale 440 Hz sine reads about −3.01 dBFS: the K-weighting is close to
  // 0 dB there, and the standard's own offset is −0.691. If this drifts, the
  // feedback loop is steering on a number that is not loudness.
  const full = measure([tone(0)], RATE);
  assert.ok(Math.abs(full.lufs - -3.01) < 0.5, `a full-scale sine read ${full.lufs.toFixed(2)} LUFS`);
  // Ten decibels down is ten decibels down, and the measurement is a ratio.
  const quiet = measure([tone(-20)], RATE);
  assert.ok(
    Math.abs((full.lufs - quiet.lufs) - 20) < 0.5,
    `−20 dBFS read ${quiet.lufs.toFixed(2)}, ${(full.lufs - quiet.lufs).toFixed(2)} below full scale`,
  );
  assert.ok(quiet.blocks > 4, `${quiet.blocks} blocks is not enough to gate on`);
});

test('silence is gated out, not reported as very quiet', () => {
  // The absolute gate is what keeps a set's quiet passages from dragging its
  // average down. Silence measures as silence: no blocks, and an answer that is
  // not a number.
  const silent = measure([new Float32Array(RATE * 2)], RATE);
  assert.equal(silent.blocks, 0, 'silence produced gated blocks');
  assert.ok(!Number.isFinite(silent.lufs), `silence measured ${silent.lufs} LUFS`);
  assert.ok(!Number.isFinite(silent.peakDb), `silence peaked at ${silent.peakDb} dBFS`);
});

test('true peak is above sample peak, and is where the ceiling is checked', () => {
  // Inter-sample peaks are the reason a −1 dBFS square-ish signal overshoots, and
  // the ceiling is on *this* number rather than on the samples.
  const rate = RATE;
  const out = new Float32Array(rate);
  for (let i = 0; i < out.length; i++) out[i] = 0.7 * Math.sign(Math.sin((i / rate) * 440 * 2 * Math.PI));
  const samplePeak = measure([out], RATE).peakDb;
  const interSample = truePeak([out]);
  assert.ok(interSample > samplePeak, `true peak ${interSample} is not above the sample peak ${samplePeak}`);
  // 0.7 as a square wave is −3 dBFS at the samples and *above* 0 dBTP between
  // them. That gap is the whole reason the ceiling is checked on this number and
  // not on the samples: a set that measures −3 dBFS everywhere still clips.
  assert.ok(interSample > 0, `a 0.7 square reads ${interSample.toFixed(2)} dBTP, which is not above full scale`);

  // And the ceiling is a real bound: a set measured under it is a set that
  // survives an encoder.
  const hot = measure([tone(-1)], RATE);
  assert.ok(hot.truePeakDb <= TRUE_PEAK_CEILING_DB + 3, `a −1 dBFS tone peaks at ${hot.truePeakDb.toFixed(2)} dBTP`);
});

test('the running meter agrees with the batch measurement', () => {
  // The engine steers on the meter; the offline render reports the batch
  // measurement. If they disagree, the app is levelling towards something it is
  // not measuring, and the two numbers in the HUD are both lies.
  const pcm = tone(-12, 6);
  const meter = new LoudnessMeter(RATE, 2);
  assert.ok(!Number.isFinite(meter.shortTerm()), 'the meter answered before it had heard anything');
  // Pushed in 1024-sample blocks, as the worklet does.
  for (let at = 0; at + 1024 <= pcm.length; at += 1024) meter.push(pcm.subarray(at, at + 1024), 1024, 0);
  const batch = measure([pcm], RATE);
  const shortTerm = meter.shortTerm();
  assert.ok(Number.isFinite(shortTerm), 'six seconds of tone and the meter has nothing');
  assert.ok(
    Math.abs(shortTerm - batch.lufs) < 1.5,
    `the running meter read ${shortTerm.toFixed(2)} where the batch read ${batch.lufs.toFixed(2)}`,
  );
  assert.ok(meter.blocks.length >= 8, `${meter.blocks.length} blocks in six seconds`);
  assert.ok(meter.blocks.length <= 64, 'the meter kept every block it has ever seen');
  assert.ok(Number.isFinite(meter.truePeakDb()) && meter.truePeakDb() <= 0, 'a −12 dBFS tone is clipping');
});

test('the meter is a function of what it was given, in pieces and in one go', () => {
  // The same audio, chunked differently, has to measure the same: the worklet
  // hands over 1024 samples at a time and nothing else guarantees a boundary.
  const pcm = tone(-8, 5);
  const whole = new LoudnessMeter(RATE, 2);
  whole.push(pcm, pcm.length, 0);
  const chunked = new LoudnessMeter(RATE, 2);
  for (let at = 0; at + 512 <= pcm.length; at += 512) chunked.push(pcm.subarray(at, at + 512), 512, 0);
  assert.ok(
    Math.abs(whole.shortTerm() - chunked.shortTerm()) < 0.5,
    `${whole.shortTerm().toFixed(2)} in one push, ${chunked.shortTerm().toFixed(2)} in 512s`,
  );
});

test('decibels and gains are the same number, both ways', () => {
  assert.ok(Math.abs(dbToGain(0) - 1) < 1e-12);
  assert.ok(Math.abs(gainToDb(dbToGain(-6)) - -6) < 1e-9);
  assert.ok(Math.abs(dbToGain(-6) - 0.5012) < 1e-3, '−6 dB is half amplitude, not half power');
  assert.equal(gainToDb(0), Number.NEGATIVE_INFINITY);
});
