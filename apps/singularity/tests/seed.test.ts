import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanSeed, parseSeed, formatSeedHash, seedMoodLine } from '../src/seed.ts';
import { PALETTES, paletteAt, paletteIndexFor, hexToRgb, srgbToLinear } from '../src/palette.ts';

test('seeds survive a round trip through the link', () => {
  for (const seed of ['quiet-orbit-1a2b', 'GENESIS', 'a.b_c-d', '12345']) {
    const hash = formatSeedHash(seed);
    assert.equal(parseSeed(hash), seed);
    assert.equal(parseSeed(hash.slice(1)), seed); // without the '#'
  }
});

test('a bare fragment works as a seed', () => {
  assert.equal(parseSeed('#quiet-orbit'), 'quiet-orbit');
  assert.equal(parseSeed('quiet-orbit'), 'quiet-orbit');
});

test('junk in the fragment does not become part of the seed', () => {
  assert.equal(cleanSeed('  two words  '), 'two-words');
  assert.equal(cleanSeed('a/../etc/passwd'), 'a..etcpasswd');
  assert.equal(cleanSeed('x'.repeat(200)).length, 64);
  assert.equal(parseSeed('#s=%20%20'), null);
  assert.equal(parseSeed(''), null);
  assert.equal(parseSeed('#'), null);
});

test('the seed line is derived, not stored twice', () => {
  assert.equal(seedMoodLine('quiet-orbit'), 'journey seed: quiet-orbit');
  assert.equal(seedMoodLine(''), 'journey seed: (none)');
});

test('palettes are well formed', () => {
  assert.ok(PALETTES.length >= 8);
  for (const p of PALETTES) {
    for (const key of ['deep', 'mid', 'hot'] as const) {
      const rgb = hexToRgb(p[key]);
      assert.equal(rgb.length, 3);
      for (const c of rgb) assert.ok(c >= 0 && c <= 1);
    }
  }
});

test('sRGB to linear is monotone and pinned at the ends', () => {
  assert.equal(srgbToLinear(0), 0);
  assert.ok(Math.abs(srgbToLinear(1) - 1) < 1e-12);
  assert.ok(srgbToLinear(0.5) < 0.5);
  assert.ok(srgbToLinear(0.2) < srgbToLinear(0.4));
});

test('the palette index is stable for a key and moves with the degree', () => {
  const a = { rootPc: 3, modeName: 'dorian' };
  assert.equal(paletteIndexFor(a), paletteIndexFor(a));
  const degrees = new Set();
  for (let d = 0; d < 7; d++) degrees.add(paletteIndexFor({ ...a, degree: d }));
  assert.ok(degrees.size >= 3, 'the progression barely touches the palette');
  for (let pc = 0; pc < 12; pc++) {
    const i = paletteIndexFor({ rootPc: pc, modeName: 'aeolian' });
    assert.ok(i >= 0 && i < PALETTES.length);
  }
});

test('paletteAt blends from one chord to the next instead of cutting', () => {
  const chord = { rootPc: 0, modeName: 'aeolian', degree: 0 };
  const nextChord = { rootPc: 0, modeName: 'aeolian', degree: 5 };
  const start = paletteAt({ chord, nextChord, progress: 0 });
  const middle = paletteAt({ chord, nextChord, progress: 0.5 });
  const end = paletteAt({ chord, nextChord, progress: 1 });
  assert.notDeepEqual(start.hot, end.hot);
  for (const key of ['deep', 'mid', 'hot'] as const) {
    for (let i = 0; i < 3; i++) {
      const lo = Math.min(start[key][i], end[key][i]);
      const hi = Math.max(start[key][i], end[key][i]);
      assert.ok(middle[key][i] >= lo - 1e-9 && middle[key][i] <= hi + 1e-9, `${key} left its blend range`);
    }
  }
});

test('a mood warms the picture without breaking the range', () => {
  const chord = { rootPc: 7, modeName: 'lydian', degree: 2 };
  const warm = paletteAt({ chord, progress: 0, mood: { warmth: 1.3 } });
  for (const c of warm.hot) assert.ok(c >= 0 && c <= 1.6);
});
