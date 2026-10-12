# Working in `apps/fo-raver/`

**FOraveR — Endless Techno & Psychedelic Visuals**, the other end of the pair from Generative
Singularity: where that one glides through ambient drone and deep space with no pulse at all, this
one plays four on the floor at 122–140 bpm under a kaleidoscope/plasma/fractal/noise stack. Same
architecture, opposite tempo. `specs.md` is the specification; `README.md` is what exists and what
has been verified. The monorepo's root `AGENTS.md` (`../../AGENTS.md`) orients the whole repository;
this app is TypeScript, outside the Cargo workspace.

## Shape of the thing

A static web app in **TypeScript, built by Vite**, with **no runtime dependencies**: plain CSS, GLSL
in WebGL2, Web Audio. `dist/` is the site; `tools/serve.ts` serves it locally with the headers it
wants. Nothing else is in the toolchain — no framework, no audio library, no test runner.

```
index.html                the Vite entry: the DOM shell, one <script type="module">
public/                   served as-is: styles.css, manifest.webmanifest, icons/
src/
  conductor.ts      the set: sections, chords, events, the bar clock — pure, seeded, time-addressable
  patterns.ts       sixteen-step templates, ghosts and fills — a hash of (seed, bar, section)
  harmony.ts palette.ts      modes and degrees; psychedelic palettes — pure
  rng.ts noise.ts seed.ts profile.ts types.ts
  audio/            engine (graph + bar scheduler), voices, dsp, loudness, meter-worklet
  visuals/          shaders (GLSL as strings), bloom, renderer (WebGL2, dynamic resolution)
  offline.ts        render the real engine on an OfflineAudioContext and measure it
  ui.ts main.ts pwa.ts sw.ts debug.ts
tools/              chrome.ts (one headless-Chrome harness), png.ts, serve.ts,
                    preview.ts, make-icons.ts, smoke.ts
tests/              *.test.ts — node --test over the pure modules
dist/               built (gitignored)
```

## TypeScript conventions

Identical to `../singularity/AGENTS.md`, and for the same reasons: two tsconfigs both clean
(`tsconfig.json` is the app, `tsconfig.tools.json` is `tools/` + `tests/`), `strict` on with every
class field declared explicitly, and shared contracts in `src/types.ts`.

**The conductor is the source of truth for both halves.** Audio and picture both read it; neither
writes to it (except the audio engine's smoothed levels, which the picture reads). If a decision
belongs to both halves — what bar we are on, when a section ends, what the flash budget is — it
belongs in `conductor.ts` and it must be derivable from the seed and the time alone.

## Rules that must hold

- **Queries never consume randomness.** `stateAt(t)`, `chordAt(t)`, `gridAt(t)` and friends may be
  called in any order, any number of times, ahead or behind. `tests/conductor.test.ts` covers this
  and it is the test to read first when something desynchronises.
- **The step patterns are a hash, not a schedule.** `patternsFor(seed, bar, sectionIndex)` must
  answer the same sixteen steps however often, in whatever order, and from whatever direction it is
  asked. That is what lets the scheduler and the picture agree about a bar without either of them
  owning a list — and it is why `conductor.ts` has no pattern state in it at all.
- **`ensure(t)` keeps one entry beyond `t`, of every kind.** For the chords that means *one chord
  that starts after the target*, not one bar past it: a bass line moves every eight bars or more,
  and "one bar past the target" leaves `chordAt` unable to say what comes next.
- **Everything is on the grid.** Every note, hit and section change lands on a bar or a beat.
  Tempo changes land on section boundaries. Bar counts are multiples of four. This is the one rule
  that separates this app from Singularity's, and it is not optional here.
- **Bar arithmetic needs an epsilon.** `timeOfBar(40)` divided back by `barSeconds` can land a hair
  under 40. Without the epsilon in `gridAt`, bar 40 reads as bar 39: the kick is scheduled a bar
  late, the flash a bar early, and neither looks like a bug.
- **A riser belongs to the passage before the drop.** It can only be generated when the drop is,
  because only then is the successor known. Deciding it from the section's list of possibilities
  means most drops arrive with nothing in front of them.
- **The flash cap is a design decision, not a shader detail.** `FLASH_DEPTH` in `src/profile.ts` is
  the number; the conductor multiplies the kick envelope by it and the picture draws what comes out.
  `soft` (the default, and the only mode ever selected automatically) caps the picture's gain from
  the kick at 0.22. `full` is an opt-in in the HUD and is worth about 1.0. Changing the cap means
  changing that constant and the assertion in `tests/conductor.test.ts`, and saying so in
  `specs.md` §3.
- **Shaders are embedded strings**, `src/visuals/shaders.ts`, not fetched assets — the page must
  work offline and from anywhere. **Backticks inside a GLSL comment will terminate the JS template
  literal**: do not use them, and remember that `sample` is a reserved word in GLSL ES. The
  AudioWorklet follows the same rule (`src/audio/meter-worklet.ts`, loaded from a Blob URL), so the
  app has no second bundle.
- **One clock**: the `AudioContext`'s. `main.ts` falls back to wall time only when audio could not
  start at all. If you add a layer that needs time, ask the conductor for it.
- **Audio scheduling is written ahead** (12 seconds on the context clock, one bar at a time). Do not
  add work that must happen within a tick; a hidden tab's timers are throttled to about 1 Hz.
- **Mobile is a profile, not a different app** (`src/profile.ts`): fewer voices, fewer octaves,
  smaller buffer, no bloom. `profile.visual` is only a starting guess — the renderer still measures.
- **Audio-only means no GPU work**: stop the frame loop and drop the canvas, keep the sound.

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
smoke test launches. Every script that runs a tool compiles it first (`npm run compile:tools` →
`tools-dist/`), which is what makes them work on a node built without TypeScript support.

The dependency tree is deliberately tiny: `vite` and `typescript` (plus `@types/node`) are
**devDependencies in this app's `package.json`**, and nothing is installed globally. There is no
runtime dependency, and no formatter, bundler plugin, audio library or test runner beyond these —
see the root `../../AGENTS.md` for why (this tree lives under Synology Drive, which syncs badly).

## Verifying a change

```bash
npm run typecheck
npm test                          # pure logic: conductor, patterns, harmony, palettes, loudness
npm run smoke && npm run preview  # the app, in a real browser, with a real picture
```

The division of labour, so a new check lands in the right place: **`npm test`** is "is the logic
right" (fast, no browser, 89 checks); **`npm run smoke`** is "does the thing work at all" (it must
fail loudly and fast); and **there is no `npm run soak` here yet** — nothing has answered "does it
stay that way", and porting `../singularity/tools/soak.ts` is the first thing that would. If you add
a browser measurement that is about *the picture* rather than about the app working, `tools/stars.ts`
in Singularity is the model: it measures layers **by subtraction**, using `__foraver.draw({ layers })`
to hold everything but the layer under test still, because two captures that differ only in what you
asked for are the only way to say what a layer *does*.

