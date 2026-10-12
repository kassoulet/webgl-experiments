# Jeffer — Endless Electro & Oscilloscope

**Specification, first draft, 2026-09-30.** A design document: the numbers are targets to measure
against, not invariants. The third web app in the FractalRave family
(`../../`): where **Generative Singularity** (`../singularity`) glides through ambient drone and deep
space and **FOraveR** (`../fo-raver`) plays four on the floor at 122–140 bpm under a fractal
kaleidoscope, this one plays **electro** at 126 bpm under a **big oscilloscope** — and the
oscilloscope is a real measurement of the master bus rather than a drawing of one.

---

## 1. What it is

A browser page that plays an endless, never-repeating electro set — a distorted synth bass, a metallic
clap, a gated pad, a zap — under a full-screen picture built around one instrument: an oscilloscope
with a graticule, a phosphor trace and a spectrum along the bottom, over a colour field of indigo
and maroon, with the tape running the whole time. Open it and it plays; leave it open for hours and
it never loops, never stops, never breaks.

One sentence: *an infinite generative electro set watched through a real oscilloscope.*

The reference is a single track — the BOYS NOIZE video "Jeffer" — and every number in §3 that can be
measured was measured off it, by the scripts in `../../tmp/jeffer/`. What the reference does *not*
have is an oscilloscope: its picture is two thirds black, flat, and unlit at the edges. The scope is
the app's own addition, and it is driven by an `AnalyserNode` on the master, so the trace is the
sound and nothing else.

| | Generative Singularity | FOraveR | Jeffer |
| --- | --- | --- | --- |
| Music | ambient drones, pads, slow chords | techno: kick, sub-bass, hats, stabs, risers | electro: distorted bass, metallic clap, gated pad, zaps |
| Time | free, in seconds; no pulse | bars and beats, 122–140 bpm, 4/4 | bars and beats, 122–132 bpm, 4/4 |
| Structure | moods that glide and cross-fade | sections that *change* | six passages, tempo and filter moving with them |
| Visuals | raymarched nebulae, starfields | kaleidoscope, plasma, fractal, noise | **oscilloscope**, colour field, VHS, glitch |
| Loudness | −18…−16 LUFS | −15…−13 LUFS, true peak ≤ −1 dBTP | **−10.5 LUFS**, true peak ≤ −0.3 dBTP |
| Flashes | none, by rule | capped by default | capped by default, and lower (§3.5) |

## 2. The set

Six passages, each with its own tempo, its own instrument levels, its own filter opening and its own
mix of picture layers. `src/conductor.ts` is the whole arrangement: it is a pure, seeded,
time-addressable schedule, and both halves of the app read it (§4).

| Passage | Bars | bpm | Character | Goes to |
| --- | --- | --- | --- | --- |
| `intro` | 16–32 | 122–126 | a near-black frame with a trace on it; pad and arp, filter at 700 Hz | build, groove |
| `build` | 8–16 | 124–128 | hats and stabs enter, the filter opens to 2.4 kHz | drop, groove |
| `groove` | 16–32 | 124–128 | the record: full kit, 6 kHz, the picture at full colour | break, build, drop |
| `drop` | 16–32 | 126–130 | impact, crash, one siren, a zap; every layer at 1.0 | break, groove, peak |
| `break` | 8–16 | 122–126 | no kick, pad and arp only, the tape at its worst | build, drop |
| `peak` | 16–24 | 128–132 | everything, 11 kHz | drop, groove |

Bar counts are whole numbers of four-bar phrases, so the last bar of every passage is a fill bar and
a fill is always *in front of* a change. That is the reason the counts are rounded, and it is not
optional: without it a drop can arrive with nothing before it.

**Harmony.** Four modes (aeolian, dorian, phrygian, mixolydian), a key per seed, and a chord every
four to eight bars. The bass moves mostly by step: a line that only leaps sounds like a chord
sequence rather than a bass, and `tests/harmony.test.ts` measures the ratio.

**Patterns.** Sixteen-step templates per instrument, drawn from a bank by a hash of
`(seed, section, phrase)`. There is no pattern schedule anywhere: `patternsFor()` is a function, so
the scheduler and the picture agree about a bar without either of them owning a list.

**Sections can be cut short.** `N` asks the conductor for the next passage now, and it lands on a
phrase boundary a bar or two ahead with the passage truncated to fit. It is deliberately *not*
seed-deterministic: a set someone has skipped through is not the set the seed alone would have played.
Everything before the cut is untouched.

## 3. The picture

Four layers, mixed by weight, all in one full-screen fragment shader (`src/visuals/shaders.ts`),
rendered into an HDR target and bloomed.

### 3.1 The scope

The part that is measured rather than drawn, and the reason this app exists.

