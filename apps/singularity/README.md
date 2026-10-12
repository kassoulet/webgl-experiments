# Generative Singularity — Endless Cosmic Drone & Deep Space Visuals

An endless ambient piece and a deep-space picture, generated live in one browser tab. No stream,
no server, no samples, no accounts: open it, click once, and it plays.

*Specification: [`specs.md`](specs.md). This directory is the implementation.*

```bash
npm install
npm run dev        # http://127.0.0.1:8088/ while developing (TypeScript, on the fly)
npm run build      # the site, into dist/
npm run serve      # then open http://127.0.0.1:8088/ and play
```

TypeScript, built by Vite, and that is the whole toolchain: `typescript` and `vite` (plus
`@types/node` for the tools and tests) are the only devDependencies and there are **no runtime dependencies at all** — no framework, no audio library,
no image library. `dist/` is a static site with a single unhashed bundle a static host can serve
as-is, which is also what keeps the service worker's cache list readable.

## What it does

**Sound** (spec §2) — everything is generated, nothing is sampled:

| Layer | How it is made |
| --- | --- |
| Generative pads | detuned saw stacks per chord tone, each behind a low pass that opens and closes over tens of seconds |
| Tape-warped drones | root, fifth and sub through a tape model: wow and flutter (modulated delay), saturation, a soft high cut, a little hiss — the warp depth and the tape's "age" wander |
| String-machine voices | a second pair of saws per note with slow vibrato; desktop only, the first layer a phone gives up |
| Slow chords | a modal progression that changes every 20–90 s, voice-led, with suspended and added-note voicings; a new voicing fades in under the old one |
| Granular clouds | short grains cut from a synthesised string tone, pitched to the chord, scattered by the seed |
| Cosmic soundscapes | filtered-noise winds, granular dust, shimmering high partials, one long reverb that is the room, and sparse far-away events (a distant tone, a rising sweep, a bell, a dust cloud) |

The master is a bus compressor → saturation (2× oversampled) → true-peak limiter → a trim that a
BS.1770 meter moves slowly toward −17 LUFS. Nothing about it is a beat: every change is a glide or
a cross-fade of at least several seconds. (Measured by the offline pass in the smoke test:
−17.2 LUFS and −5.3 dBTP at the trim it starts from, i.e. at the target with headroom to spare.)

**Picture** (spec §3) — WebGL2, one full-screen triangle, one fragment shader:

- **Volumetric nebulae**: fbm of value noise with domain warping, marched with emission and
  absorption, so light glows through depth.
- **2D-layered fallback**: the same clouds as four parallax planes of 2D fbm, for weak GPUs and
  phones.
- **Procedural starfields**: hashed cells at three depths with parallax, size, colour temperature
  and twinkle from the hash; the brightest few carry diffraction spikes; a faint Milky Way band
  with dust lanes. Star sizes are angular (constant on screen, not in pixels), so the field looks
  the same at any resolution.
- **Far-away events light stars**: when the conductor schedules a distant tone or a bell, the sky
  answers it — a flare fades in on the star in that direction, over the event's own envelope.
- **Slow motion**: the camera drifts through the volume on a seeded path — minutes to cross a
  nebula, no cuts.
- **Colour**: palettes from real emission nebulae (H-alpha red, O-III teal, S-II gold) and a few
  imaginary ones, chosen by the key and walked by the progression.
- **Resolution-independent**: the drawing buffer is sized to the viewport times a resolution scale
  that the renderer moves to hold 60 fps (then the march step count), and CSS does the upscale.