The smoke test is deliberately picky. It fails on script errors, missing WebGL2, no frames, a
stopped clock, a section that is not a section, a screenshot that is black, grey or blown out, a
drop that is not a different picture from an intro, a flash cap that has been raised without being
asked for, an offline render that is silent or out of the loudness region, and a seed link that does
not reproduce the set an hour in from a fresh page.

It serves and drives `dist/`, so **run `npm run build` first** (`npm run smoke` does). It uses a
**fixed seed** (`--seed smoke-test`) so two runs render the same moment and the numbers are
comparable.

**Wait for evidence, not for the clock.** Rendering here is software (SwiftShader) at a few frames
a second, and there is no audio device, so the `AudioContext` clock runs at roughly half wall time.
The sleep and resume checks poll for the state they need with a deadline instead of sleeping a fixed
interval; a fixed `delay()` there is a coin flip, and it will be one on any machine without a sound
card too.

**Rendering cannot be verified from a log.** Capture, decode and look: `.smoke/smoke.png` (the intro)
and `.smoke/drop.png` (a drop, found by asking the conductor when the next one starts), then
`npm run preview` on either, which prints mean, standard deviation, region means and a luminance
histogram. A healthy drop is centred near 0.5 with nothing above 0.8; a mean that has crept towards
the ceiling is exposure, and a histogram that has collapsed into one bin is a layer that stopped
moving.

**Two clocks are compared in the page, never across the CDP boundary.** The sleep checks read the
journey clock and `performance.now()` in a *single* `Runtime.evaluate`: a host timestamp against a
page one is skewed by round trips that run to seconds here, which would either fail a healthy build
or pass a broken one.

## Things that will bite

The full list, with the story behind each, is in `README.md` § "Things that will bite". The ones
that have already cost an afternoon:

- **`sample` is reserved in GLSL ES.** A variable named that does not warn, it fails the whole
  shader, and the symptom is a black rectangle plus a console message nobody reads.
- **Never sample the texture you are drawing into.** The blur passes ping-pong (scene → A, A → B).
  One target is a feedback loop, and what it looks like depends on the driver.
- **Ask for `EXT_color_buffer_float`.** RGBA16F textures can be created everywhere in WebGL2 and
  drawn into almost nowhere; the failure is an incomplete framebuffer, not an exception. The
  renderer falls back to RGBA8 and says so in the console.
- **The flashes control is not a preference.** It is a photosensitivity decision. `soft` is the
  default on every device, including one that has asked for reduced motion.
- **The service worker's precache list is hand-written and must match the build**: Vite emits the
  entry at a stable path (`js/index.js` — `entryFileNames` in `vite.config.ts`) and copies `public/`
  verbatim, so `SHELL` in `src/sw.ts` is exact rather than best-effort. `cache.addAll` is
  all-or-nothing.
- **`tools/png.ts` is the only PNG code** (encode, decode, analyse); `make-icons`, `smoke` and
  `preview` all use it. Do not add an image dependency.
- **The meter worklet posts `{ pcm: [left, right] }`.** Read `message.data.pcm`; posting the buffers
  bare sends an array with no `pcm` in it, and the meter silently never hears anything while
  `meterAvailable` stays true.
- **An oscillator that is never started is silence, and stopping it throws.**
- **`src/audio/loudness.ts`, `tools/serve.ts`, `tools/chrome.ts` and `tools/png.ts` are copied from
  `apps/singularity`, not shared.** Neither app can import the other's sources. If you change one of
  them here, change it there, and note it.
