import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cleanSeed, formatSeedHash, parseSeed, seedMoodLine } from '@fractal-rave/shared';

test('cleanSeed keeps URL-safe characters and nothing else', () => {
  assert.equal(cleanSeed('acid-cathedral-1a2b'), 'acid-cathedral-1a2b');
  assert.equal(cleanSeed('  spaced  out  '), 'spaced-out');
  assert.equal(cleanSeed('a/b?c=d&e'), 'abcde');
  assert.equal(cleanSeed('ünïcode'), 'ncode');
});

test('cleanSeed is bounded, so a link cannot carry a novel', () => {
  assert.equal(cleanSeed('x'.repeat(500)).length, 64);
});

test('cleanSeed turns junk into nothing rather than into a seed', () => {
  // This is what the seed input refuses: `***` must not become a journey the
  // URL will then carry.
  for (const junk of ['***', '///', '   ', '???', null, undefined]) {
    assert.equal(cleanSeed(junk as string), '');
  }
});

test('parseSeed reads both spellings of the fragment', () => {
  assert.equal(parseSeed('#s=acid-cathedral'), 'acid-cathedral');
  assert.equal(parseSeed('s=acid-cathedral'), 'acid-cathedral');
  assert.equal(parseSeed('#acid-cathedral'), 'acid-cathedral');
  assert.equal(parseSeed('#s=with%20space'), 'with-space');
});

test('parseSeed returns null when there is no seed to be had', () => {
  for (const hash of ['', '#', '#s=', '#s=***', '#===']) {
    assert.equal(parseSeed(hash), null, `${JSON.stringify(hash)} should be no seed`);
  }
});

test('the hash round-trips', () => {
  const seed = 'molten-turbine-9f3c';
  assert.equal(parseSeed(formatSeedHash(seed)), seed);
});

test('formatSeedHash puts the seed in the fragment, never the query', () => {
  const hash = formatSeedHash('tidepool');
  assert.equal(hash, '#s=tidepool');
  assert.ok(!hash.includes('?'), 'the seed must never reach a server');
});

test('seedMoodLine says what there is, and admits when there is nothing', () => {
  assert.match(seedMoodLine('tidepool'), /tidepool/);
  assert.match(seedMoodLine('***'), /none/);
});