Every rule in §3 is checked against real captures by `npm run stars` (27 checks): the layer
parallax *order* and the ratio between layers, colour temperature against the two tints the shader
mixes, twinkle against the journey clock, diffraction spikes as a cross test, the Milky Way band's
extent and dust lanes, and the lit-star flare above. It is a measurement, not an assertion — see
[Tests](#tests-and-what-they-prove).

**The app** (spec §4): a single "enter" click, then fullscreen; a HUD that appears only while the
pointer moves (volume, seed, copy link, visuals quality, audio-only, sleep timer); a seed in the
URL fragment so a link carries a journey; audio-only mode that draws nothing; installable as a PWA
that needs no network once loaded.

## How it holds together

```
browser tab
├── UI (controls)                       src/ui.ts
├── Conductor (seeded)                  src/conductor.ts  key, mode, chords, mood, events
│        │ state (the same object for both halves)
│        ├──────────────► Renderer      src/visuals/*     uniforms: palette, brightness, camera
│        └──────────────► Engine        src/audio/*       pads, drones, chords, scapes, master
│                                 │
│                                 └─ levels, measured loudness ──► conductor.levels
└── Service worker (offline shell)      src/sw.ts → sw.js
```

The conductor is pure and time-addressable: `ensure(t)` extends the schedule, `stateAt(t)` answers
for any time the schedule covers, and queries never draw random numbers. That is what lets the
audio scheduler look seconds ahead while the renderer reads the present — and it is why a seed
reproduces a journey exactly, on any device.

Audio and video share one clock: the `AudioContext`'s. Everything the audio does is written onto
that clock a dozen seconds ahead, so a throttled background tab or a locked phone screen cannot
make the music stutter.

## Audio engine: what this is, and what it will be

Spec §2 puts Motif's wasm build in an `AudioWorklet`; Motif's web build is roadmap item M8 and does
not exist yet, so this is the roadmap's **step 3** — the Web Audio fallback engine — with the graph
shaped exactly like the target:

```
pads · drones · chords · scapes ─► buses ─► sends (one long reverb) ─► master
                                                                      ├─ glue compressor
                                                                      ├─ saturation (2x)
                                                                      ├─ true-peak limiter
                                                                      ├─ loudness trim (BS.1770)
                                                                      └─ meter tap (AudioWorklet)
```

The loudness meter **is** an `AudioWorklet` (`src/audio/meter-worklet.ts`): it hands 4096-sample
blocks to the main thread, which runs the same K-weighting and gating as
`ebur128` does on Motif's native side, and the trim follows it. Like the GLSL, the worklet source
is embedded as a string rather than shipped as a file, and loaded from a Blob URL, so there is no
second bundle to name or cache. Cross-origin isolation headers (COOP/COEP) are already served by
`tools/serve.ts` (and by the dev server) and added by the service worker, so the SharedArrayBuffer
render-ahead ring can land without a hosting change.

The engine can also be rendered **offline** and measured: `src/offline.ts` builds the same graph on
an `OfflineAudioContext` — same scheduler, same meter — and reports RMS, peak, LUFS and true peak.
The headless smoke test uses it (through the `__singularity.offline()` diagnostic hook) so that
"the master is in the loudness region" is a measurement of real samples, not a claim.

**Why not Strudel, and why not Plaits in an `AudioWorklet` now?** Both were considered and are
deliberately out. Strudel (and its `dough` worklet) is **AGPL-3.0**, which would relicense this
page; its paradigm is TidalCycles *cycles* for bars, while §5 is free time in seconds with the
conductor owning the long horizon; and §8 wants one audio program shared with Generative Entropy,
which a second JS stack would fork away. Plaits is a Rust port (`mi-plaits-dsp`, MIT, already
vendored by Motif) that has to be compiled to wasm inside an `AudioWorklet` — that is Motif's M8,
not a package to install here, and Plaits' voices are percussive by nature, which is exactly the
sustained-voice gap §9 leaves open. **Motif's wasm build owns the synthesis; this engine is kept as
the fallback, and its graph is shaped so that swap needs no change to the conductor or the
visuals.**

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server on `:8088`, with the COOP/COEP headers, TypeScript on the fly |
| `npm run build` | the app, then the service worker, into `dist/` |
| `npm run serve` | serve `dist/` on `:8088` with the COOP/COEP headers and correct MIME types |
| `npm run typecheck` | `tsc --noEmit` over the app **and** over `tools/` + `tests/` (both must be clean) |
| `npm test` | the pure-module tests (`node --test` over `tests/*.test.ts`): conductor, harmony, loudness, seeds, RNG, the soak analysis |
| `npm run smoke` | build, then headless Chrome: load, click enter, run, screenshot, decode and measure it |
| `npm run stars` | build, then capture the star layers frame by frame and measure each §3 rule |
| `npm run soak` | build, then run (`--hours 8` for the real one): journals the clock, the audio, the heap and the loudness, and writes a report |
| `npm run soak:report` | render the newest soak journal as a markdown report, without starting a browser |
| `npm run preview` | print the last screenshot as colour blocks (or `--ascii`) plus numbers |
| `npm run icons` | regenerate the PWA PNG icons (deterministic, no image library) |

## Tests and what they prove

`npm test` is 75 tests over the parts that must not be wrong. They run on the TypeScript sources
directly (`node --test --experimental-strip-types tests/*.test.ts`), so there is no build before a
test run and no second copy of the code to keep in step:

- **Determinism**: a seed reproduces the entire eight-hour schedule, bit for bit; querying the
  conductor in any order (including backwards) neither consumes randomness nor changes it;
  different seeds genuinely diverge.
- **Musical rules**: chords change every 20–90 s and sections every 3–10 minutes; every chord tone
  is in the key for every mode and shape; voice leading keeps common tones and averages under
  ~3.5 semitones of movement per voice; no eight-chord phrase repeats in eight hours; events stay
  sparse; the camera and every drifted parameter are continuous frame to frame.
- **What the picture is told**: each far-away event lights exactly one direction on the sky, the
  flare fades in and back out over the event's own seconds rather than flashing, the sky is unlit
  between events, and neither the flare nor a query disturbs the schedule.
- **Loudness**: the BS.1770 meter reads −3.01 LUFS for a full-scale 1 kHz sine (the standard's
  anchor), tracks the K-weighting curve at 40 Hz and 10 kHz, and gates silence away.
- **Links**: seeds survive the URL fragment round trip, and junk in the fragment cannot become a
  file path or an unbounded string.
- **The soak's arithmetic**: hand-built journals — a healthy run that must pass every check, then
  one per failure (a climbing heap, a renderer that stops drawing, …) that must fail its own check
  and leave the others alone.

`npm run typecheck` is the other half of the safety net: the whole app is under `strict` — no
implicit `any`, no unchecked `null` — and so are the tests and the tools.

`npm run smoke` is the part that cannot be argued from a log: 33 checks driving a real Chrome
against the **built** site in `dist/` — what ships, not the sources. It fails if there are script
errors, if WebGL2 is missing, if no frames were drawn, if the clock is not running, if the piece has
no key and chord, if the offline render is silent or out of the loudness region, or if the decoded
screenshot is black, flat or washed out. It writes `.smoke/smoke.png`; `npm run preview` shows it in
the terminal.

It also drives the paths only a reader reaches, in a real browser with real gestures:

- **The controls** (spec §4): that they appear when the pointer moves and hide again when it stops;
  that visuals quality takes effect; that audio-only stops drawing while the clock keeps running.
- **The fade to sleep**, all the way through — the timer armed on the journey clock, the picture
  dimming as the fade runs, the piece suspending when it reaches silence, the notice with its
  resume, and the resume itself. While asleep, the clock and the frame count are asserted to be
  **frozen**; on resume, the audio clock and the page's wall clock are read in the same instant and
  compared, so "the journey resumes exactly where it stopped" is measured rather than claimed (it
  runs to within 10 ms across the suspend). The HUD's own steps are 15 minutes, which nobody waits
  for in a test, so the timer is armed through the diagnostic hook: `__singularity.armSleep(8)`.
- **Seed links**: that a seed in the fragment *is* the journey; that the seed input reloads onto a
  new one; that junk is refused rather than followed; and that the same seed describes the same
  piece at 0 s, 10 min and an hour in, in a *fresh page* — the conductor is pure, so a link either
  reproduces the journey or it does not. "Copy link" is clicked with its clipboard write recorded,
  so the URL it hands over is checked, not just its toast.

`npm run stars` is the §3 audit as arithmetic. It draws the same moment repeatedly through
`__singularity.draw({ time, camera, stars, density, brightness, flare })` — the app's real shader
with one uniform held still — and **subtracts** the captures: a star layer adds, and the nebula, the
band and the tone map are identical, so two frames that differ only in `stars` differ only in that
layer. That is how parallax, tint, twinkle and spikes are measured independently instead of being
argued about, and it found the bug that mattered most here: the star's centre was its *cell's*
centre, which sits off the unit sphere, so most stars' discs fell outside their own reach and were
never drawn. The band is measured with the camera aimed at its pole (a symmetric stripe), the
spikes by comparing brightness along the axes against the diagonals, and the flare by projecting
the conductor's event direction and looking there. Captures land in `.smoke/stars/`, so any of them
can be looked at: `npm run preview .smoke/stars/layer1.png`.

`npm run soak` is the eight-hour question, made runnable. `npm run soak -- --hours 8` plays the
real build for eight hours, writing one line per interval to an append-only journal:

| What | Where it comes from |
| --- | --- |
| The journey clock against the page's own wall clock, per interval and in total | `stats().clock`, `performance.now()` |
| The meter's message count | `stats().audio.messages` — the audio thread is *processing* |
| Grains scheduled, chords playing | `stats().audio.grains`, `.chords` — the scheduler is producing |
| Frames drawn, JS heap, DOM nodes and listeners | `stats().frames`, `Memory.getDOMCounters` |
| The leveller's trim, and the live short-term LUFS | `stats().audio.trimDb`, `.lufs` |
| Programme loudness and true peak, from fresh offline renders | `__singularity.offline()`, spread across the run |
| The picture at the start and at the end | captures, compared per pixel |

The clock and the meter count are two different signals on purpose: a graph rendering *silence*
still advances the audio context's clock, so "the device is running" and "the piece is sounding"
are separate measurements, and a drop-out has to fail one of them.

Three things make it safe to leave alone. It recovers from the browser dying — recording an outage,
relaunching and carrying on, because the question is whether the *piece* survives eight hours, with
every interruption counted and reported rather than hidden in a gap. `--detach` re-executes it in
its own session so it outlives the shell that started it. And the report is built by reading the
journal back, so a run killed at hour six still reports on its six hours:

```bash
npm run soak -- --hours 8 --detach     # writes the journal, the log and the report as it goes
npm run soak:report                    # render the newest journal at any point, no browser
```

It passes only if the clock kept time with the world, every interval drew something, the audio
never went quiet, the heap did not climb, and the last capture is neither blank nor identical to
the first. The report ends with what the run cannot prove, which is a paragraph, not a footnote —
see below.

The analysis is pure and lives in `tools/soak-analysis.ts`, and `tests/soak.test.ts` feeds it
synthetic journals — a leak, a stall, a silence, a clock losing half of every interval, a machine
that slept, a run killed mid-write — and asserts what it concludes. An eight-hour report cannot be
re-derived cheaply, so the arithmetic behind it is tested instead.

## Deployment

Any static host, serving `dist/` (`npm run build` produces it; it is one HTML file, one CSS file,
one JS bundle, a service worker and the icons). Two things to get right:

1. **MIME types**: `.js` must be `text/javascript` (and `.webmanifest`
   `application/manifest+json`); a wrong type makes the modules fail to load.
2. **COOP/COEP**: `Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: require-corp`. Today they are optional (nothing needs
   SharedArrayBuffer yet); the service worker adds them to the document, and a host that sets them
   itself is better. Netlify example:

```
/* 
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

Nothing else is required: no server, no API and no analytics.

## Status against the roadmap (spec §7)

| Step | State |
| --- | --- |
| 1. Specs | this document |
| 2. Visual prototype: starfield, 2D nebula, then volumetric, dynamic resolution | **done** — all four living in `src/visuals/`, measured in the smoke test |
| 3. Audio prototype on Web Audio: drone, pad, chord progression, reverb | **done** — and past it: tape model, grains, soundscapes, master chain and loudness target |
| 4. Motif web build (M8) | not started (Motif's side) |
| 5. Motif additions: sustained voices, tape model, harmony, seconds-based time | not started (Motif's side); the tape model and the harmony generator here are the reference |
| 6. Conductor and audio-driven visuals | **done** — one seeded conductor drives both |
| 7. The app: controls, seed links, sleep timer, PWA, mobile profile | **done** |
| 8. Soak: 8 hours on each browser | **partly** — the eight-hour run is instrumented, resumable and self-reporting (`npm run soak -- --hours 8 --detach`), but it has only been run here on SwiftShader in Chrome; Firefox, Safari and a real GPU are not covered |

### What has *not* been verified here

- **Soak** (spec §6). `npm run soak` measures the right things — the clock against wall time, the
  audio thread's liveness, and a heap verdict taken from the settled part of the run rather than
  from its warm-up — and it is what caught the broken meter (the worklet and the engine disagreed
  about the shape of the message, so the leveller never moved). But the eight hours have only been
  run here in headless Chrome on SwiftShader. Firefox and Safari, a real GPU, and a phone with the
  screen locked are still unverified. The scheduler is built for them (twelve seconds of lookahead,
  no timers on the audio path, bounded node lifetime); beyond the hours it was actually watched
  for, that remains a claim, and every report says so in its own words.
- **Frame rate and battery on real hardware.** The only capture here is headless Chrome on
  SwiftShader, which runs the volumetric march at ~1 fps. The adaptive resolution is exercised, but
  the 60 fps target on a laptop iGPU is unverified.
- **Loudness on a device.** The −17 LUFS trim is real feedback from a real meter, and the offline
  render measures the graph (see above), but the loop has only been exercised in a headless browser
  with a null audio device — never heard.
- **Playback while a phone screen is locked.** The lookahead should cover it; it has not been tried
  on a phone.
