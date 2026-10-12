# FOraveR — Endless Techno & Psychedelic Visuals

An endless generative techno set and a full-screen stack of psychedelic visuals, generated live in
your browser. No stream, no server, no samples, no accounts: open the page, click enter, and the
set builds, drops, breaks down and comes back, forever.

**This is a web app, not a stream.** There is no uplink and nothing is recorded — the kick, the
bass, the stabs, the risers, the kaleidoscopes, the plasmas and the fractals are all synthesised
here, in the tab, from a seed. A seed link carries the whole thing.

It is the other end of the pair from [`../singularity`](../singularity), which is the same
architecture with the tempo taken out: that one is endless ambient drone and deep space, this one
is 122–140 bpm and a kaleidoscope.

`specs.md` is the specification. This file is what exists and what has been verified.

---

## Status against the roadmap

Steps 1–5 of `specs.md` §7 are done; **6 (soak) and 8 (layer measurement) are not**. In detail:

| Step | State |
| --- | --- |
| Specs | `specs.md` |
| Audio on Web Audio | **done** — kick, sub-bass, hats, claps, percussion, stabs, arps, pad, risers, impacts, crashes, sirens, sweeps, through echo and room into a self-measuring master |
| Arrangement | **done** — five passage types drawn from a seeded graph, whole four-bar phrases, risers in the last two bars before a drop |
| Patterns | **done** — a hand-written bank of sixteen-step templates per instrument, drawn per phrase, ghosted per bar, with fills |
| Visuals | **done** — kaleidoscope, plasma, escape-time fractal and flow-field noise, mixed by the section, with dynamic resolution and bloom |
| The app | **done** — enter gesture, hidden HUD, seed and copy link, quality, flash mode, audio-only, sleep timer, PWA, mobile profile |
| Verification | **done** — 89 unit tests, 41 headless-browser checks |
| Soak | **not done** — `tools/soak.ts` is not ported. Nothing here has run for eight hours |
| Layer measurement | **not done** — `tools/stars.ts` is not ported |

## Verified

```bash
npm run typecheck    # both tsconfigs, clean
npm test             # 89 tests over the pure modules, ~4 s, no browser
npm run smoke        # build, then headless Chrome: 41 checks, ~3 min
npm run preview      # show the last capture as blocks (--ascii for a ramp)
npm run build        # the static site, 67 kB of JS (24 kB gzipped)
```

`npm run smoke` drives the built site through a real browser: it clicks "enter" like a person,
waits for frames and a running clock, decodes the screenshot *and* a screenshot of a drop and
measures both, asserts the flash cap holds while polling it, exercises every control, arms the
sleep timer and watches the fade through to the suspend and the resume, renders the real engine on
an `OfflineAudioContext` and measures the samples, and checks that a seed link reproduces the set
an hour in from a fresh page.

Last run on this machine: **41/41 checks passed**, 89/89 tests passed. The offline render measured
**−16.83 LUFS** against a −14 target (the live trim walks up toward it once the meter has blocks),
**−3.20 dBTP** under a −1 dBTP ceiling, 25 bars and 1220 voices scheduled in 45 s.

## Known limits of this machine

- **Headless Chrome here is SwiftShader** — software WebGL2 — and has no
  `EXT_color_buffer_float`, so the smoke run draws in 8 bits per channel with bloom off and gets
  about 3 fps. On real hardware the renderer picks float targets and the frame-rate numbers in
  `specs.md` §6 are unverified.
- **There is no audio device**, so loudness is measured but never heard, and the `AudioContext`
  clock runs at roughly half wall time. The smoke test polls for the state it needs instead of
  sleeping through it, for that reason; do not "fix" that into a fixed delay.

## Things that will bite

- **The conductor is the source of truth, and it is time-addressable.** `stateAt(t)`,
  `chordAt(t)`, `gridAt(t)` and friends may be called in any order, any number of times, ahead or
  behind. Nothing that answers a question may consume a random number — the *patterns* are a hash
  rather than a schedule precisely so that they cannot.
- **`ensure(t)` keeps one entry beyond `t`, of every kind.** "One bar past the target" is not
  enough for the chords: a bass line moves every eight bars or more, so the test is "one chord that
  *starts* after the target", or `chordAt` answers "and then what?" with the current chord and the
  palette fades into something it has never heard of.
