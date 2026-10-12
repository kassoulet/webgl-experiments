import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Rng, hash4, hashString, hashUnit, mix32, normalizeSeed, randomSeed } from '@fractal-rave/shared';

test('the same seed gives the same stream', () => {
  const a = new Rng('acid-cathedral');
  const b = new Rng('acid-cathedral');
  for (let i = 0; i < 200; i++) assert.equal(a.next(), b.next());
});

test('different seeds give different streams', () => {
  const a = new Rng('one');
  const b = new Rng('two');
  let same = 0;
  for (let i = 0; i < 100; i++) if (a.next() === b.next()) same++;
  assert.ok(same < 3, `${same} of the first 100 draws collided`);
});

test('float, range and int stay inside their bounds', () => {
  const rng = new Rng('bounds');
  for (let i = 0; i < 5000; i++) {
    const f = rng.float();
    assert.ok(f >= 0 && f < 1, `float ${f} out of range`);
    const r = rng.range(-3, 7);
    assert.ok(r >= -3 && r < 7, `range ${r} out of range`);
    const n = rng.int(6);
    assert.ok(Number.isInteger(n) && n >= 0 && n < 6, `int ${n} out of range`);
  }
});

test('int(0) and int(1) do not produce NaN', () => {
  const rng = new Rng('degenerate');
  assert.equal(rng.int(1), 0);
  assert.equal(rng.int(0), 0);
});

test('a fork is independent of its parent and of its siblings', () => {
  // Two copies of the same pair of streams, one of which has had its `a` fork
  // consumed. Consuming one fork must not move the other, or adding a layer
  // would shift every number another layer already drew.
  const a1 = new Rng('fork-parent').fork('a');
  const b1 = new Rng('fork-parent').fork('b');
  const a2 = new Rng('fork-parent').fork('a');
  const b2 = new Rng('fork-parent').fork('b');

  const firstOfB = b1.next();
  for (let i = 0; i < 50; i++) a2.next();
  assert.equal(b2.next(), firstOfB, 'consuming one fork moved another');

  // And a fork is reproducible from its parent and label alone.
  const again = new Rng('fork-parent').fork('a');
  const replay = new Rng('fork-parent').fork('a');
  assert.equal(again.next(), replay.next());
});

test('fork labels separate streams', () => {
  const a = new Rng('same').fork('kick');
  const b = new Rng('same').fork('hat');
  assert.notEqual(a.next(), b.next());
});

test('normalizeSeed turns anything into a non-zero uint32', () => {
  for (const input of ['', '   ', 'abc', '12345', 0, -17, 3.9, Number.NaN]) {
    const seed = normalizeSeed(input as string | number);
    assert.ok(Number.isInteger(seed) && seed > 0, `${String(input)} gave ${seed}`);
  }
  assert.equal(normalizeSeed('12345'), 12345);
});

test('hashString is stable and well spread', () => {
  assert.equal(hashString('acid'), hashString('acid'));
  assert.notEqual(hashString('acid'), hashString('Acid'));
  const seen = new Set<number>();
  for (let i = 0; i < 5000; i++) seen.add(hashString(`seed-${i}`));
  assert.ok(seen.size > 4900, `only ${seen.size} distinct hashes from 5000 strings`);
});

test('mix32 separates its two inputs', () => {
  assert.notEqual(mix32(7, 1), mix32(7, 2));
  assert.notEqual(mix32(1, 7), mix32(2, 7));
});

test('hash4 is a function of its four arguments and nothing else', () => {
  // This is the whole contract of src/patterns.ts: the same four numbers give
  // the same answer however often and in whatever order they are asked for.
  const first = hash4(11, 22, 33, 44);
  hash4(99, 1, 2, 3);
  hash4(0, 0, 0, 0);
  assert.equal(hash4(11, 22, 33, 44), first);
  assert.notEqual(hash4(11, 22, 33, 45), first);
  assert.notEqual(hash4(11, 22, 34, 44), first);
  assert.ok(hashUnit(1, 2, 3, 4) >= 0 && hashUnit(1, 2, 3, 4) < 1);
});

test('hashUnit is spread across [0, 1)', () => {
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 10000; i++) buckets[Math.floor(hashUnit(1, 2, 3, i) * 10)]++;
  for (const [i, count] of buckets.entries()) {
    assert.ok(count > 700, `bucket ${i} got only ${count} of 10000`);
  }
});

test('randomSeed is readable and URL-safe', () => {
  for (let i = 0; i < 50; i++) {
    assert.match(randomSeed(), /^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
  }
});