- **The signal** is a real `AnalyserNode` on the master, after the limiter: 2048 points, 0.35
  smoothing. The waveform is decimated to `SCOPE_BINS` (256) by *averaging each group and keeping it
  signed* — an envelope (`Math.abs` per sample) is not a waveform, cannot cross zero, and would leave
  the trigger search with nothing to find.
- **The trigger** (`src/scope.ts`, `findTrigger`) is the first upward crossing of the signal's own
  *mean*, searched in the first half of the buffer. A scope drawn from bin 0 every frame slides
  sideways continuously and reads as a smear, which is the single most common way a fake scope gives
  itself away. The mean, not zero, because this material's bass sits well above zero.
- **The deflection** auto-ranges, and is railed: `rail · tanh(wave · gain / rail)`, so a loud passage
  flattens against the rail instead of putting a corner in the trace.
- **The graticule** is masked by its own box, and its border is drawn with a *minimum* edge distance.
  With a maximum — the obvious way to write it — the vertical borders never draw at all.
- **The spectrum** is 24 bars along the bottom, each the **peak** over a log-spaced band from 40 Hz to
  12 kHz, as a hardware peak detector does. One FFT bin per bar is a row of identical bars.
- **The spectrum is an aside, and its height is the only part of it that was ever a choice.** The
  bars are 0.30 of the half-height and drawn at `SPEC_WEIGHT` 0.25, because at the original 0.52 and
  full weight they carried more light than the trace (8.6% of the frame against 3.7%) and the picture
  read as a spectrum analyser with a decoration on top. The 24 bars and the peak-per-band reduction
  are measured from the reference and are not negotiable; the geometry was never measured from
  anything, and `npm run stars` is what holds the hierarchy in place.

### 3.2 The colour field

Two branches measured off the reference: a cool run climbing through indigo to an electric
violet, and a warm run through maroon to a dull red, plus one deliberately near-monochrome run for
the tape. Nothing in the palette is bright (the brightest stop is 0.27 luma) and nothing is neutral.
The branch follows the harmony: a bass line that lifts a third crosses to the next run, and the
crossing is a slide across the chord rather than a cut.

