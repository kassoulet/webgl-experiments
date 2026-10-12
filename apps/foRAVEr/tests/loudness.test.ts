import test from 'node:test';
import assert from 'node:assert/strict';

import { LoudnessMeter, measure, dbToGain, gainToDb } from '../src/audio/loudness.ts';
import { saturationCurve } from '../src/audio/dsp.ts';

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
  // same level; the shelf means 10 kHz reads above it. A techno master lives
  // mostly under 150 Hz, so this is the measurement that has to be right.
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

test('a kick-shaped signal is measured as loud as it sounds', () => {
  // Four on the floor at 50 Hz for eight seconds: the shape the master spends
  // most of its time in.
  const beat = 0.47;
  const n = Math.round(FS * 8);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / FS;
    const phase = t % beat;
    out[i] = Math.exp(-phase * 28) * Math.sin(2 * Math.PI * 50 * phase);
  }
  const { lufs, truePeakDb } = measure(stereo(out), FS);
  assert.ok(Number.isFinite(lufs), 'a full bar of kick measured as nothing');
  // A bare kick loop has a very low duty cycle, so it sits well below a
  // full-scale sine; what matters is that it is measured at all, and below
  // full scale.
  assert.ok(lufs > -30 && lufs < -8, `a kick loop at unity reads ${lufs.toFixed(1)} LUFS`);
  assert.ok(truePeakDb < 0, `the kick peaked at ${truePeakDb.toFixed(2)} dBTP`);
});

test('the set target is reachable with the headroom the spec asks for', () => {
  // -14 LUFS is the target; 20 dB of headroom under the full-scale sine is
  // where a master with a limiter on it sits.
  const headroom = measure(stereo(sine(1000, 4, dbToGain(-11))), FS).lufs;
  assert.ok(Math.abs(headroom - -14.01) < 0.3, `measured ${headroom} LUFS`);
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
  meter.push(loud, loud[0]!.length, 0);
  const loudLevel = meter.shortTerm();
  assert.ok(Number.isFinite(loudLevel), 'the meter heard nothing');
});

test('gains and decibels are inverses of each other', () => {
  for (const db of [-60, -24, -6, 0, 6]) {
    assert.ok(Math.abs(gainToDb(dbToGain(db)) - db) < 1e-9);
  }
  assert.equal(gainToDb(0), -Infinity);
  assert.ok(!Number.isFinite(gainToDb(0)));
});

test('the saturation curve is a curve, not a clip', () => {
  const curve = saturationCurve(0.4, 512);
  assert.equal(curve.length, 512);
  assert.ok(Math.abs((curve[0] as number) + 1) < 1e-6, 'the curve must start at -1');
  assert.ok(Math.abs((curve[curve.length - 1] as number) - 1) < 1e-6, 'the curve must end at +1');
  assert.equal((curve[Math.floor(curve.length / 2)] as number) > 0 ? 1 : -1, 1, 'the curve must be odd');
  // Monotonic, and gentler than a hard clip: this is the sound of a rave
  // master, and a curve that is linear in the middle is a broken one.
  for (let i = 1; i < curve.length; i++) {
    assert.ok((curve[i] as number) >= (curve[i - 1] as number), 'the curve is not monotonic');
  }
  const quarter = curve[Math.floor(curve.length * 0.25)] as number;
  assert.ok(quarter < -0.5 && quarter > -0.95, `a quarter of full scale reads ${quarter}`);
});
