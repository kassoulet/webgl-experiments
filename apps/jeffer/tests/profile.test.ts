// The device profile and the flash cap.
//
// Two claims live here. The first is that a phone is asked to carry less of a set
// than a desktop, which is a taste decision and has to be written down as one.
// The second is the flash cap, which is a safety claim: a picture that is two
// thirds black with a bright trace on it has one of the worst contrast ratios
// there is, so the cap has to be low, it has to be the default, and a device
// asking for reduced motion must never be handed the strobe by default.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_FLASH_MODE, FLASH_DEPTH, detectProfile, visualSettings } from '../src/profile.ts';
import type { Profile } from '../src/types.ts';

/** The optional hints `detectProfile` reads. Deliberately not exported: a
 *  profile is a decision about a device, and a test should not be able to
 *  invent a new kind of device to make one. */
interface NavigatorHints {
  hardwareConcurrency?: number;
  deviceMemory?: number;
  maxTouchPoints?: number;
}

const nav = (over: Partial<NavigatorHints> = {}): NavigatorHints => ({
  hardwareConcurrency: 8,
  deviceMemory: 8,
  maxTouchPoints: 0,
  ...over,
});
const win = (coarse: boolean): Window & typeof globalThis =>
  ({ matchMedia: (query: string) => ({ matches: coarse && query.includes('coarse') }) }) as unknown as Window & typeof globalThis;

test('a desktop is asked for more of everything than a phone', () => {
  const desktop = detectProfile(nav(), win(false));
  const mobile = detectProfile(nav({ hardwareConcurrency: 4, deviceMemory: 3, maxTouchPoints: 5 }), win(true));
  assert.equal(desktop.name, 'desktop');
  assert.equal(mobile.name, 'mobile');
  assert.ok(desktop.synthVoices > mobile.synthVoices, 'a phone is asked for more detuned voices than a desktop');
  assert.ok(desktop.visual.octaves >= mobile.visual.octaves, 'a phone is asked for more noise octaves');
  assert.ok(desktop.visual.scale >= mobile.visual.scale, 'a phone renders at a higher scale');
  assert.ok(mobile.reverbSeconds <= desktop.reverbSeconds, 'a phone runs a longer reverb than a desktop');
});

test('a touchscreen is a touch device even when it is fast', () => {
  // A tablet with plenty of cores is still a tablet: the HUD has to put its
  // controls where a finger can reach them.
  const tablet = detectProfile(nav({ maxTouchPoints: 5 }), win(false));
  assert.equal(tablet.name, 'desktop');
  assert.equal(tablet.touch, true);
  assert.equal(detectProfile(nav(), win(false)).touch, false);
});

test('a device that says nothing is a middle device, not a broken one', () => {
  // The hints are optional in the spec, and a browser that omits them is a
  // browser this app has to run in anyway.
  const bare = detectProfile(undefined, win(false));
  assert.equal(bare.name, 'desktop');
  assert.ok(bare.cores >= 1 && bare.synthVoices >= 1);
  assert.ok(bare.visual.octaves >= 1);
});

test('the scan lines are a property of a tape, not of a device', () => {
  // 240 is a little under NTSC's 243.5. It is the same on every device, because
  // it is a property of the material and not of the hardware.
  for (const quality of ['low', 'auto', 'high'] as const) {
    assert.equal(visualSettings(detectProfile(nav(), win(false)), quality).scanLines, 240);
  }
});

test('quality is a user choice over the profile, and it is bounded', () => {
  const profile: Profile = detectProfile(nav(), win(false));
  const base = profile.visual;
  const low = visualSettings(profile, 'low');
  const high = visualSettings(profile, 'high');
  const auto = visualSettings(profile, 'auto');
  assert.equal(low.octaves, 1, 'low quality still has a noise field to draw');
  assert.equal(low.bloom, false, 'low quality turns the bloom off');
  assert.ok(low.scale <= base.scale);
  assert.equal(high.scale, 1);
  assert.equal(high.octaves, 5);
  assert.equal(high.bloom, true);
  assert.deepEqual(auto, base, 'auto is the profile, unchanged');
  for (const settings of [low, auto, high]) {
    assert.ok(settings.scale > 0 && settings.scale <= 1, `scale ${settings.scale}`);
    assert.ok(settings.octaves >= 1 && settings.octaves <= 8, `octaves ${settings.octaves}`);
  }
});

test('a profile does not gain anything when the quality goes up', () => {
  // `visualSettings` returns a copy: a quality change must not be able to write
  // through into the profile the next setting is derived from.
  const profile = detectProfile(nav(), win(false));
  const before = profile.visual.octaves;
  visualSettings(profile, 'high').octaves = 99;
  assert.equal(profile.visual.octaves, before);
  assert.equal(profile.visual.scale > 0, true);
});

test('the flash cap is low, and it is the default', () => {
  // −11 dB of headroom on a picture that is mostly black. The claim is not "a
  // small flash is safe" — on this material it is not, which is why the cap is
  // this low and why 'full' is opt-in.
  assert.equal(DEFAULT_FLASH_MODE, 'soft');
  assert.equal(FLASH_DEPTH.soft, 0.18);
  assert.ok(FLASH_DEPTH.full > FLASH_DEPTH.soft, 'the opt-in is not louder than the default');
  assert.ok(FLASH_DEPTH.full <= 1, 'the opt-in is more than a full-scale flash');
  // And every mode has a cap at all: an uncapped mode is a mode nobody has
  // decided anything about.
  for (const mode of ['soft', 'full'] as const) {
    assert.ok(FLASH_DEPTH[mode] > 0 && FLASH_DEPTH[mode] <= 1, `${mode} is capped at ${FLASH_DEPTH[mode]}`);
  }
});
