// The palette, which was measured off the reference video rather than chosen.
//
// The numbers these tests assert are the ones `tmp/jeffer/` counted: 64.9% of
// the reference is pure black, and what is left is a narrow run from indigo to
// electric violet on the cool side and maroon to a dull red on the warm one. A
// palette test that only checked "the hex parses" would pass on a picture of a
// completely different film.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PALETTE_COUNT,
  SECTION_SATURATION,
  blendPalettes,
  paletteAt,
  paletteByName,
  paletteNames,
} from '../src/palette.ts';
import { buildChord } from '../src/harmony.ts';
import type { Chord, Palette, RGB, SectionName } from '../src/types.ts';

const SECTIONS: SectionName[] = ['intro', 'build', 'groove', 'drop', 'break', 'peak'];
const CHORD = buildChord({ rootPc: 9, modeName: 'aeolian', degree: 0 });
const NEXT = buildChord({ rootPc: 2, modeName: 'aeolian', degree: 5 });
/** Luminance, 0..1. The palette is stored as sRGB *bytes*, because that is what
 *  was counted off the reference, and the renderer converts to linear on the
 *  way to the shader. */
const luma = (c: RGB): number => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
const channels = (c: RGB): number => c.r + c.g + c.b;

/** The deepest stop, the mid and the highlight, as luminances. */
const stops = (p: Palette): number[] => [p.deep, p.mid, p.hot].map(luma);

test('there are several measured runs, and every one is usable', () => {
  const names = paletteNames();
  assert.ok(names.length >= 6, `only ${names.length} runs: a set would never change colour`);
  assert.equal(new Set(names).size, names.length, 'two runs share a name');
  for (const name of names) {
    const palette = paletteByName(name);
    assert.ok(palette, `${name} is listed but cannot be read back`);
    for (const key of ['deep', 'mid', 'hot', 'accent'] as const) {
      const colour = palette[key];
      assert.ok(channels(colour) > 0, `${name}'s ${key} is black, which is a hole in the picture`);
      for (const channel of [colour.r, colour.g, colour.b]) {
        assert.ok(channel >= 0 && channel <= 255, `${name}'s ${key} has a channel at ${channel}`);
      }
    }
  }
  assert.equal(paletteByName('no such run'), null);
});

test('each run climbs from its deep stop to its highlight', () => {
  // The shader treats these as a ramp: `deep` is the room, `mid` the field and
  // `hot` the trace. A run where the highlight is darker than its own mid inverts
  // the ramp, and every use of it in the shader then reads as a mistake.
  for (const name of paletteNames()) {
    const [deep, mid, hot] = stops(paletteByName(name) as Palette);
    assert.ok(mid > deep, `${name}'s mid (${mid.toFixed(3)}) is not above its deep (${deep.toFixed(3)})`);
    assert.ok(hot > mid, `${name}'s hot (${hot.toFixed(3)}) is not above its mid (${mid.toFixed(3)})`);
  }
});

test('nothing in the reference is bright, and nothing in it is neutral', () => {
  // The measured runs top out at #4924b6 and #6d2424 — luminances of 0.21 and
  // 0.16 — and the warmest run's highlight, #8c3030, is the brightest coloured
  // stop in the palette at 0.27. Nothing in the reference is anywhere near
  // white, and a palette that reached for it would be a different film.
  for (const name of paletteNames()) {
    const palette = paletteByName(name) as Palette;
    // One run is deliberately near-monochrome: the reference's greys with a cold
    // cast. It is the brightest stop in the app and it is still under half scale.
    const ceiling = name === 'Tapehead' ? 0.45 : 0.3;
    assert.ok(luma(palette.hot) <= ceiling, `${name}'s highlight is at ${luma(palette.hot).toFixed(3)}, too bright for the reference`);
    for (const key of ['deep', 'mid', 'hot', 'accent'] as const) {
      const { r, g, b } = palette[key];
      const spread = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
      // A stop that is nearly black has no hue to speak of; what must not
      // happen is a *lit* stop with no hue in it.
      assert.ok(
        luma(palette[key]) < 0.1 || spread > 0.02,
        `${name}'s ${key} is grey (${r}, ${g}, ${b})`,
      );
    }
  }
});