The wash is a *layer*, and the passage's colour weight opens it: a breakdown at 0.55 is a nearly
black frame with a trace on it, a drop at 1.0 is a room with colour in it (measured: 77% of an
intro frame below one twelfth luminance against 66% of a drop's). The `void` the field is mixed out
of is not a layer — the measurement says 65% of the reference is pure black, and black is not
something a passage turns up.

### 3.3 The tape

VHS, in four parts: luminance-scaled noise, a rolling bar, scan lines at 240 (a little under NTSC's
243.5, which is as close to "an old tape" as a number gets), and tracking error at the frame edges.

The noise scales with the local luminance: `noise · 0.05 · vhs · (0.02 + 0.9 · level)`. A flat amount
of noise in linear light is ~0.12 on screen everywhere, and on a picture that is two thirds black
that is not grain, it is a grey veil.

### 3.4 Glitches

A horizontal tear, block displacement and a block mosaic, all driven by the arrangement's own glitch
weight rather than rolled per frame, so the scope and the glitch agree about what the music is doing.
A drop that is glitching hard on screen while the arrangement thinks it is a breakdown reads as a bug.

### 3.5 The flash cap

`FLASH_DEPTH` in `src/profile.ts` is the number, and it is a safety decision rather than a look.
This picture is two thirds black with a bright trace on it, which is the worst possible contrast
ratio for photosensitivity: `soft` (the default, and the only mode ever selected automatically, on
any device, including one that has asked for reduced motion) caps the picture's gain from the kick at
**0.18**. `full` is an explicit opt-in in the HUD. Changing the cap means changing that constant and
the assertion in `tests/profile.test.ts`.

### 3.6 The reference's own numbers

Measured off the 260-second reference by `../../tmp/jeffer/`, and asserted by the smoke test:

| | Measured | This app |
| --- | --- | --- |
| Tempo | 126.05 bpm | 122–132 bpm |
| Loudness | −5.98 LUFS | **−10.5 LUFS** (deliberate) |
| True peak | +6.02 dBTP | **≤ −0.3 dBTP** (deliberate) |
| Pure black | 64.9% of all frames | ≥ 47% of every frame |
| Mean luma | 0.00–0.13 | ≤ 0.13 |
| Below 0.12 luma | 47–100% of each frame | ≥ 47% |
| Spectrum | 62 Hz 1.000, 125 Hz 0.604, 250 Hz 0.642, 8 kHz 0.044, 16 kHz ≈ 0 | bass-heavy, asserted live |

The two loudness deviations are written down in the header of `src/audio/loudness.ts`: an endless set
that clips is a set nobody leaves on. The darkness figures are *not* a target to hit exactly — they
are the boundaries inside which a frame of this material is allowed to be, measured with the same
0.12 threshold `tmp/jeffer/frames.py` used, because a comparison against a number taken with a
different definition is not a comparison.

## 4. One state, two halves

Audio and picture read the same schedule and never write to each other. If a decision belongs to both
— what bar we are on, when a passage ends, what the flash budget is, how loud the set is right now —
it belongs in the conductor and it must be derivable from the seed and the time alone.

The one thing that crosses from the audio thread to the GPU is the scope: one `R32F` (or `R8`)
texture of 256×2, uploaded per frame — the waveform on the top row, the spectrum on the bottom. The
levels the picture uses for the flash and the tape noise are the engine's own smoothed levels, read
from the same object the scheduler writes.

Queries never consume randomness. `stateAt(t)`, `chordAt(t)`, `gridAt(t)` may be called in any
order, any number of times, ahead or behind, and `tests/conductor.test.ts` says so.

## 5. The seed, the profile and the targets

**A seed is a promise.** `#s=<seed>` in, the same string out, and the set it describes is the same
set an hour later, in a fresh page, in any order. A seed that could not be carried in a URL fragment
is refused rather than cleaned, because a cleaned-up seed is a *different set* from the one that was
asked for. The hash behind it has to actually spread: `mix32` returning zero for every input is the
kind of bug that makes every seed the same set, and `tests/rng.test.ts` asserts it does not.

**A device is a profile, not a different app** (`src/profile.ts`): fewer detuned voices, fewer noise
octaves, a smaller render scale, no bloom, a shorter reverb. There is no fractal in this picture, so
the noise depth is the only quality knob there is. `profile.visual` is a starting guess and the
renderer still measures its own frame time and adapts.

**Audio-only means no GPU work at all**: the frame loop stops, the canvas is dropped, the set keeps
playing, and the scope's last reading is the one that was already taken.

## 6. Architecture

```
index.html                the Vite entry: the DOM shell, one <script type="module">
public/                   served as-is: styles.css, manifest.webmanifest, icons/
src/
  scope.ts         the scope's data: 256 bins, two rows, and the trigger search
  conductor.ts     the set: passages, chords, events, the bar clock — pure, seeded, time-addressable
  patterns.ts      sixteen-step templates, ghosts and fills — a hash of (seed, bar, section)
  harmony.ts palette.ts      modes and degrees; the measured palettes — pure
  rng.ts noise.ts seed.ts profile.ts types.ts
  audio/           engine (graph + bar scheduler + analyser), voices, dsp, loudness, meter-worklet
  visuals/         shaders (GLSL as strings), bloom, renderer (WebGL2, dynamic resolution)
  offline.ts       render the real engine on an OfflineAudioContext and measure it
  ui.ts main.ts pwa.ts sw.ts debug.ts
tools/             chrome.ts (one headless-Chrome harness), png.ts, serve.ts, dev-server.ts,
                   shaders.ts, preview.ts, make-icons.ts, smoke.ts
tests/             *.test.ts — node --test over the pure modules
dist/              built (gitignored)
```

No runtime dependencies: plain CSS, GLSL in WebGL2, Web Audio. Shaders and the meter worklet are
embedded strings, so the page works offline and there is no second bundle to name, hash and precache.

## 7. Non-functional requirements

- **Loudness** −10.5 LUFS, true peak ≤ −0.3 dBTP, measured on our own meter (K-weighted, gated,
  4× oversampled) and trimmed towards the target slowly enough that nobody hears it move.
- **The picture** renders at 60 fps on a desktop GPU and adapts its own resolution and noise depth to
  hold it. There is no fixed frame rate and nothing is dropped silently.
- **Offline**: a service worker precaches the shell; the app is a static site and needs no network
  after the first load.
- **No telemetry, no accounts, no network calls.** A seed is the only state that leaves the browser,
  and it leaves in the URL only if the reader copies it.
- **Accessibility**: the flash cap (§3.5), `prefers-reduced-motion` never selecting `full`, real
  focusable controls, and the picture never carrying information the HUD does not also state in text.

## 8. Open questions

- The reference's tempo drifts (126.05 bpm is a mean over four minutes); the set holds a constant
  tempo per passage instead, which is a deliberate simplification and not a measurement.
- The scope's persistence is one frame. A real scope's phosphor decays over tens of milliseconds,
  which on a 60 Hz display is between one and two frames — worth revisiting if the trace ever looks
  like a drawing rather than a trace.
- `break` has no kick, which is faithful to the arrangement and makes the bar feel empty on small
  speakers. Whether that is a bug or the point is not settled.