- **Bar arithmetic needs an epsilon.** `timeOfBar(40)` is `entry.t + 40 * barSeconds`; dividing
  that back by `barSeconds` can land a hair under 40, so bar 40 reads as bar 39 — the kick gets
  scheduled a bar late and the flash a bar early, and neither looks like a bug.
- **A riser belongs to the passage before the drop, and can only be decided when the drop exists.**
  Deciding it from the section's list of *possibilities* gives every drop a riser only when the
  dice are kind about it; six drops in seven had nothing in front of them before this was fixed.
- **Bar counts must stay multiples of four.** The fills live on the last bar of each phrase, and a
  passage of 17 bars has no last bar.
- **`sample` is a reserved word in GLSL ES.** A variable named that does not merely warn: the
  whole shader fails to compile and you get a black rectangle and a console message nobody reads.
  This bit the bloom pass when it arrived from `apps/singularity`, where it had been broken since
  the bloom landed; it is fixed there now (`sample` → `texelColor`, commit `204ce22`).
- **Never sample the texture you are drawing into.** The two blur passes read and write different
  targets (scene → A, A → B). Blurring A into A is a feedback loop, which some drivers render as a
  shimmering mess and others as flat grey.
- **Ask for `EXT_color_buffer_float`; do not assume it.** WebGL2 will let you *create* an RGBA16F
  texture everywhere, but not *draw into* one without the extension, and the failure is an
  incomplete framebuffer rather than an exception. The renderer falls back to RGBA8.
- **The flashes control is a photosensitivity decision.** `FLASH_DEPTH` in `src/profile.ts` is the
  number, the conductor multiplies the kick envelope by it, and `tests/conductor.test.ts` asserts
  the cap. `full` is opt-in and is never selected automatically, including for a reader who has
  asked their system for reduced motion.
- **The service worker's precache list is hand-written and must match the build**: Vite emits the
  entry at a stable path (`js/index.js` — `entryFileNames` in `vite.config.ts`) and copies
  `public/` verbatim, so `SHELL` in `src/sw.ts` is exact rather than best-effort. Change the output
  paths and the list changes with them, or offline install breaks (`cache.addAll` is
  all-or-nothing).
- **`tools/png.ts` is the only PNG code** (encode, decode, analyse); `make-icons`, `smoke` and
  `preview` all use it. Do not add an image dependency.
- **`AudioWorkletNode` needs `audioWorklet.addModule(url)`**, and the worklet source is a string in
  `src/audio/meter-worklet.ts` turned into a Blob URL. It posts `{ pcm: [left, right] }`; if you
  change that shape, change both sides. If the meter is unavailable the engine keeps playing with a
  fixed trim, and `meterAvailable === false` is a real state, not a bug.
- **An oscillator that is never started is silence, and stopping one that already ended throws.**
  Every voice in `src/audio/voices.ts` starts and stops both of its sources.

### What `tools/stars.ts` found

`npm run stars` measures each layer against what the shader claims it is, by subtraction. Four
things it turned up that reading the source does not tell you:

- **The layers are averaged, not summed.** The shader ends with `if (weight > 0.0001) colour /= weight;`,
  so turning a fourth layer on *rescales the other three*. A cumulative capture staircase therefore
  gives each layer's **marginal effect**, not its appearance — and total flux need not rise when a
  layer is added, because the stack is re-normalised around it. The tool measures both: each layer
  alone at full weight (what it looks like) and the differenced staircase (what it changes). An
  earlier version of this check asserted "adding a layer only ever adds light" and failed at
  `44279 < 532847 < 540940 > 474828` — the check was wrong, not the shader.
- **The picture is not measurable for the first few frames after entering.** Three captures of one
  frozen frame differed by up to **0.55** while later captures of the *same* setting differed by
  0.009: the picture is still settling, and the tool was measuring the settling. After discarding
  four warm-up captures the same comparison reads mean 0.00003, largest 0.0039 — one 8-bit step.
- **A symmetry metric must not sample points that rotate out of the frame.** Rotating about the
  centre carries edge pixels outside it, and an out-of-bounds sample has nothing to compare against;
  treated as black, it measures the shape of the *frame*. A flat mid-grey image scored **0.10** that
  way and a genuinely six-fold kaleidoscope scored **0.16** — larger than the 0.22 of a real
  asymmetry, so the two could not be told apart. Restricted to the inscribed circle the same metric
  reads 0.0046 on a symmetry axis and 0.1381 half a wedge off it. `stars.ts` validates the metric
  against synthetic images with known symmetry before trusting it.
