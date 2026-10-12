# Working in `apps/singularity/`

(Formerly the standalone `generative-singularity/`; now in the FractalRave monorepo. The app kept
its name.)

**Generative Singularity — Endless Cosmic Drone & Deep Space Visuals**, the sister project of
Generative Entropy: an endless ambient piece and a deep-space picture generated live in one browser
tab. `specs.md` here is the specification; `README.md` is what exists and what has been verified.
The monorepo's root `AGENTS.md` (`../../AGENTS.md`) orients the whole repository; this app is
TypeScript, outside the Cargo workspace.

## Shape of the thing

A static web app in **TypeScript, built by Vite**, with **no runtime dependencies**: plain CSS,
GLSL in WebGL2, Web Audio. `dist/` is the site; `tools/serve.ts` serves it locally with the headers
it wants. Nothing else is in the toolchain — no framework, no audio library, no test runner.

```
index.html                the Vite entry: the DOM shell, one <script type="module">
public/                   served as-is: styles.css, manifest.webmanifest, icons/
src/
  conductor.ts      the piece: key, mode, chords, moods, events — pure, seeded, time-addressable
  harmony.ts        modes, chord shapes, voice leading, modulation — pure
  palette.ts        nebula palettes, harmony -> colour — pure
  rng.ts noise.ts seed.ts profile.ts types.ts
  audio/            engine (graph + scheduler), voices, tape, loudness, meter-worklet
  visuals/          shaders (GLSL as strings), renderer (WebGL2, dynamic resolution)
  offline.ts        render the real engine on an OfflineAudioContext and measure it
  ui.ts main.ts pwa.ts sw.ts debug.ts
tools/              chrome.ts (one headless-Chrome harness for all three),
                    png.ts, serve.ts, make-icons.ts, preview.ts,
                    smoke.ts, stars.ts, soak.ts,
                    soak-analysis.ts (journal -> checks -> report; pure, tested)
tests/              *.test.ts — node --test over the pure modules
dist/               built (gitignored): index.html, js/index.js, styles.css, sw.js, icons/
```

## TypeScript conventions

- **Two tsconfigs, both must be clean**: `tsconfig.json` is the app (`lib: DOM`, `types: []`, no
  node globals) and `tsconfig.tools.json` extends it for `tools/` + `tests/` (`types: ["node"]`).
  `npm run typecheck` runs both.
- **`strict` is on, and this compiler does not infer class properties from constructor
  assignments.** Every field a class assigns is declared explicitly (`private readonly ctx:
  BaseAudioContext;`), and nodes built in `start()` use definite assignment (`ctx!: ...`) rather
  than null checks in every method.
- **Shared contracts live in `src/types.ts`** — `ConductorState`, `Profile`, `Levels`, `EngineStats`,
  `RenderStats`. Audio and visuals read the same types; do not redeclare a shape next to its user.
- **Strip-types friendly**: no enums, no parameter properties, no namespaces — `node
  --experimental-strip-types` runs the sources directly, so the tests need no build.
- **Node's built-in globals only in tests and tools**: `--experimental-strip-types` + Node 22's
  `WebSocket` and `fetch` are what the smoke test is built on.

