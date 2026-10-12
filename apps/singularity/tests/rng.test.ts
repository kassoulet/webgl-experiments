import test from 'node:test';
import assert from 'node:assert/strict';

import { Rng, hashString, mix32, normalizeSeed, randomSeed } from '../src/rng.ts';
import { fbm1, valueNoise1, valueNoise2, wander } from '../src/noise.ts';

test('a seed reproduces its stream exactly', () => {
  const a = new Rng('quiet-orbit');
  const b = new Rng('quiet-orbit');
  const xs = Array.from({ length: 32 }, () => a.float());
  const ys = Array.from({ length: 32 }, () => b.float());
  assert.deepEqual(xs, ys);
});

test('different seeds diverge', () => {
  const a = new Rng('quiet-orbit');
  const b = new Rng('quiet-orbit-2');
  const xs = Array.from({ length: 16 }, () => a.float());
  const ys = Array.from({ length: 16 }, () => b.float());
  assert.notDeepEqual(xs, ys);
});

test('numbers and their string form are the same seed', () => {
  assert.equal(normalizeSeed(1234), normalizeSeed('1234'));
  assert.equal(new Rng(1234).seed, new Rng('1234').seed);
});

test('normalizeSeed never returns zero (zero has no stream)', () => {
  assert.notEqual(normalizeSeed(''), 0);
  assert.notEqual(normalizeSeed(0), 0);
});

test('forks are independent and stable', () => {
  const rng = new Rng('a');
  const left = rng.fork('left');
  const right = rng.fork('right');
  const leftAgain = new Rng('a').fork('left');
  assert.equal(left.float(), leftAgain.float());
  assert.notEqual(new Rng('a').fork('left').float(), new Rng('a').fork('right').float());
  assert.notEqual(left.float(), right.float());
});

test('draws stay inside their ranges', () => {
  const rng = new Rng('ranges');
  for (let i = 0; i < 2000; i++) {
    const f = rng.float();
    assert.ok(f >= 0 && f < 1);
    const r = rng.range(-3, 7);
    assert.ok(r >= -3 && r < 7);
    const n = rng.int(5);
    assert.ok(Number.isInteger(n) && n >= 0 && n < 5);
    assert.ok(Math.abs(rng.signed()) <= 1);
  }
});

test('pick only returns members', () => {
  const rng = new Rng('pick');
  const arr = ['x', 'y', 'z'];
  for (let i = 0; i < 200; i++) assert.ok(arr.includes(rng.pick(arr)));
});

test('hashString is stable and spreads', () => {
  assert.equal(hashString('abc'), hashString('abc'));
  assert.notEqual(hashString('abc'), hashString('abd'));
  assert.equal(mix32(1, 2), mix32(1, 2));
});

test('randomSeed produces something a link can carry', () => {
  const seed = randomSeed();
  assert.match(seed, /^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
});

test('noise is deterministic, bounded and continuous', () => {
  for (let i = 0; i < 100; i++) {
    const x = i * 0.37;
    assert.equal(valueNoise1(x, 7), valueNoise1(x, 7));
    assert.ok(valueNoise1(x, 7) >= 0 && valueNoise1(x, 7) < 1);
    assert.ok(fbm1(x, 4, 7) >= 0 && fbm1(x, 4, 7) < 1);
    assert.ok(valueNoise2(x, x * 1.3, 7) >= 0 && valueNoise2(x, x * 1.3, 7) < 1);
  }
  // Small steps must not produce jumps: this is what keeps every drift smooth.
  for (let i = 0; i < 500; i++) {
    const t = i * 0.5;
    assert.ok(Math.abs(fbm1(t + 0.1, 3, 11) - fbm1(t, 3, 11)) < 0.2);
  }
});

test('wander never leaves its span', () => {
  for (let t = 0; t < 5000; t += 7) {
    const v = wander(t, 120, 0.5, 0.25, 3);
    assert.ok(v >= 0.25 - 1e-9 && v <= 0.75 + 1e-9, `wander left its span at t=${t}: ${v}`);
  }
});
