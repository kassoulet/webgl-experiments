// Seeds travel in the URL fragment, so a shared link carries a set and nothing
// else does. The fragment never reaches a server, which keeps that promise literal.

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
    const params = new URLSearchParams(raw);
    return cleanSeed(params.get(KEY) ?? '') || null;
  }
  return cleanSeed(raw) || null;
}

export function formatSeedHash(seed: string): string {
  return `#${KEY}=${encodeURIComponent(cleanSeed(seed))}`;
}

/** The echo of the seed on the enter screen, shown before the set starts. */
export function seedMoodLine(seed: string): string {
  const s = cleanSeed(seed);
  return s ? `set seed: ${s}` : 'set seed: (none)';
}