**The conductor is the single source of truth.** Audio and picture both read it, neither writes to
it (except the audio engine's measured levels, which the picture reads). If a decision belongs to
both halves — a chord change, a mood, an event, the camera — it belongs in `conductor.ts`, and it
must be derivable from the seed and the time alone.

## Rules that must hold

- **Queries never consume randomness.** `stateAt(t)`, `chordAt(t)`, `eventsBetween()` and friends
  may be called in any order, any number of times, ahead or behind. Each schedule entry stores the
  `hold` it was generated with, and each list is built in increasing time order from its own forked
  stream. Breaking this silently breaks both the music and the tests
  (`tests/conductor.test.ts` "queries do not consume randomness").
- **`ensure(t)` always keeps one entry beyond `t`** in the chord and section lists, or a query just
  before a change cannot see what comes next (that bug produced a palette that jumped at every
  chord).
- **No steps, anywhere.** Every audible or visible parameter change is a glide or a cross-fade of
  several seconds: `setTargetAtTime`/ramps in the audio, `wander()`/fbm in the conductor. A mood's
  *warmth* fades too, not just its levels.
- **Nothing is triggered on a timer for sound.** Layers fade in and out; the only envelope that
  starts at a moment is a far-away event. Timing is in seconds; there is no tempo.
- **Shaders are embedded strings**, `src/visuals/shaders.ts`, not fetched assets — the page must
  work offline and from anywhere. Backticks inside a GLSL comment will terminate the JS template
  literal: do not use them. The AudioWorklet follows the same rule
  (`src/audio/meter-worklet.ts`, loaded from a Blob URL), so the app has no second bundle.
- **One clock**: the `AudioContext`'s. `main.ts` falls back to wall time only when audio could not
  start at all. If you add a layer that needs time, ask the conductor for it.
- **Audio scheduling is written ahead** (`LOOKAHEAD` seconds on the context clock). Do not add work
  that must happen within a tick; a hidden tab's timers are throttled to about 1 Hz.
- **Mobile is a profile, not a different app** (`src/profile.ts`): fewer voices, the 2D nebula, a
  smaller buffer. `profile.visual` is only a starting guess — the renderer still measures.
- **Audio-only means no GPU work**: stop the frame loop and drop the canvas, keep the sound.

## Commands

```bash
npm run dev                    # http://127.0.0.1:8088/ while developing (Vite, TS on the fly)
npm run build                  # app + service worker into dist/
npm run serve                  # serve dist/ on :8088 (COOP/COEP, correct MIME types)
npm run typecheck              # tsc over the app, then over tools/ + tests/
npm test                       # 75 tests, ~0.4 s, no browser
npm run smoke                  # build, then headless Chrome: 33 checks, ~1.5 min
npm run stars                  # build, then capture and measure the star layers: 27 checks, ~1.5 min
npm run soak                   # build, then watch clock, heap and loudness (3 min; --hours 8, --detach)
npm run soak:report            # report on the newest soak journal, no browser
npm run preview                # show the last capture as blocks (add --ascii)
npm run icons                  # regenerate public/icons/*.png
```

`smoke`, `stars` and `soak` all drive the same built site through the same harness
(`tools/chrome.ts`: launch, CDP, navigate, evaluate, screenshot, teardown). Add a check to the
closest one rather than writing a fourth launcher.

Node 22 is assumed (it has `WebSocket`, `fetch` and module syntax detection). `CHROME_PATH`
overrides the browser the smoke test launches.

The dependency tree is deliberately tiny: `vite` and `typescript` (plus `@types/node`) are
**devDependencies in this app's `package.json`**, and nothing is installed globally. There is no runtime
dependency, and no formatter, bundler plugin, audio library or test runner beyond these — see the
root `../../AGENTS.md` for why (this tree lives under Synology Drive, which syncs badly).

## Verifying a change

```bash
npm run typecheck                           # both configs
npm test                                    # pure logic: conductor, harmony, loudness, seeds
npm run smoke && npm run preview            # the app, in a real browser, with a real picture
npm run stars                               # spec §3's star layers, measured from captures
npm run soak -- --minutes 10                # clock, heap, node counts and loudness over time
```

The division of labour, so a new check lands in the right place: **`smoke`** is "does the thing
work at all" (it must fail loudly and fast); **`stars`** is "is the picture the grammar spec §3
describes, rule by rule, in measured pixels" (a measurement, so it is slow and writes captures to
look at); **`soak`** is "does it stay that way" (nothing but time can answer it).

The smoke test is deliberately picky and is the only thing that proves the picture exists: it fails
on script errors, missing WebGL2, no frames, a stopped clock, a missing key/chord, an error from
the controls, a silent or out-of-range offline render, and on a screenshot that is black, flat or
washed out. It also drives the powers-of-ten paths nothing else reaches: the sleep fade end to end
(suspend, notice, resume — with the clock asserted frozen while asleep and asserted not to jump on
resume), and seed links (the fragment, the seed input, junk refused, and the same seed describing
the same piece an hour in, in a fresh page).

It serves and drives `dist/`, so **run `npm run build` first** (`npm run smoke` does). It uses a
**fixed seed** (`--seed smoke-test`) so two runs render the same moment and the numbers are
comparable; pass `--seed <other>` to look at a different journey.

**Wait for evidence, not for the clock.** Rendering here is software (SwiftShader) and rAF is
throttled, so a fixed `delay()` is a coin flip: the frames check, the sleep fade and the resume all
poll for the state they need with a deadline instead. When adding a check, do the same.

**Two clocks are compared in the page, never across the CDP boundary.** The sleep checks read the
journey clock and `performance.now()` in a *single* `Runtime.evaluate`: a host timestamp against a
page one is skewed by round trips that run to seconds here, which would either fail a healthy build
or pass a broken one. (They agree to ~10 ms across a suspend, which is the point of the check.)

**Rendering cannot be verified from a log.** Capture, decode and look:
`.smoke/smoke.png`, then `npm run preview` (ANSI blocks, `--ascii` for a ramp), which also prints
mean, standard deviation, region means and a luminance histogram. A broad low shelf in the
histogram means haze — the nebula or the Milky Way is lifted, and the picture is becoming fog
instead of deep space.

**`npm run stars` measures the star layers by subtraction**, which is why the shader and the hook
are shaped the way they are: `__singularity.draw({ time, camera, stars, density, brightness,
flare })` draws the *real* picture with one thing held still, so two captures that differ only in
`stars` differ only in that layer — a star layer adds, and the nebula, the band and the tone map are
identical. From those captures the tool checks parallax depth ordering and the ratio between layers,
colour temperature against the two tints the shader mixes, twinkle phase against the journey clock,
diffraction spikes as a **cross** test (bright along both axes, dark on the diagonals — a
neighbouring star cannot fake that), the Milky Way band's extent, tilt and dust structure, and that
a far-away event lights a star where the conductor's direction projects.

