# Aurora

Endless synth-pop & aurora visuals, generated live in the browser. A sibling
of FOraveR (techno) and Jeffer (electro): the same seeded, time-addressable
conductor design, a pure Web Audio graph, and a WebGL2 shader stack — but the
subject is the northern lights over a night sky, and the music is synth-pop at
108–128 bpm (dawn → verse → chorus → bridge → finale), on the shared
`@fractal-rave/shared` foundations (Rng, seed links, noise, conductor math).

## Run it

```bash
npm install        # once per clone; workspace packages resolved by file:
npm run dev        # vite dev server on :8091
```

or serve the build:

```bash
npm run build      # vite build → dist/
npm run serve      # static server for dist/ with COOP/COEP headers
```

The seed lives in the URL fragment (`#s=<seed>`), so a link carries a set and
nothing ever reaches a server. A junk seed is refused; a seed link reproduces
the set exactly, an hour in, in a fresh page.

## Verify it

```bash
npm run typecheck  # tsc over src/ and tools/
npm test           # unit tests (node --test) over the conductor, harmony,
                   # palette, patterns, loudness/DSP and the device profile
npm run smoke      # build + real headless Chrome: click Begin, measure frames,
                   # decode and measure screenshots, dawn-vs-chorus, the pulse
                   # cap, sleep suspend; 14 checks, exits non-zero on failure
npm run preview    # show a captured PNG in the terminal as colour blocks
npm run icons      # regenerate public/icons/*.png (deterministic)
```

Rendering cannot be verified from logs — every visual claim in the smoke test
is measured from a decoded PNG (`.smoke/smoke.png`, `.smoke/chorus.png`), and
`npm run preview .smoke/chorus.png` shows any capture to a human.

## What is asserted

- **The conductor is pure and time-addressable.** `stateAt`, `chordAt`,
  `gridAt`, `drift` can be called in any order, any number of times, and never
  move the set. A seed describes the same journey an hour in, in a fresh
  conductor.
- **The arrangement grammar holds.** Sections run in order without gaps or
  overlaps; each goes only where its recipe allows (`SECTIONS[name].next`);
  tempo changes land on section boundaries; chords land on bars, in the key,
  eight bars or longer. The set opens with a dawn and reaches a chorus, and a
  swell announces the chorus from the passage before it.
- **The photosensitivity cap.** A soft picture cannot gain more than a fifth
  of its light from the pulse; `full` is a deliberate opt-in and the only mode
  past the cap. Asserted at the conductor level and again against the live page.
- **The audio graph schedules real music.** Bars land on the grid, voices
  exist per instrument, the loudness meter is alive, and the pure DSP helpers
  (saturation curve, noise buffer, decaying reverb impulse) are tested without
  a browser.
- **The picture is an aurora, not a test pattern.** The smoke test requires a
  non-black, non-grey, non-blown-out capture, and a chorus measurably brighter
  than a dawn.

## Status

Not yet done: a soak test (`soak.ts` exists in the sibling apps), the offline
loudness render through the real graph (`src/offline.ts` is a stub returning
nominal numbers), and bloom uniforms (`bindBloomUniforms` is a placeholder —
the bloom pass currently re-draws the scene texture).
