import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PALETTES, hexToRgb, paletteAt, paletteIndexFor, srgbToLinear, toLinear } from '../src/palette.ts';
import { buildChord } from '../src/harmony.ts';
import type { Chord, RGB } from '../src/types.ts';

const at = (hex: string): RGB => hexToRgb(hex);

test('hexToRgb reads the channels where they are', () => {
  // A regression, kept deliberately: an off-by-one shift here returns the blue
  // channel twice and every palette in the app comes out with no green in it,
  // which is a bug you cannot see in a hex string.
  assert.deepEqual(at('#ff8000'), [1, 128 / 255, 0]);
  assert.deepEqual(at('#00ff00'), [0, 1, 0]);
  assert.deepEqual(at('#0000ff'), [0, 0, 1]);
  assert.deepEqual(at('#123456'), [0x12 / 255, 0x34 / 255, 0x56 / 255]);
  assert.deepEqual(at('#fff'), [1, 1, 1]);
  assert.deepEqual(at('#000'), [0, 0, 0]);
});

test('every palette has four distinct, usable colours', () => {
  assert.ok(PALETTES.length >= 8, 'there should be more than one sky to be in');
  for (const palette of PALETTES) {
    assert.ok(palette.name.length > 0);
    for (const hex of [palette.deep, palette.mid, palette.hot, palette.accent]) {
      assert.match(hex, /^#[0-9a-f]{6}$/, `${palette.name} has ${hex}`);
      const [r, g, b] = at(hex);
      // A colour with one channel at zero is fine (that is how darks are made);
      // a palette where all three are zero is a hole in the picture.
      assert.ok(r + g + b > 0, `${palette.name} has a black stop`);
    }
    assert.notEqual(palette.hot, palette.accent, `${palette.name}'s accent is invisible against its highlight`);
  }
});

test('the palettes are aurora palettes: green or violet at their heart', () => {
  // The app's subject is the northern lights; a palette whose mid tone is
  // neither green-ish nor violet-ish would read as something else entirely.
  for (const palette of PALETTES) {
    const [r, g, b] = at(palette.mid);
    const greenish = g > r && g > 0.2;
    const violetish = b > g || r > g;
    assert.ok(greenish || violetish, `${palette.name} (${palette.mid}) is neither green nor violet`);
  }
});

test('srgbToLinear is anchored at black and white', () => {
  assert.equal(srgbToLinear(0), 0);
  assert.ok(Math.abs(srgbToLinear(1) - 1) < 1e-12);
  assert.ok(srgbToLinear(0.5) < 0.5, 'the midpoint must be darker than the sRGB midpoint');
  assert.ok(srgbToLinear(0.25) < srgbToLinear(0.75));
});

test('toLinear leaves white alone and darkens everything else', () => {
  assert.deepEqual(toLinear([1, 1, 1]), [1, 1, 1]);
  assert.deepEqual(toLinear([0, 0, 0]), [0, 0, 0]);
  const mid = toLinear([0.5, 0.5, 0.5]);
  assert.ok((mid[0] as number) < 0.5);
});

test('the palette index is a function of the harmony', () => {
  const a = buildChord({ rootPc: 0, modeName: 'ionian', degree: 0 });
  assert.equal(paletteIndexFor(a), paletteIndexFor({ rootPc: a.rootPc, modeName: a.modeName }));
  for (let rootPc = 0; rootPc < 12; rootPc++) {
    const index = paletteIndexFor({ rootPc, modeName: 'ionian' });
    assert.ok(index >= 0 && index < PALETTES.length, `rootPc ${rootPc} maps outside the palettes`);
  }
});

const chord = (degree: number): Chord => buildChord({ rootPc: 0, modeName: 'ionian', degree });

test('the palette crosses from one chord to the next instead of cutting', () => {
  const from = chord(0);
  const to = chord(5);
  const start = paletteAt({ chord: from, nextChord: to, progress: 0 });
  const middle = paletteAt({ chord: from, nextChord: to, progress: 0.5 });
  const end = paletteAt({ chord: from, nextChord: to, progress: 1 });
  assert.ok(start.name !== end.name, 'two degrees apart should not share a palette');
  const distance = (a: RGB, b: RGB): number =>
    Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const half = distance(start.hot, middle.hot) + distance(start.mid, middle.mid);
  const rest = distance(middle.hot, end.hot) + distance(middle.mid, end.mid);
  assert.ok(half > 0 && rest > 0, 'the crossfade did not move');
  // Halfway should be about half way: a fade that is nearly all in the first
  // few per cent is a cut with a smoother edge.
  assert.ok(half > rest * 0.4 && half < rest * 2.5, `the crossfade is lopsided (${half} then ${rest})`);
});

test('saturation moves the palette without ever leaving linear light', () => {
  const neutral = paletteAt({ chord: chord(0), saturation: 1 });
  const hot = paletteAt({ chord: chord(0), saturation: 1.2 }); // a chorus
  const cold = paletteAt({ chord: chord(0), saturation: 0.6 }); // a bridge
  for (const palette of [neutral, hot, cold]) {
    for (const colour of [palette.deep, palette.mid, palette.hot, palette.accent]) {
      for (const channel of colour) {
        assert.ok(Number.isFinite(channel) && channel >= 0 && channel <= 2, `channel ${channel}`);
      }
    }
  }
  assert.ok((hot.hot[0] as number) >= (neutral.hot[0] as number), 'a chorus did not brighten the palette');
  assert.ok((cold.hot[0] as number) <= (neutral.hot[0] as number), 'a bridge did not cool the palette');
});

test('a palette with no next chord is simply the current one', () => {
  const alone = paletteAt({ chord: chord(3) });
  const settled = paletteAt({ chord: chord(3), nextChord: chord(3), progress: 1 });
  assert.deepEqual(alone.hot, settled.hot);
  assert.deepEqual(alone.mid, settled.mid);
});
