import test from 'node:test';
import assert from 'node:assert/strict';

import { LoudnessMeter, measure, dbToGain, gainToDb } from '../src/audio/loudness.ts';

const FS = 48000;

function sine(freq: number, seconds: number, amplitude: number, sampleRate = FS): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

function stereo(channel: Float32Array): Float32Array[] {
  return [channel, Float32Array.from(channel)];
}

test('a full-scale 1 kHz sine reads -3.01 LUFS (the BS.1770 anchor)', () => {
  const { lufs, truePeakDb } = measure(stereo(sine(1000, 4, 1)), FS);
  assert.ok(Math.abs(lufs - -3.01) < 0.3, `measured ${lufs} LUFS`);
  assert.ok(Math.abs(truePeakDb) < 0.3, `true peak ${truePeakDb} dBTP`);
});

test('20 dB down reads 20 LU down', () => {
  const loud = measure(stereo(sine(1000, 4, 1)), FS).lufs;
  const quiet = measure(stereo(sine(1000, 4, dbToGain(-20))), FS).lufs;
  assert.ok(Math.abs(loud - quiet - 20) < 0.2, `${loud} vs ${quiet}`);
});

test('loudness follows the K-weighting curve', () => {
  // The RLB high-pass means a 40 Hz tone reads well below a 1 kHz one at the
  // same level; the shelf means 10 kHz reads above it.
  const low = measure(stereo(sine(40, 6, 0.5)), FS).lufs;
  const mid = measure(stereo(sine(1000, 6, 0.5)), FS).lufs;
  const high = measure(stereo(sine(10000, 6, 0.5)), FS).lufs;
  assert.ok(low < mid - 3, `40 Hz should be filtered down: ${low} vs ${mid}`);
  assert.ok(high > mid, `10 kHz should be shelved up: ${high} vs ${mid}`);
});

test('silence is not loudness', () => {
  const silent = measure(stereo(new Float32Array(FS * 2)), FS);
  assert.equal(silent.lufs, -Infinity);
  assert.equal(silent.truePeakDb, -Infinity);
});

test('absolute gating ignores the silence around a loud passage', () => {
  const quiet = new Float32Array(FS * 20); // 20 s of digital silence
  const loud = sine(1000, 5, 0.5);
  quiet.set(loud, 0); // 5 s of tone, then silence
  const withSilence = measure(stereo(quiet), FS).lufs;
  const toneOnly = measure(stereo(loud), FS).lufs;
  assert.ok(Math.abs(withSilence - toneOnly) < 0.5, `${withSilence} vs ${toneOnly}`);
});

test('momentary and short-term windows respond to a step', () => {
  const meter = new LoudnessMeter(FS, 2);
  const loud = stereo(sine(1000, 2, 0.5));
  meter.push(loud, loud[0].length, 0);
  const loudLevel = meter.shortTerm();
  const quiet = stereo(new Float32Array(FS * 3));
  meter.push(quiet, quiet[0].length, 0);
  assert.ok(Number.isFinite(loudLevel));
  assert.ok(meter.shortTerm() < loudLevel - 6, 'short-term did not fall with the signal');
});

test('true peak catches inter-sample overshoot', () => {
  // 997 Hz at full scale: the interpolated peaks exceed the sample peaks.
  const meter = new LoudnessMeter(FS, 2);
  const s = stereo(sine(997, 1, 0.99));
  meter.push(s, s[0].length, 0);
  const samplePeakDb = gainToDb(0.99);
  assert.ok(meter.truePeakDb() >= samplePeakDb - 1e-6);
  assert.ok(meter.truePeakDb() <= 0.5, `unexpected true peak ${meter.truePeakDb()}`);
});

test('metering grows with the buffer but stays bounded in memory', () => {
  const meter = new LoudnessMeter(FS, 2);
  const chunk = stereo(sine(440, 1, 0.3, FS));
  for (let i = 0; i < 30; i++) meter.push(chunk, chunk[0].length, 0);
  assert.ok(Number.isFinite(meter.integrated()));
  assert.ok(meter.blocks.length < 400);
});
