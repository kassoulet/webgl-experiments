// Seeds in and out of the URL. A link is only worth anything if it reproduces
// the set, so the fragment is the whole contract: `#s=<seed>` in, the same
// string out, and nothing else in the URL is trusted (spec §5).

import { normalizeSeed } from './rng.ts';
import type { Seed } from './types.ts';

/** What a seed is allowed to look like: enough to be memorable, little enough
 *  to be a URL fragment. */
const SEED_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** The seed out of a `location.hash`, or null if there isn't one. */
export function parseSeed(hash: string): Seed | null {
  const raw = String(hash ?? '').replace(/^#/, '');
  if (!raw) return null;
  const params = new URLSearchParams(raw.startsWith('?') ? raw : `?${raw}`);
  const value = params.get('s');
  return value ? cleanSeed(value) : null;
}

/** The fragment for a seed. Always `s=`, so the format never has to be guessed. */
export function formatSeedHash(seed: Seed): string {
  return `#s=${encodeURIComponent(String(seed))}`;
}

/**
 * A typed-in seed, cleaned: trimmed, and rejected outright if it is not
 * something a link could carry. Returns '' for junk so the caller can tell
 * "refused" from "accepted".
 */
export function cleanSeed(value: string): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';
  if (!SEED_PATTERN.test(trimmed)) return '';
  return trimmed;
}

/** True when two seeds would produce the same set. */
export function sameSeed(a: Seed, b: Seed): boolean {
  return normalizeSeed(a) === normalizeSeed(b);
}