Two rules keep that honest, and both were learned the hard way. **A frozen draw must freeze
everything the frame loop writes** — freezing the time and the overrides but not the camera meant the
loop redrew each capture from the conductor's own camera, and every measurement silently compared
different skies. And **a metric needs a control**: "bright along an axis" is satisfied by any bright
star, so the spike test compares an axis against the diagonal, and "the sky is darker" needs a
region that is not a star to compare against.

**`npm run soak`** runs the built site (3 minutes by default; `--minutes N` or `--hours 8` for the
eight-hour test of spec §7) and samples the journey clock against wall time, the frame count, the
JS heap, DOM node and listener counts and the engine's own leveller trim, plus a fresh offline
render at each end and every `--loudness-every` minutes (60 by default). Each run writes its own
files under `.smoke/soak/`, named for when it started: an append-only JSONL journal, a markdown
report, a log, and `<stamp>-<seed>-first.png` / `-last.png` captures that prove the picture is
still being drawn. Its offline renders use *separate* seeds (`<seed>-loud-<t>`), and each allocates
tens of megabytes of audio buffers, so every heap sample forces a garbage collection first —
otherwise the heap trace would measure the tool rather than the piece. It survives the browser dying (counted as an outage and relaunched),
`--detach` hands it to its own session so it outlives the shell, and `npm run soak:report`
(`--report-only`) rebuilds the report from the newest journal — so a killed run still reports on
itself. The checks are in `tools/soak-analysis.ts`, which `tests/soak.test.ts` covers.

Known limits of this environment: headless Chrome has SwiftShader (software WebGL2) at roughly
1 fps, so the adaptive resolution barely moves and the frame-rate targets are unverified; the audio
device is null, so loudness is measured but not heard.

## Things that will bite

- `new AudioWorkletNode` needs `audioWorklet.addModule(url)`, and the worklet source is a string
  in `src/audio/meter-worklet.ts` turned into a Blob URL for that call. If the meter is
  unavailable the engine keeps playing with a fixed trim (`meterAvailable === false`) — that path is
  intentional, not a bug.
- `DynamicsCompressorNode.attack/release` are clamped to `[0, 1]` seconds by the browser; a "slow
  leveller" cannot be implemented with them. The slow levelling here is the BS.1770 feedback on the
  master trim.
- `AudioBufferSourceNode.start(when, offset, duration)` and every envelope are scheduled on
  `ctx.currentTime`; the scheduler runs 250 ms apart and writes 12 s ahead. If you shorten the
  lookahead, test it in a background tab.
- The palette must not jump when a chord changes: `paletteAt` blends current → next over the chord's
  own progress, and the mood warmth is faded with `moodBlend`.
- `tools/png.ts` is the only PNG code (encode, decode, analyse); `make-icons`, `smoke` and
  `preview` all use it. Do not add an image dependency.
- **The service worker's precache list is hand-written and must match the build**: Vite emits the
  entry at a *stable* path (`js/index.js` — `entryFileNames` in `vite.config.ts`), and
  `public/` is copied verbatim, so `SHELL` in `src/sw.ts` is exact rather than best-effort. Change
  the output paths and the list changes with them, or offline install breaks (`cache.addAll` is
  all-or-nothing).
- **The sleep timer's shortest HUD step is 15 minutes**, so the end of a fade cannot be reached
  through the HUD in a test. That is what `__singularity.armSleep(seconds)` and
  `__singularity.pieceAt(t)` on the diagnostic hook are for (`src/debug.ts`) — and both go through
  the app's own paths rather than around them: `armSleep` calls the same `setSleep` the HUD calls
  (`main.ts`), and `pieceAt` is the conductor's own pure query, which is what makes "a seed link
  reproduces the journey" checkable in a *fresh* page. Keep them that way; a hook that reimplements
  what it tests proves nothing.
- **An oscillator that is never started is silence, and stopping it throws.** `oscillatorStack`
  starts every oscillator it creates (the layer's gain is the envelope); the pads and the drone bed
  were silent before that call existed, which the offline measurement is what caught.
- **A star's centre must be projected onto the sphere before its disc is measured.** The cells a
  starfield is hashed into are a cube, so a cell's centre sits *off* the unit sphere and the great
  majority of stars fell outside their own reach — the field was nearly empty and biased toward the
  cells that happened to graze the sphere, and that read as "the sky is too dark" rather than as a
  bug. `starCell` normalises the centre; if you touch the star maths, check the field still appears.
- **The meter worklet posts `[left, right]`, not `{ pcm }`.** The engine read
  `message.data.pcm`, which is always `undefined`, so `meterAvailable` was true, no reading ever
  arrived, and the leveller sat at its initial trim with a blank LUFS readout. A silent failure
  with a healthy-looking graph: the soak (which reads the trim over time) is what caught it, and
  `tests/` alone never would have. If you change the worklet's post shape, change both sides and
  re-run `npm run soak`.
