# Jeffer — Endless Electro & Oscilloscope

An endless generative electro set and a full-screen oscilloscope, generated live in your browser.
No stream, no server, no samples, no accounts: open the page, click enter, and a distorted bass
plays under a phosphor trace that is *measuring the master bus*, forever.

**This is a web app, not a stream.** There is no uplink and nothing is recorded — the bass, the
clap, the pad, the zaps, the palette and the trace are all synthesised here, in the tab, from a
seed. A seed link carries the whole thing.

It is the third app in the family: [`../singularity`](../singularity) is endless ambient drone and
deep space, [`../fo-raver`](../fo-raver) is 122–140 bpm techno under a fractal kaleidoscope, and
this one is 126 bpm electro under an oscilloscope. The reference is the BOYS NOIZE video "Jeffer":
its palette, its darkness and its dynamics were measured off it (see `specs.md` §3.6), though the
scope itself is this app's own addition — the reference video has no oscilloscope in it.

`specs.md` is the specification. This file is what exists and what has been verified.

---

## Status

| Step | State |
| --- | --- |
| Specs | `specs.md` |
| Audio on Web Audio | **done** — distorted synth bass, kick, hats, metallic clap, percussion, stabs, arps, gated pad, zaps, impacts, crashes, sirens, sweeps, through delay and room into a self-measuring master |
| Arrangement | **done** — six passages drawn from a seeded graph, whole four-bar phrases, fills in front of every change, and a key (`N`) that cuts a passage short |
| Patterns | **done** — a hand-written bank of sixteen-step templates per instrument, drawn per phrase, with ghosts and fills |
| The scope | **done** — a real `AnalyserNode` on the master after the limiter, a signed decimation, a mean-crossing trigger, auto-ranging railed deflection, a masked graticule, a 24-bar peak spectrum |
| Visuals | **done** — colour field, VHS (luminance-scaled noise, rolling bar, 240 scan lines, tracking error) and glitch, mixed by the passage, with dynamic resolution and bloom |
| The app | **done** — enter gesture, hidden HUD, seed and copy link, quality, flash mode, volume, audio-only, sleep timer, PWA, mobile profile |
| Verification | **done** — 63 unit tests, 59 headless-browser checks, 18 layer-measurement checks, and a GLSL gate that compiles all four programs in a real WebGL2 context |
| Soak | **not done** — nothing here has run for eight hours |

## Verified

```bash
npm run typecheck    # both tsconfigs, clean
npm test             # 63 tests over the pure modules, ~1 s, no browser
npm run shaders      # compile all four GLSL programs headless, check the 23 scene uniforms
npm run smoke        # build, then headless Chrome: 59 checks, ~3 min
npm run stars        # build, then measure each visual layer by subtraction: 18 checks, ~1 min
npm run preview      # show the last capture as blocks (--ascii for a ramp)
npm run build        # the static site
```

`npm run smoke` drives the built site through a real browser: it clicks "enter" like a person, waits
for frames and a running clock, decodes the screenshot *and* a screenshot of a drop and measures
both, isolates the scope layer by subtraction with the signal pinned, exercises every control, arms
the sleep timer and watches the fade through to the suspend and the resume, renders the real engine
on an `OfflineAudioContext` and measures the samples, and checks that a seed link reproduces the set
an hour in from a fresh page.