test('the colour follows the harmony: a bass line that lifts changes the room', () => {
  // The one place the picture is allowed to be a function of the music beyond
  // the scope itself. A bass line that moves up a third crosses to the *next*
  // measured run, because that is where the reference moves between its warm
  // and cool branches; a line that falls stays where it is. The colours are
  // compared rather than the names, because the name is a label for the HUD and
  // the picture is the three stops.
  const here = paletteByName(paletteNames()[0] as string) as Palette;
  const next = paletteByName(paletteNames()[1] as string) as Palette;
  const low = buildChord({ rootPc: 2, modeName: 'aeolian', degree: 0 }); // bass D
  const falls = buildChord({ rootPc: 0, modeName: 'aeolian', degree: 0 }); // down a tone
  const lifts = buildChord({ rootPc: 9, modeName: 'aeolian', degree: 0 }); // up a fifth
  const stops = (p: Palette): RGB[] => [p.deep, p.mid, p.hot, p.accent];
  const sameStops = (a: Palette, b: Palette): boolean =>
    stops(a).every((c, i) => Math.abs((c.r as number) - (stops(b)[i] as RGB).r) < 0.5);

  const start = paletteAt({ chord: low, nextChord: lifts, progress: 0, saturation: 1, index: 0 });
  assert.ok(sameStops(start, here), 'the chord did not begin on the run it was already in');
  const cool = paletteAt({ chord: low, nextChord: falls, progress: 1, saturation: 1, index: 0 });
  const warm = paletteAt({ chord: low, nextChord: lifts, progress: 1, saturation: 1, index: 0 });
  assert.ok(sameStops(cool, here), 'a bass line that fell crossed to another run anyway');
  assert.ok(sameStops(warm, next), 'a bass line that lifted did not cross to the next run');
  // And the crossing is a slide, not a cut: half way through the chord the
  // picture is between the two runs, not on either of them.
  const half = paletteAt({ chord: low, nextChord: lifts, progress: 0.5, saturation: 1, index: 0 });
  assert.ok(!sameStops(half, here) && !sameStops(half, next), 'half way across the chord is on one run or the other');
  const d0 = (half.hot.r as number) - (here.hot.r as number);
  const d1 = (next.hot.r as number) - (half.hot.r as number);
  assert.ok(Math.abs(d0 - d1) <= 1, 'half way across the chord is not half way between the two runs');
});

test('a palette is a function of its inputs, and never out of range', () => {
  for (const section of SECTIONS) {
    for (const progress of [0, 0.5, 1, -3, 7]) {
      for (const saturation of [0, 0.5, 1, 4]) {
        for (const index of [0, 1, 5, -1]) {
          const palette = paletteAt({
            chord: CHORD,
            nextChord: NEXT,
            progress,
            saturation,
            index,
          });
          assert.ok(palette.name.length > 0);
          for (const key of ['deep', 'mid', 'hot', 'accent'] as const) {
            const { r, g, b } = palette[key];
            for (const channel of [r, g, b]) {
              assert.ok(channel >= 0 && channel <= 255, `${key} left the range at ${channel}`);
            }
          }
          // A saturation of zero desaturates towards the run's own deep stop, so
          // a breakdown is a nearly black frame — which is what the reference's
          // quiet passages are.
          if (saturation === 0) {
            assert.ok(luma(palette.mid) < 0.2, `a fully desaturated mid is at ${luma(palette.mid).toFixed(3)}`);
          }
        }
      }
    }
  }
  assert.deepEqual(
    paletteAt({ chord: CHORD, nextChord: NEXT, progress: 0.5, saturation: 0.8, index: 2 }),
    paletteAt({ chord: CHORD, nextChord: NEXT, progress: 0.5, saturation: 0.8, index: 2 }),
  );
});

test('a break is allowed to be the darkest thing on screen', () => {
  // The saturation table is the arrangement's own statement about how colourful
  // each passage may be, and the reference's quietest passages are its most
  // degraded ones. It is also read by the tests, so a typo in it shows up here
  // rather than as a picture nobody can look at.
  assert.ok(SECTION_SATURATION.break < SECTION_SATURATION.drop);
  assert.ok(SECTION_SATURATION.drop >= SECTION_SATURATION.intro);
  for (const section of SECTIONS) {
    const saturation = SECTION_SATURATION[section];
    assert.ok(saturation >= 0 && saturation <= 1, `${section}'s saturation is ${saturation}`);
  }
});

test('blending two palettes lands between them', () => {
  // A passage change should not cut. `t` outside 0..1 is clamped rather than
  // extrapolated, because an extrapolated colour channel leaves the gamut and
  // the shader clamps it to something nobody chose.
  const a = paletteByName('Cathode') as Palette;
  const b = paletteByName('Ember') as Palette;
  for (const t of [0, 0.25, 0.5, 1, -1, 2]) {
    const mid = blendPalettes(a, b, t).mid;
    const lo = Math.min(a.mid.r, b.mid.r);
    const hi = Math.max(a.mid.r, b.mid.r);
    assert.ok(mid.r >= lo - 1e-9 && mid.r <= hi + 1e-9, `blend at ${t} left the pair's range`);
    assert.ok(mid.r >= 0 && mid.r <= 255, `blend at ${t} left the byte range`);
  }
  assert.equal(blendPalettes(a, b, 0).name, a.name);
  assert.equal(blendPalettes(a, b, 1).name, b.name);
});

test('a set uses two to four of the measured runs, and no more', () => {
  // The conductor picks the count from the seed; the palette function is handed
  // an index and wraps it. Both halves are asserted here, because a count of one
  // is a set that never changes colour and a count of six is a set that ignores
  // the measurement.
  assert.ok(PALETTE_COUNT >= 2 && PALETTE_COUNT <= 4, `PALETTE_COUNT is ${PALETTE_COUNT}`);
  assert.ok(paletteNames().length >= PALETTE_COUNT, 'there are fewer runs than a set may use');
});
