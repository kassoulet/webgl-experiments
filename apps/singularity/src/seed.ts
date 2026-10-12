// Seeds travel in the URL fragment, so a shared link carries a journey and
// nothing else does (spec §4: "a seed (and a 'copy link' that carries it)").
// The fragment never reaches a server, which keeps that promise literal.

const KEY = 's';
const MAX_SEED_CHARS = 64;

/** Keep seeds URL-safe and bounded: letters, digits, dash, underscore, dot. */
export function cleanSeed(seed: string | null | undefined): string {
  return String(seed ?? '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .slice(0, MAX_SEED_CHARS);
}

export function parseSeed(hash: string): string | null {
  const raw = String(hash ?? '').replace(/^#/, '');
  if (!raw) return null;
  // Accept both `#s=seed` and a bare `#seed`.
  if (raw.startsWith(`${KEY}=`)) {
    return cleanSeed(new URLSearchParams(raw).get(KEY) ?? '') || null;
  }
  return cleanSeed(raw) || null;
}

export function formatSeedHash(seed: string): string {
  return `#${KEY}=${encodeURIComponent(cleanSeed(seed))}`;
}

/** The echo of the seed in a reader's ear, shown before the piece starts. */
export function seedMoodLine(seed: string): string {
  const s = cleanSeed(seed);
  return s ? `journey seed: ${s}` : 'journey seed: (none)';
}
