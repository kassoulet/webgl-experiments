// The random numbers, and the seeds they come from.
//
// A seed is a promise: the same string gives the same set, in any order, in any
// process, an hour later. Everything above this file depends on it, so the tests
// here are about determinism and distribution rather than about music.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Rng, hash4, hashString, hashUnit, mix32, normalizeSeed, randomSeed } from '../src/rng.ts';
import { cleanSeed, formatSeedHash, parseSeed, sameSeed } from '../src/seed.ts';

test('a seed is a string in, a number out, and the same string always', () => {
  assert.equal(hashString('jeffer'), hashString('jeffer'));
  assert.notEqual(hashString('jeffer'), hashString('jeffers'));
  assert.ok(Number.isInteger(hashString('')), 'the empty string still has to hash to something');
  assert.ok(Number.isInteger(hashString('a'.repeat(200))), 'a long seed still hashes');
  // A string that is only different in case is a different seed: a link is
  // carried by its exact text, and quietly folding case would make two links
  // the same set.
  assert.notEqual(hashString('Jeffer'), hashString('jeffer'));
});

test('the hash is not a CRC in a hat: nearby seeds are far apart', () => {
  // A seed space where 'a' and 'b' give neighbouring numbers would make a set's
  // opening bars a function of the seed's spelling, which nobody would notice
  // until two people's links looked identical.
  const values = Array.from({ length: 32 }, (_, i) => hashString(String.fromCharCode(97 + i)));
  const sorted = [...values].sort((x, y) => x - y);
  let collisions = 0;
  let close = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1]) collisions++;
    else if ((sorted[i] as number) - (sorted[i - 1] as number) < 1024) close++;
  }
  assert.equal(collisions, 0, 'two of the first letters hash the same');
  assert.ok(close <= 2, `${close} pairs of letters hash within 1024 of each other`);
});

test('mix32 and hash4 are functions of their arguments only', () => {
  assert.equal(mix32(7, 11), mix32(7, 11));
  assert.notEqual(mix32(7, 11), 0, 'mix32 returned zero, so every seed in the app is the same set');
  assert.notEqual(mix32(7, 1), mix32(7, 2), 'mix32 does not separate its two inputs');
  assert.notEqual(mix32(1, 7), mix32(2, 7), 'mix32 does not separate its two inputs');
  assert.equal(hash4(1, 2, 3, 4), hash4(1, 2, 3, 4));
  assert.notEqual(hash4(1, 2, 3, 4), 0, 'hash4 returned zero, so every bar plays the same bar');
  assert.notEqual(hash4(1, 2, 3, 4), hash4(4, 3, 2, 1));
  // hashUnit is the only way the app turns a hash into a roll, and it is used
  // for everything from which drum to play to how long a passage is. It has to
  // be in [0, 1) for every input, including the awkward ones.
  for (let a = 0; a < 40; a++) {
    for (const b of [0, 1, 7, 255, 1e6, -3, 0.5]) {
      const value = hashUnit(a, b, a + b, 3);
      assert.ok(value >= 0 && value < 1, `hashUnit gave ${value}`);
    }
  }
});

test('normalizeSeed never returns zero, because zero is a state', () => {
  // sfc32 with an all-zero state never escapes it. A seed that hashed to zero
  // would give every such seed the same set.
  assert.ok(normalizeSeed('') !== 0);
  assert.ok(normalizeSeed('0') !== 0);
  assert.equal(normalizeSeed('jeffer'), normalizeSeed('jeffer'));
  assert.notEqual(normalizeSeed('jeffer'), normalizeSeed('jeffers'));
});

test('an Rng is reproducible, and its forks are independent of each other', () => {
  const draw = (rng: Rng): number[] => Array.from({ length: 8 }, () => rng.float());
  assert.deepEqual(draw(new Rng('a')), draw(new Rng('a')));
  assert.notDeepEqual(draw(new Rng('a')), draw(new Rng('b')));

  // Forks exist so that adding a layer does not shift the numbers another layer
  // has already consumed. This is the property: a fork taken now is the same
  // fork taken after any amount of use of its parent.
  const parent = new Rng('fork');
  const before = draw(parent.fork('drums'));
  draw(parent);
  draw(parent);
  assert.deepEqual(draw(parent.fork('drums')), before, 'a fork depends on how much of its parent was used');
  assert.notDeepEqual(draw(parent.fork('bass')), before, 'two forks of one parent are the same stream');
});