Last run on this machine: **59/59 smoke checks and 18/18 layer checks passed**, 63/63 tests passed,
all four shaders compile and agree with the renderer's uniform list. The offline render measured
**−16.8 LUFS** against a −10.5 target (the live trim walks up towards it once the meter has eight
blocks, which the smoke test watches happen), **−3.3 dBTP** under a −0.3 dBTP ceiling. After the
spectrum was made subordinate, the captured intro frame measures mean luma **0.089** with **83%** of
it below the reference's 0.12 threshold and its brightest band is the trace's (23.7% on row 31%,
against the spectrum's 16.3%); a drop fills the black in (81% → 69%), nearly doubles the colour
(48% → 87%) and still peaks on the trace (22.9% against the spectrum's 17.7%) — which is what "a
different picture" means on a picture that stays dark either way.

`npm run stars` is the other half of the picture test: it isolates each of the four visual layers
by subtraction, gates on determinism first (three captures of one frame must agree), and gives each
layer the claim it can actually support — the scope is measured as the trace it is, the colour field
as the base of the picture, the tape as texture that adds energy without adding brightness, and the
glitch as a horizontal tear rather than a wash. It writes its frames to `.smoke/stars/`, which
`npm run preview` will show.

## Known limits of this machine

- **Headless Chrome here is SwiftShader** — software WebGL2 — so the smoke run is slow (a few frames
  a second) and the frame-rate targets in `specs.md` §7 are unverified on real hardware.
- **There is no audio device**, so loudness is measured but never heard, and the `AudioContext`
  clock runs at roughly half wall time. The smoke test polls for the state it needs instead of
  sleeping through it, for that reason; do not "fix" that into a fixed delay.
- **This node has no TypeScript support at all** (`node --experimental-strip-types` fails with
  `ERR_NO_TYPESCRIPT`), so `tools/` and `tests/` are bundled to runnable ESM in `.tools/` by
  `vite.tools.config.ts` and the npm scripts run the bundle. Nothing in `tools/` or `tests/` knows
  the difference — they are ordinary TypeScript imported by extension — but a fresh checkout on a
  node with TypeScript support could run them directly with
  `node --experimental-strip-types --test tests/*.test.ts`.

## Things that will bite

- **The trace must be signed.** The engine's decimation averages each group of FFT bins and keeps
  the sign. Taking `Math.abs()` per sample produces an *envelope*, which never crosses zero — so
  `findTrigger` always returned 0, the trace slid sideways, and the picture looked like a drawing of
  a waveform rather than one.
- **A scope has to be triggered.** `findTrigger` in `src/scope.ts` finds the first upward crossing of
  the signal's own mean in the first half of the buffer. Drawn from bin 0 every frame, a trace slides
  continuously and reads as a smear. The mean and not zero, because this material's bass sits well
  above zero and a zero-crossing trigger lands on the steepest part of the wave.
- **The graticule's border is a `min()` of the edge distances, not a `max()`.** With a `max`, the
  horizontal borders draw and the vertical ones never do, and nothing in the console says so.
- **Deflection is railed, not scaled.** `rail · tanh(wave · gain / rail)` flattens against the rail;
  a plain multiply puts the corners of the signal outside the box.
- **The tape's noise scales with the local luminance.** A flat amount of noise in *linear* light is
  about 0.12 on screen everywhere, which on a picture that is two thirds black is a grey veil rather
  than grain.
- **The spectrum is a peak per band, not one bin per bar.** 24 bars over 40 Hz–12 kHz, log-spaced,
  each the maximum over its band — which is what a hardware peak detector does. One FFT bin per bar
  is a row of identical bars, and it looks like a bug in the audio.
- **`mix32` must actually mix.** It was `Math.imul(z ^ (z >>> 0), …)`, and `z ^ (z >>> 0)` is
  identically zero, so *every seed in the app played the same set* — same key, same bars, same
  everything. `tests/rng.test.ts` now asserts `mix32` and `hash4` return non-zero and
  argument-dependent values, and the smoke test compares a *fresh* page against an untouched one
  rather than against a page the skip key had already rewritten.
- **A pinned capture has to stay pinned.** `__jeffer.draw({ scope })` promises the signal is fixed;
  the frame loop redrew with the *live* analyser a frame later, so every "same frame twice"
  comparison was really "two different waveforms". The loop honours the pin now (`pinnedScope()` in
  `main.ts`), and a pinned draw no longer folds its chosen time into the renderer's frame-time
  average — otherwise the adaptive quality walks underneath a capture and the picture changes
  between two draws of one moment.
- **A signed decode is not the same expression backwards.** `waveAt()` had
  `mix(v * 2.0 - 1.0, v, uScopeSigned)`, so on the float path — the one this machine takes, because
  R32F uploads — every sample was folded from −1..1 into 0..1 and the trace could never cross its
  own centre line. It drew, and it drew in the right band, and every positional check passed; what
  it drew was the absolute value of the waveform. Swapping the arguments moved the trace band from
  0.48% to 3.66% and put its peak on the row the shader draws it at. The check that would have
  caught it is in `tools/stars.ts`: measure the *difference* between a known signal and a null, and
  ask whether the trace carries light on both sides of its centre line. A folded trace puts all of
  it on one side — with the arguments swapped it measured 5.0 below against 1.3 above.
- **A pinned signal has to reach `draw` as an object.** Both `tools/stars.ts` and `tools/smoke.ts`
  were handing the renderer `JSON.stringify(...)` of a `ScopeFrame` rather than the frame. `draw`
  reads `scope.wave`, a string has no `wave`, and the renderer then uploads a zero-filled texture:
  a flat line, drawn exactly where the shader draws the trace, which passes every positional check
  in the suite. Both tools now parse the text and both assert the bin count they got, because the
  failure is otherwise completely silent.
- **Palette colours are sRGB bytes and the shader wants linear.** The renderer converts on upload,
  once per palette identity. Forgetting it applies gamma twice, and the "two thirds black" frame is
  not two thirds black any more.
- **Every layer weight must be read by the shader.** `uMix.y` — the colour layer — was not: the
  wash was drawn at full strength in every passage, so the arrangement's colour weight was a number
  the picture never looked at, and a drop looked the same as an intro (measured: 66.0% black against
  66.6%, which is not a drop). `RenderStats.layers` reported a weight that nothing honoured, which
  is worse than not reporting it. The wash now scales with `uMix.y`, and the smoke test compares a
  pinned intro against a pinned drop rather than a live frame against one — a live frame's mean
  moves by a few thousandths between runs, which is enough to lose a comparison decided by a
  fraction of a per cent.
- **`sample` is a reserved word in GLSL ES**, and `hash21` takes two arguments. A third is a compile
  error that shows up as a black rectangle and a console message nobody reads — which is why
  `npm run shaders` compiles all four programs in a real WebGL2 context and cross-checks the
  renderer's uniform list.
- **The flashes control is not a preference.** It is a photosensitivity decision. `soft` is the
  default on every device, including one that has asked for reduced motion, and the cap is low
  (0.18) because this picture is mostly black with a bright trace on it.
- **A reload leaves a set that is not playing.** Only a real gesture can start audio, and the smoke
  test reloads the page to check the seed link — so anything measured after a reload has to enter
  the set again first. (This is how the loudness-feedback check came to be reading a trim that had
  never moved: it was measuring a set nobody had started.)
- **`tools/png.ts` is the only PNG code** (encode, decode, analyse); `make-icons`, `smoke`,
  `preview` and `stars` all use it. Do not add an image dependency.
- **The picture's hierarchy was the wrong way round, and the fix was not the obvious one.** The
  spectrum band carried more light than the trace (8.6% of the frame against 3.7%). Dimming the bars
  could not fix it, for two reasons worth keeping. Their light is *area-continuous* — bars are
  vertical columns, lit across a fixed duty cycle on every row — while a trace is a thin wavy line
  that is at its core for only a fraction of any given row, so mean-per-row hands the spectrum the
  win at any brightness the trace could survive. And the pipeline is linear-light with the gamma at
  the end, so scaling scene light by 0.4 buys only ~0.7 on screen; reaching the target by weight
  alone needed a twelve-fold cut, which is a smudge, not a readout. The real fix was geometry: the
  bars were 0.52 of the half-height, a quarter of the screen. `SPEC_H` is now 0.30 and `SPEC_WEIGHT`
  0.25, and both captures peak in the trace band. The 24 bars and their peak-per-band reduction are
  measured from the reference and unchanged; only the height was ever a choice.
- **Compare regions by the light they carry, not by the mean of their rows.** A band's mean *rises*
  when the band is made shorter, because it drops the empty rows — so shrinking the spectrum to a
  third of its height first made it look 15% brighter. `bandSum`, not `bandMean`, for any "how much
  of the picture does this carry" question. And a peak *inside* the composited frame can be bloom
  bleeding off something else: the spectrum band's brightest pixel read 66.6% whether the bars were
  drawn at 0.34 or at 0.25, because it was light from the trace. `stars` reads the bars' own peak off
  the null-signal frame for exactly that reason.
- **Rendering cannot be verified from a log.** Capture, decode and look: `.smoke/smoke.png` and
  `.smoke/drop.png`, then `npm run preview` on either, which prints mean, stdev, the dark fraction
  at the reference's own 0.12 threshold, region means, a histogram and a row profile of where the
  light is. `npm run stars` writes one frame per layer to `.smoke/stars/`, which `preview` reads the
  same way.

## Layout

```
src/scope.ts        the scope's data and the trigger search — shared by the engine and the renderer
src/conductor.ts    the set: passages, chords, events, the bar clock — pure, seeded, time-addressable
src/patterns.ts     sixteen-step templates, ghosts and fills — a hash of (seed, bar, section)
src/harmony.ts      modes, degrees, and a bass line that mostly steps
src/palette.ts      six runs measured off the reference, and the harmony that moves between them
src/audio/          the engine (graph, bar scheduler, analyser), voices, dsp, loudness, meter worklet
src/visuals/        the four GLSL programs, the bloom, and the WebGL2 renderer
src/offline.ts      render the real engine on an OfflineAudioContext and measure it
tools/              chrome.ts (one headless-Chrome harness), png.ts, serve.ts, dev-server.ts,
                    shaders.ts, preview.ts, make-icons.ts, smoke.ts, stars.ts
tests/              63 tests over the pure modules
```
