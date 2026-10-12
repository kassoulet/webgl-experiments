# Working in `apps/jeffer/`

**Jeffer — Endless Electro & Oscilloscope**, the third web app in the family: where Generative
Singularity glides through ambient drone and FOraveR plays four on the floor under a fractal
kaleidoscope, this one plays electro at 122–132 bpm under a **big oscilloscope that measures the
master bus**. `specs.md` is the specification; `README.md` is what exists and what has been verified.
The monorepo's root `AGENTS.md` (`../../AGENTS.md`) orients the whole repository; this app is
TypeScript, outside the Cargo workspace.

## Shape of the thing

A static web app in **TypeScript, built by Vite**, with **no runtime dependencies**: plain CSS, GLSL
in WebGL2, Web Audio. `dist/` is the site; `tools/serve.ts` serves it locally with the headers it
wants. Nothing else is in the toolchain — no framework, no audio library, no test runner.

```
index.html                the Vite entry: the DOM shell, one <script type="module">
public/                   served as-is: styles.css, manifest.webmanifest, icons/
src/
  scope.ts         the scope's data (256 bins, two rows) and the trigger search — no GL, no audio
  conductor.ts     the set: passages, chords, events, the bar clock — pure, seeded, time-addressable
  patterns.ts      sixteen-step templates, ghosts and fills — a hash of (seed, bar, section)
  harmony.ts palette.ts      modes and degrees; the palettes measured off the reference — pure
  rng.ts noise.ts seed.ts profile.ts types.ts
  audio/           engine (graph + bar scheduler + analyser), voices, dsp, loudness, meter-worklet
  visuals/         shaders (GLSL as strings), bloom, renderer (WebGL2, dynamic resolution)
  offline.ts       render the real engine on an OfflineAudioContext and measure it
  ui.ts main.ts pwa.ts sw.ts debug.ts
tools/              chrome.ts (one headless-Chrome harness), png.ts, serve.ts, dev-server.ts,
                    shaders.ts, preview.ts, make-icons.ts, smoke.ts, stars.ts
tests/              *.test.ts — node --test over the pure modules
dist/               built (gitignored)
```

`src/scope.ts` is deliberately *between* `audio/` and `visuals/`: the engine fills those two arrays
and the renderer uploads them, and neither imports the other's module. The trigger search lives
there too, because a trigger is a property of the signal and not of the GPU — which is also what
makes it testable without a graphics context.

## TypeScript conventions

Identical to `../fo-raver/AGENTS.md` and for the same reasons: two tsconfigs both clean
(`tsconfig.json` is the app, `tsconfig.tools.json` is `tools/` + `tests/`), `strict` on with every
class field declared explicitly, shared contracts in `src/types.ts`, and no enums, parameter
properties or namespaces.

