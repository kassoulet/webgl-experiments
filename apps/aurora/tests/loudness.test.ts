import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dbToGain, gainToDb } from '../src/audio/loudness.ts';
import { clamp, saturationCurve, createNoiseBuffer, createReverbImpulse } from '../src/audio/dsp.ts';

// The offline AudioContext type only exists in a browser; the pure DSP helpers
// under test here take a BaseAudioContext. A tiny stand-in keeps these tests
// browser-free: the buffers the helpers build are filled by sample, and node
// cannot construct a real AudioBuffer.
class FakeBuffer {
  readonly length: number;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly channels: Float32Array[];
  constructor(channels: number, length: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.channels = Array.from({ length: channels }, () => new Float32Array(length));
  }
  getChannelData(i: number): Float32Array {
    return this.channels[i] as Float32Array;
  }
}

const fakeCtx = (channels = 2, seconds = 2, rate = 48000) =>
  ({
    sampleRate: rate,
    createBuffer: (ch: number, length: number) => new FakeBuffer(ch, length, rate),
    length: seconds * rate,
  }) as unknown as BaseAudioContext;

test('gains and decibels are inverses of each other', () => {
  for (const db of [-60, -24, -6, 0, 6]) {
    assert.ok(Math.abs(gainToDb(dbToGain(db)) - db) < 1e-9);
  }
  assert.ok(!Number.isFinite(gainToDb(0)));
});

test('clamp clamps, and leaves values in range alone', () => {
  assert.equal(clamp(0.5, 0, 1), 0.5);
  assert.equal(clamp(-1, 0, 1), 0);
  assert.equal(clamp(2, 0, 1), 1);
  assert.ok(Number.isNaN(clamp(Number.NaN, 0, 1)) === false, 'clamp(NaN) should be a number, not NaN');
});

test('the saturation curve is a curve, not a clip', () => {
  const curve = saturationCurve(0.4, 512);
  assert.equal(curve.length, 512);
  assert.ok(Math.abs((curve[0] as number) + 1) < 1e-6, 'the curve must start at -1');
  assert.ok(Math.abs((curve[curve.length - 1] as number) - 1) < 1e-6, 'the curve must end at +1');
  assert.equal((curve[Math.floor(curve.length / 2)] as number) > 0 ? 1 : -1, 1, 'the curve must be odd');
  // Monotonic, and gentler than a hard clip: this is the warmth of a synth-pop
  // master, and a curve that is linear in the middle is a broken one.
  for (let i = 1; i < curve.length; i++) {
    assert.ok((curve[i] as number) >= (curve[i - 1] as number), 'the curve is not monotonic');
  }
  const quarter = curve[Math.floor(curve.length * 0.25)] as number;
  assert.ok(quarter < -0.5 && quarter > -0.98, `a quarter of full scale reads ${quarter}`);
});

test('the noise buffer is stereo, finite and non-silent', () => {
  const ctx = fakeCtx();
  const buffer = createNoiseBuffer(ctx, 2);
  assert.equal(buffer.numberOfChannels, 2);
  assert.equal(buffer.sampleRate, 48000);
  let energy = 0;
  for (const channel of (buffer as unknown as FakeBuffer).channels) {
    for (const sample of channel) {
      assert.ok(Number.isFinite(sample), 'a NaN in the noise buffer hisses forever');
      energy += sample * sample;
    }
  }
  assert.ok(energy > 0, 'a silent noise buffer reverb-hisses nothing');
  assert.ok(energy < (buffer.length * buffer.numberOfChannels), 'the noise buffer is clipping');
});

test('the reverb impulse decays instead of ringing forever', () => {
  const ctx = fakeCtx(2, 3);
  const impulse = createReverbImpulse(ctx, 2.5) as unknown as FakeBuffer;
  assert.equal(impulse.numberOfChannels, 2);
  const data = impulse.getChannelData(0);
  assert.equal(data.length, Math.ceil(2.5 * 48000));
  // The tail must be quieter than the head: a reverb that builds is feedback.
  const head = data.slice(0, 4800).reduce((s, v) => s + Math.abs(v), 0) / 4800;
  const tail = data.slice(data.length - 4800).reduce((s, v) => s + Math.abs(v), 0) / 4800;
  assert.ok(head > tail, `head ${head} vs tail ${tail} — the impulse grows`);
  for (const sample of data) {
    assert.ok(Number.isFinite(sample), 'a NaN in the impulse is a stuck reverb');
  }
});