test('the rolls are in range and the distribution is not a constant', () => {
  const rng = new Rng('distribution');
  const buckets = new Array(10).fill(0);
  const n = 20000;
  for (let i = 0; i < n; i++) {
    const value = rng.float();
    assert.ok(value >= 0 && value < 1, `float gave ${value}`);
    buckets[Math.floor(value * 10)]!++;
  }
  for (const [i, count] of buckets.entries()) {
    // 10% of the time in each tenth, with a generous margin for sampling.
    assert.ok(count > n * 0.07 && count < n * 0.13, `tenth ${i} got ${count} of ${n}`);
  }
  for (let i = 0; i < 1000; i++) {
    const value = rng.int(7);
    assert.ok(Number.isInteger(value) && value >= 0 && value < 7, `int(7) gave ${value}`);
    const inRange = rng.range(-2, 5);
    assert.ok(inRange >= -2 && inRange < 5, `range gave ${inRange}`);
  }
  assert.ok(rng.chance(0) === false, 'chance(0) is never true');
  assert.ok(rng.chance(1) === true, 'chance(1) is always true');
  const signed = Array.from({ length: 500 }, () => rng.signed());
  assert.ok(signed.every((v) => v >= -1 && v <= 1), 'signed left [-1, 1]');
  assert.ok(signed.some((v) => v > 0.2) && signed.some((v) => v < -0.2), 'signed is not one-signed');
  assert.ok(['a', 'b', 'c'].includes(rng.pick(['a', 'b', 'c'])));

});

test('a random seed is a seed a person could type', () => {
  const seed = randomSeed();
  assert.equal(seed, cleanSeed(seed), `randomSeed() produced ${seed}, which its own cleaner refuses`);
  assert.ok(seed.length >= 3 && seed.length <= 64);
});

test('a seed link is the whole contract: in, out, and nothing else trusted', () => {
  assert.equal(parseSeed('#s=jeffer'), 'jeffer');
  assert.equal(parseSeed('s=jeffer'), 'jeffer');
  assert.equal(parseSeed('#s=two%20words'), '', 'a seed with a space in it was carried by the link');
  assert.equal(formatSeedHash('jeffer'), '#s=jeffer');
  // Round trip: what comes out of the formatter goes back in unchanged, which is
  // the only reason a link is worth handing to anybody.
  for (const seed of ['a', 'jeffer-1', 'x'.repeat(64), '42']) {
    assert.equal(parseSeed(formatSeedHash(seed)), cleanSeed(seed), `${seed} did not survive the round trip`);
  }
  // And nothing else in the URL is believed.
  assert.equal(parseSeed(''), null);
  assert.equal(parseSeed('#'), null);
  assert.equal(parseSeed('#theme=dark'), null, 'a fragment with no seed was followed');
  assert.equal(parseSeed('#s='), null);
});

test('a seed that could not be carried in a URL is refused, not cleaned', () => {
  // The difference matters: a cleaned-up seed is a *different set* from the one
  // that was asked for, and a reader who typed one has to be told rather than
  // given something else.
  assert.equal(cleanSeed('  jeffer  '), 'jeffer', 'surrounding space is trimmed, not refused');
  assert.equal(cleanSeed('***'), '');
  assert.equal(cleanSeed('two words'), '');
  assert.equal(cleanSeed('-leading'), '');
  assert.equal(cleanSeed('x'.repeat(65)), '');
  assert.equal(cleanSeed('x'.repeat(64)), 'x'.repeat(64));
  assert.equal(cleanSeed(''), '');
});

test('two seeds are the same set only when they are the same string', () => {
  assert.ok(sameSeed('jeffer', 'jeffer'));
  assert.ok(!sameSeed('jeffer', 'Jeffer'));
  assert.ok(!sameSeed('jeffer', 'jeffers'));
});
