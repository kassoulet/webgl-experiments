import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_FLASH_MODE, FLASH_DEPTH, detectProfile, visualSettings } from '../src/profile.ts';

const desktop = detectProfile(
  { hardwareConcurrency: 16, deviceMemory: 8, maxTouchPoints: 0 },
  { matchMedia: () => ({ matches: false }) } as never,
);

const phone = detectProfile(
  { hardwareConcurrency: 4, deviceMemory: 2, maxTouchPoints: 5 },
  { matchMedia: (query: string) => ({ matches: query.includes('coarse') }) } as never,
);

test('a coarse pointer on a small machine is mobile; a desktop is not', () => {
  assert.equal(phone.name, 'mobile');
  assert.equal(desktop.name, 'desktop');
  assert.equal(phone.touch, true);
  assert.equal(desktop.touch, false);
});

test('a phone is asked for less of everything', () => {
  assert.ok((phone.synthVoices as number) < (desktop.synthVoices as number));
  assert.ok((phone.reverbSeconds as number) < (desktop.reverbSeconds as number));
  assert.ok(phone.visual.scale <= desktop.visual.scale);
  assert.ok(phone.visual.iterations <= desktop.visual.iterations);
});

test('the profile tolerates a browser that answers nothing', () => {
  const bare = detectProfile(undefined, { matchMedia: () => ({ matches: false }) } as never);
  assert.ok(bare.cores >= 1);
  assert.ok(bare.synthVoices >= 1);
  assert.ok(bare.visual.iterations >= 8);
});

test('quality is a choice over the profile default, in both directions', () => {
  for (const profile of [desktop, phone]) {
    const low = visualSettings(profile, 'low');
    const auto = visualSettings(profile, 'auto');
    const high = visualSettings(profile, 'high');
    assert.deepEqual(auto, profile.visual, 'auto is the profile, unchanged');
    assert.ok(low.scale <= auto.scale);
    assert.ok(low.iterations < auto.iterations);
    assert.equal(low.bloom, false, 'a phone at low quality should not pay for bloom');
    assert.ok(high.scale >= auto.scale);
    assert.ok(high.iterations > auto.iterations);
    assert.ok(low.iterations >= 8, 'the fractal needs enough iterations to look like anything');
  }
});

test('visualSettings does not mutate the profile it was given', () => {
  const before = JSON.stringify(desktop.visual);
  visualSettings(desktop, 'high');
  visualSettings(desktop, 'low');
  assert.equal(JSON.stringify(desktop.visual), before);
});

test('the flash cap is the photosensitivity rule, and it is the default', () => {
  assert.equal(DEFAULT_FLASH_MODE, 'soft');
  // A soft picture gains at most a fifth of its light from the kick; `full` is
  // the deliberate opt-in, and it is the only mode that goes past the cap.
  assert.ok((FLASH_DEPTH.soft as number) <= 0.22);
  assert.ok((FLASH_DEPTH.full as number) > (FLASH_DEPTH.soft as number));
  assert.equal(FLASH_DEPTH.soft, 0.22);
});

test('a kaleidoscope always has a whole number of segments, and at least two', () => {
  for (const profile of [desktop, phone]) {
    assert.ok(Number.isInteger(profile.visual.symmetry));
    assert.ok(profile.visual.symmetry >= 2);
    assert.ok(profile.visual.octaves >= 1 && profile.visual.octaves <= 8);
  }
});