- **Domain-warped fbm is not a high-frequency layer.** The flow field and the plasma measure within
  2% of each other on pixel-scale energy (0.00461 against 0.00470): composing fbm of fbm of fbm
  smooths as much as it displaces, and the plasma is 0.3 fbm already. The layer that *is* finest is
  the fractal, whose escape-time filaments lead by nearly 3×. Two smaller notes: `uIterations` is
  clamped to a floor of 8, so capturing at 6 silently measures 8; and the four layers correlate
  0.68–0.85 with each other because they all go through the same ramp, so correlation is a weak
  distinctness test and *difference* is the sharp one.

## A note on the shared code

`src/audio/loudness.ts`, `tools/serve.ts`, `tools/chrome.ts` and `tools/png.ts` are copied from
`apps/singularity` rather than imported from it: neither app can import the other's sources from
outside its own directory tree, and two copies of a standard that must agree is worse than one
shared file neither can reach. The loudness meter is byte-identical and its tests were adapted, not
rewritten. **If you change it here, change it there.**

Two things in Singularity's copies were *not* carried over:

- The bloom pass used `sample` as a variable name, so that program never compiled, so
  `Renderer.#build()` returned false and the bloom was silently missing. It is fixed in
  `apps/singularity` now (commit `204ce22`), and its smoke test passes 33/33.
- `hexToRgb` was **not** changed, contrary to an earlier note in this file. It reads the three
  channels once each — `(n >> 16)`, `(n >> 8)`, `(n & 255)` — in both this app and Singularity, and
  `src/palette.ts` is byte-identical between them. The claim that it returned the blue channel twice
  was wrong; `tests/palette.test.ts` here checks the correct behaviour and is not a regression test
  for a bug that never existed.

## Layout

```
index.html                the Vite entry: the DOM shell, one <script type="module">
public/                   served as-is: styles.css, manifest.webmanifest, icons/
src/
  conductor.ts      the set: sections, chords, events, the bar clock — pure, seeded, time-addressable
  patterns.ts       sixteen-step templates, ghosts and fills — a hash of (seed, bar, section)
  harmony.ts        modes, degrees, chord building, registers — pure
  palette.ts        psychedelic palettes, blended across chord and section — pure
  rng.ts noise.ts seed.ts profile.ts types.ts
  audio/            engine (graph + bar scheduler), voices, dsp, loudness, meter-worklet
  visuals/          shaders (GLSL as strings), bloom, renderer (WebGL2, dynamic resolution)
  offline.ts        render the real engine on an OfflineAudioContext and measure it
  ui.ts main.ts pwa.ts sw.ts debug.ts
tools/              chrome.ts (one headless-Chrome harness), png.ts, serve.ts,
                    preview.ts, icons, smoke.ts
tests/              *.test.ts — node --test over the pure modules
dist/               built (gitignored)
```

## Commands

```bash
npm run dev                    # http://127.0.0.1:8089/ while developing (Vite, TS on the fly)
npm run build                  # app + service worker into dist/
npm run serve                  # serve dist/ on :8089 (COOP/COEP, correct MIME types)
npm run typecheck              # tsc over the app, then over tools/ + tests/
npm test                       # 89 tests, ~4 s, no browser
npm run smoke                  # build, then headless Chrome: 41 checks, ~3 min
npm run preview                # show the last capture as blocks (add --ascii)
npm run icons                  # regenerate public/icons/*.png
```

Node 22 is assumed (it has `WebSocket` and `fetch`). `CHROME_PATH` overrides the browser the
smoke test launches.

The tools are TypeScript, and `npm run compile:tools` compiles `tools/` and `tests/` to JavaScript
in `tools-dist/` before any of the scripts above run — the same route `apps/singularity` takes, and
for the same reason: it is the one that works on a node built without TypeScript support, where
`node --experimental-strip-types` fails with `ERR_NO_TYPESCRIPT`. Nothing in `tools/` knows the
difference; `tsconfig.tools.json` does not extend the app's config because it needs an `outDir` and
an emit.

The dependency tree is deliberately tiny: `vite` and `typescript` (plus `@types/node`) are
**devDependencies in this app's `package.json`**, and nothing is installed globally. There is no
runtime dependency, and no formatter, bundler plugin, audio library or test runner beyond these —
see the root `../../AGENTS.md` for why.