**The conductor is the source of truth for both halves.** Audio and picture both read it; neither
writes to it (except the audio engine's smoothed levels, which the picture reads). If a decision
belongs to both halves — what bar we are on, when a passage ends, what the flash budget is — it
belongs in `conductor.ts` and it must be derivable from the seed and the time alone.

## Rules that must hold

- **Queries never consume randomness.** `stateAt(t)`, `chordAt(t)`, `gridAt(t)` and friends may be
  called in any order, any number of times, ahead or behind. `tests/conductor.test.ts` covers this
  and it is the test to read first when something desynchronises.
- **The step patterns are a hash, not a schedule.** `patternsFor(seed, bar, sectionIndex, section)`
  must answer the same sixteen steps however often, in whatever order, and from whatever direction
  it is asked. That is what lets the scheduler and the picture agree about a bar without either of
  them owning a list.
- **The waveform stays signed.** The decimation in `engine.ts` averages each group of FFT bins and
  keeps the sign. An envelope cannot cross zero, the trigger search finds nothing, and the trace
  slides sideways — which is the one symptom that gives a fake scope away.
- **Everything is on the grid.** Every note, hit and section change lands on a bar or a beat. Bar
  counts are multiples of four, so the last bar of every passage is a fill bar and a fill is always
  in front of a change.
- **Bar arithmetic needs an epsilon** (`gridAt`), or bar 40 reads as bar 39: the kick is scheduled a
  bar late, the flash a bar early, and neither looks like a bug.
- **The flash cap is a design decision, not a shader detail.** `FLASH_DEPTH` in `src/profile.ts` is
  the number: `soft` caps the picture's gain from the kick at 0.18 and is the only mode ever
  selected automatically; `full` is a HUD opt-in. Changing it means changing that constant, the
  assertion in `tests/profile.test.ts`, and saying so in `specs.md` §3.5.
- **Shaders are embedded strings** (`src/visuals/shaders.ts`), not fetched assets — the page must
  work offline. **Backticks inside a GLSL comment terminate the JS template literal**, and `sample`
  is a reserved word in GLSL ES. The AudioWorklet follows the same rule
  (`src/audio/meter-worklet.ts`, loaded from a Blob URL), so there is no second bundle.
  **`npm run shaders` compiles all four programs in a real headless WebGL2 context** and
  cross-checks the 23 scene uniforms against the renderer's list: run it after touching GLSL, and
  treat it as the gate it is.
- **A pinned capture stays pinned.** `__jeffer.draw({ scope })` promises the signal is fixed for as
  long as the picture is frozen, so the *frame loop* must honour the pin too (`pinnedScope()`), and
  a pinned draw must not fold its chosen time into the renderer's frame-time average — otherwise
  the adaptive quality moves the noise field underneath a capture and "the same frame twice" quietly
  stops being true.
- **One clock**: the `AudioContext`'s. `main.ts` falls back to wall time only when audio could not
  start at all.
- **Audio scheduling is written ahead** (12 seconds on the context clock, one bar at a time). Do not
  add work that must happen within a tick; a hidden tab's timers are throttled to about 1 Hz.
- **Mobile is a profile, not a different app** (`src/profile.ts`): fewer voices, fewer noise octaves,
  a smaller render scale, no bloom. There is no fractal in this picture, so the noise depth is the
  only shader quality knob.
- **Audio-only means no GPU work**: stop the frame loop and drop the canvas, keep the sound.
- **The palette is measured, not chosen.** Six runs counted off the reference by `../../tmp/jeffer/`.
  Nothing in it is bright (the brightest stop is 0.27 luma) and nothing is neutral. The renderer
  converts sRGB bytes to linear on upload, once per palette identity; doing it twice applies gamma
  twice and the two-thirds-black frame stops being two-thirds black.
- **Every layer weight in `uMix` must be read by the shader.** `uMix.y` (the colour layer) was not,
  for a while: the wash was drawn unconditionally, so a breakdown and a drop rendered the same
  picture and the HUD reported a weight nothing honoured. If you add a layer, add it to `picture()`
  *and* to the smoke test's layer check — a weight nothing reads is a lie in the HUD.

## Commands

```bash
npm run dev                    # http://127.0.0.1:8090/ while developing (Vite, TS on the fly)
npm run build                  # app + service worker into dist/
npm run serve                  # serve dist/ with the headers it wants
npm run typecheck              # tsc over the app, then over tools/ + tests/
npm test                       # 63 tests, ~1 s, no browser
npm run shaders                # compile all four GLSL programs headless, check the uniforms
npm run smoke                  # build, then headless Chrome: 59 checks, ~3 min
npm run stars                  # build, then measure each visual layer by subtraction: 18 checks, ~1 min
npm run preview                # show the last capture as blocks (add --ascii)
npm run icons                  # regenerate public/icons/*.png
```

Node 22 is assumed (it has `WebSocket` and `fetch`). `CHROME_PATH` overrides the browser the smoke
test launches.

**This node has no TypeScript support** (`node --experimental-strip-types` fails with
`ERR_NO_TYPESCRIPT`), so `npm run tools` bundles `tools/` and `tests/` to runnable ESM in `.tools/`
with `vite.tools.config.ts`, and the scripts above run the bundle. Two things to know about that
config: only *runnable* tools are `lib.entry` items (listing a library such as `serve.ts` or
`chrome.ts` makes the bundler rename it into a chunk, and its `import.meta.url` then points
somewhere else), and `node:` builtins stay external, which is what keeps `node:test` external too.

## Verifying a change

```bash
npm run typecheck
npm test                          # pure logic: scope, conductor, patterns, harmony, palettes, loudness, rng
npm run shaders                   # the GLSL, in a real WebGL2 context
npm run smoke && npm run preview  # the app, in a real browser, with a real picture
npm run stars                     # the layers, measured rather than read
```

The division of labour: **`npm test`** is "is the logic right" (fast, no browser); **`npm run
shaders`** is "does the GLSL compile and still agree with the renderer"; **`npm run smoke`** is
"does the thing work at all", and it must fail loudly and fast. There is no soak tool here yet, and
porting `../fo-raver/tools/soak.ts` is the first thing that would.

The smoke test is deliberately picky, and the scope checks are the ones that could not have been
copied from a sibling app: the analyser is a real `AnalyserNode` and is feeding the renderer, the
waveform is not flat, it is signed and centred, the spectrum is bass-heavy (a property of this music
that would be false of any invented spectrum), the frame is as dark as the reference and as coloured
as it, and **the deflection gain moves the trace and only the trace** — checked causally, by raising
the gain four times and measuring the change inside the trace band against the change in the gap
below the graticule and the strip above it, with the signal, the moment, the layers and the noise
field all pinned, and against a noise floor measured in the same run by drawing one frame twice.

`npm run stars` is the layer-by-layer version of the same idea, ported from `../fo-raver/tools/stars.ts`
but not copied from it, because the four layers here do not compose the same way. It gates on
determinism first — three captures of one pinned frame must agree to a mean of 0.01 — and then gives
each layer the claim it can actually support:

| Layer | How it composes | What `stars` asks of it |
| --- | --- | --- |
| `scope` | purely additive | a difference frame *is* the trace: in the trace band, nothing in the gap, and light on both sides of its centre line |
| `colour` | the base of the picture, not an addition | it is there at full weight and the weight moves it |
| `vhs` | multiplies the picture by its scan lines and adds noise | it raises pixel-scale energy without raising the mean much — grain is not a light source |
| `glitch` | displaces the coordinates the picture is sampled at | it changes the picture, and it changes it as horizontal *tears*: the p95 of the difference row profile against its median (an even change would be 1×) |

It also holds the scope's own hierarchy, which is the check worth stealing: the trace band must carry
more total light than the spectrum band, and the trace's brightest pixel must beat the bars' own by
1.5×. Both were false when the tool was first written.

Two things about it that are not obvious. **It synthesises its signal** — 2.5 cycles of a 62 Hz sine
with a third harmonic — rather than reading the analyser, because a live reading depends on what the
set happens to be playing and on a headless clock running at half wall time; the first attempt waited
four minutes for a drop and got an intro waveform too quiet to test with. And **the glitch is measured
over the scope layer, not the colour field**: a tear displaces sampling coordinates, so over a smooth
wash it is nearly a no-op (measured: 0.0039 against 0.92 over the trace).

It serves and drives `dist/`, so **run `npm run build` first** (`npm run smoke` does). It uses a
**fixed seed** (`--seed smoke-test`) so two runs render the same moment and the numbers are
comparable.

**Wait for evidence, not for the clock.** Rendering here is software (SwiftShader) at a few frames
a second and there is no audio device, so the `AudioContext` clock runs at roughly half wall time.
The sleep, resume and loudness checks poll for the state they need with a deadline instead of
sleeping a fixed interval; a fixed `delay()` there is a coin flip.

**Two clocks are compared in the page, never across the CDP boundary.** The sleep checks read the
journey clock and `performance.now()` in a *single* `Runtime.evaluate`: a host timestamp against a
page one is skewed by round trips that run to seconds here.

**Rendering cannot be verified from a log.** Capture, decode and look: `.smoke/smoke.png` and
`.smoke/drop.png`, then `npm run preview` on either — mean, stdev, the dark fraction at the
reference's own 0.12 threshold, region means, a histogram, and a row profile of where the light is.
A healthy frame of this material is mostly black with a small very bright thing in it: a mean that
has crept towards the ceiling is exposure, and a row profile with nothing in the trace band is a
trace that stopped being drawn.

## Things that will bite

The full list, with the story behind each, is in `README.md` § "Things that will bite". The ones that
have already cost an afternoon:

- **`z ^ (z >>> 0)` is zero.** It is in `mix32`'s place in a lot of "splitmix" code found on the
  internet, and it makes every seed in the app play the same set — same key, same bars, same
  palette — with nothing in the console. `tests/rng.test.ts` asserts the hash is non-zero and
  argument-dependent, and the smoke test compares a fresh page against an untouched one.
- **The waveform must stay signed** and **the graticule's border is a `min()`**, not a `max()`. Both
  produce a plausible-looking picture with one thing quietly missing. `mix(a, b, t)` with `a` and `b`
  the wrong way round folds a signed signal into 0..1: the trace still draws, still in the right
  band, still peaks on the right row, and is the absolute value of the waveform. `tools/stars.ts`
  catches it — a known signal against a null, asking whether the trace has light on *both* sides of
  its centre line.
- **A pinned `ScopeFrame` must reach `draw` as an object.** `draw` reads `scope.wave`. Both tools
  were passing `JSON.stringify(...)` of the frame, so the renderer uploaded a zero-filled texture
  and every scope check was quietly measuring a flat line — which sits exactly where the shader
  draws the trace, so nothing failed. Both tools parse the text now and both assert
  `render.scopeBins`. If you add a third tool, do the same.
- **Tape noise has to scale with luminance.** A flat amount in linear light puts ~0.12 on screen
  everywhere, and on a picture that is two thirds black that is a veil, not grain.
- **Never sample the texture you are drawing into.** The blur passes ping-pong (scene → A, A → B).
- **Ask for `EXT_color_buffer_float`.** RGBA16F can be created everywhere in WebGL2 and drawn into
  almost nowhere; the failure is an incomplete framebuffer, not an exception.
- **The flashes control is not a preference.** It is a photosensitivity decision, and this picture is
  the worst case for it: mostly black, one very bright line.
- **A reload leaves a set that is not playing** — only a gesture can start audio — so anything the
  smoke test measures after a seed reload has to enter the set again first.
- **The service worker's precache list is hand-written and must match the build**: Vite emits the
  entry at a stable path (`js/index.js`) and copies `public/` verbatim, so `SHELL` in `src/sw.ts` is
  exact rather than best-effort. `cache.addAll` is all-or-nothing.
- **The meter worklet posts `{ pcm }`.** Read `message.data.pcm`; posting the buffers bare sends an
  array with no `pcm` in it, and the meter silently never hears anything while `meterAvailable`
  stays true.
- **`tools/png.ts` is the only PNG code** (encode, decode, analyse). Do not add an image dependency.
- **The spectrum is subordinate now, and keeping it that way is a measurement, not a preference.**
  `SPEC_H` (0.30) and `SPEC_WEIGHT` (0.25) in `src/visuals/shaders.ts` set the hierarchy, and
  `npm run stars` holds it: the trace band must carry more total light than the spectrum band, and
  the trace's brightest pixel must beat the bars' own by 1.5×. If you raise either constant, the
  checks will tell you. Do not "fix" it by brightening the trace — the trace's core is already
  clipped at 92.6% and the bloom pass bleeds from it deliberately.
- **Compare regions by `bandSum`, never `bandMean`.** A band's mean rises when the band is made
  shorter, because it drops the empty rows — shrinking the spectrum to a third of its height made it
  measure 15% *brighter*. And a peak read inside the composited frame may be bloom bleeding off
  something else: the spectrum band's brightest pixel sat at 66.6% whether the bars were drawn at
  0.34 or at 0.25, because that light came from the trace. Read a layer's own peak from a frame with
  the other marks off — `stars` uses the null-signal capture for the bars for that reason.
- **`src/audio/loudness.ts`, `tools/serve.ts`, `tools/chrome.ts` and `tools/png.ts` are copied from
  the sibling apps, not shared.** No app can import another's sources. If you change one here,
  change it there, and note it.
