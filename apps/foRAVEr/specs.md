# FOraveR — Endless Techno & Psychedelic Visuals

**Specification, first draft, 2026-09-29.** A design document: the numbers are targets to measure
against, not invariants. The other end of the same pair as **Generative Singularity**
(`../singularity`): that one is endless ambient drone and deep space, this one is endless
generative techno and kaleidoscopes. Both are web apps, both generate everything live in the
listener's browser, and both live in the FractalRave monorepo (`../../`).

---

## 1. What it is

A browser page that plays an endless, never-repeating techno set — four on the floor, bass, a
bass line that moves every eight bars, stabs, risers, impacts — under a full-screen stack of
psychedelic visuals: kaleidoscopes, plasmas, escape-time fractals and flow-field noise, mixed by
whichever passage of the set is playing. Open it and it plays; leave it open for hours and it
never loops, never stops, never breaks.

One sentence: *an infinite generative rave that runs entirely in a browser tab.*

The sister app's spec is the opposite end on every axis, and the differences are the point:

| | Generative Singularity | FOraveR |
| --- | --- | --- |
| Music | ambient drones, pads, slow chords | techno: kick, sub-bass, hats, stabs, arps, risers |
| Time | free, in seconds; no pulse | bars and beats, 122–140 bpm, 4/4 |
| Structure | moods that glide and cross-fade | sections that *change*: intro, build, drop, breakdown, peak |
| Visuals | raymarched nebulae, starfields | kaleidoscope, plasma, fractal, noise |
| Sound | long reverbs and tape wobble | a distorted master, a dotted-eighth delay, a room |
| Loudness | −18…−16 LUFS, wide dynamics | −15…−13 LUFS, true peak ≤ −1 dBTP |
| Flashes | none, by rule | capped by default; a full strobe is an explicit opt-in |

## 2. Audio

Everything is generated; nothing is sampled or pre-rendered.

| Layer | What it is | How it moves |
| --- | --- | --- |
| **Kick** | a sine dropping from ~3× its note to the note in 50 ms, plus a noise transient for the click | every beat of the bar; ghost kicks from the pattern layer |
| **Bass** | a saw and a sine an octave below, through a filter that closes as the note decays | the chord's root, with accents on the downbeats and a run into every fill |
| **Hats and claps** | high-passed noise; a clap is three noise bursts a few milliseconds apart and then a body | sixteenths and offbeats from the pattern layer, fills on the last bar of each phrase |
| **Stabs and arps** | detuned saws and square blips through a filter sweep | chord tones, from the pattern layer's own contour |
| **Pad** | sustained detuned saws, long attack and long release | one chord at a time, cross-faded, carried under everything |
| **Transitions** | a riser in the last two bars before a drop, an impact and a crash on it, a siren inside a long drop, a filter sweep in a breakdown | seeded, announced by the conductor, scheduled like everything else |

Rules for the sound:

- **Four on the floor.** The kick is the clock, and the flash budget is derived from the same
  `gridAt()` the drums are scheduled from, so the picture pulses exactly on the kick and not
  somewhere near it.
- **Everything is on the grid.** Every note, every hit, every section change lands on a bar or a
  beat. Tempo changes land on section boundaries — a musical event, not a drift.
- **The kick is four on the floor but the arrangement is not.** Sections are drawn from a seeded
  graph (see below), so the set builds and drops rather than looping a bar.
- **Space is part of the sound.** A tempo-synced dotted-eighth delay and a decaying hall are
  buses in the graph, not effects on the end of it.
- **Endless without repeating.** A seed reproduces the set exactly; the same moment does not come
  back within it.
- **Loudness.** −15…−13 LUFS with a slow BS.1770 leveller and a true-peak limiter that only ever
  does a few dB of work.

### The arrangement

Five kinds of passage, each a *recipe* rather than a clip:

| Section | Bars | bpm | What is playing | What it does next |
| --- | --- | --- | --- | --- |
| `intro` | 16–32 | 124–131 | kick and pad, a little arp | build, or breakdown |
| `build` | 8–16 | 127–137 | everything arriving, the filter opening | drop, or breakdown |
| `drop` | 16–32 | 128–138 | the full set: kick, sub, claps, stabs, arps | breakdown, build, peak |
| `breakdown` | 8–16 | 122–130 | no kick, pad and arp and a closing filter | build, or drop |
| `peak` | 16–24 | 130–140 | everything, hotter and faster | breakdown, or drop |

The next section is drawn from the current one's list, so the set has a shape without having a
script. A riser is generated in the last two bars of whichever passage is *about* to be followed by
a drop or a peak — decided when that drop is generated, because a riser that only sometimes
arrives is not a transition.

Bar counts come in whole four-bar phrases, which is what a DJ counts in and also what the fills
rely on: the last bar of a passage is always the last bar of a phrase, so a change is always
announced.

### The patterns

Sixteen-step templates per instrument, hand-written (a uniformly random techno pattern is noise,
and this is a bank of six kick lines, seven bass lines, seven hat lines and so on), drawn per
four-bar phrase, with ghost notes layered on per *bar* and a fill on the last bar of every phrase.

Crucially the patterns are a **function**, not a schedule: `patternsFor(seed, bar, sectionIndex)` is
a hash, so the audio scheduler and the picture can ask for any bar in any order and get the same
sixteen steps back. That is why the conductor has no pattern list and the app has no pattern
schedule to keep in sync.

### Engine

The browser's own Web Audio graph — oscillators, `ConvolverNode`, `DelayNode`, `WaveShaper` — with
no audio dependency, because Motif's wasm build (M8) does not exist yet. The shape is the one
Motif would slot into:

```
drums (kick bass clap hat perc) ┐
synth (stab arp pad) ── echo ───┼─> master (leveller -> saturation ->
fx (riser, impact, siren, …) ──┘    limiter -> trim -> user -> fade)
```

## 3. Visuals (GLSL)

A WebGL2 fragment shader on one full-screen triangle. Four layers, each on its own uniform weight,
each faded continuously with the section that asked for it:

| Layer | What it is |
| --- | --- |
| **Kaleidoscope** | the plane folded into N segments about the centre, with a warped plasma showing through the seam; N is the quality control and the spin drifts |
| **Plasma** | four sine fields added together over a domain warp — the classic demoscene plasma, warmed by fbm so it does not read as a sine grid |
| **Fractal** | escape-time on the Mandelbrot set with smooth iteration counting, slowly orbiting and zooming, coloured by the same ramp |
| **Noise** | a flow field: fbm of a position displaced by fbm, three times over |

They are combined by weighted average and coloured by a four-stop ramp (`deep → mid → hot →
accent`) rather than a two-colour mix, so a fractal's bands have somewhere to go. A hue rotation
drifts the whole picture slowly; an exponential tone map keeps hot cores coloured instead of
clipping them to white; bloom is a separable two-pass blur over a soft-knee bright pass.

### Rules for the picture

- **Driven by the audio, gently.** The section chooses the layer mixture and the saturation; the
  master loudness chooses the exposure; the chord chooses the palette. None of it is a beat-synced
  cut — the only per-beat quantity is the flash, and see below.
- **The flash cap.** The kick's envelope is multiplied by the section's own allowance and by the
  reader's flash mode, and `soft` (the default, and the only mode ever selected automatically)
  caps that at **0.22** of the picture's brightness. `full` is available in the HUD as a
  deliberate opt-in and is worth roughly 1.0. The number lives in `src/profile.ts` as
  `FLASH_DEPTH` and the check lives in `tests/conductor.test.ts`; neither is in the shader, where
  nobody would look for it.
- **Resolution-independent.** Rendered at a scaled internal resolution with dynamic scaling to hold
  the frame rate; the fractal's iteration count is the second knob.
- **No backend, no GPU for audio-only.** Turning the picture off stops the frame loop and drops
  the drawing buffer; the set keeps playing.

This is GLSL (WebGL2), not the WGSL of Complex Plane: the target is every browser, including those
without WebGPU.

## 4. The app

- **One static page.** HTML, one bundle, the shaders. No backend, no accounts, no analytics.
- **Start**: a single "enter" click (browsers require a gesture before audio), then full screen.
- **Controls, minimal and hidden until the pointer moves**: volume, a seed and a "copy link" that
  carries it, visuals quality (auto / low / high), flash mode (capped / full), audio-only, a sleep
  timer. Keys: `n` skips to the next passage, `v` cycles quality, `f` goes full screen.
- **Mobile**: plays on phones; fewer voices, a smaller buffer, no bloom, lower resolution.
- **Offline**: installable as a PWA; once loaded, it needs no network.

## 5. Architecture

```
┌──────────────────────── browser tab ─────────────────────────┐
│  UI (controls)                                               │
│      │ seed, volume, quality, flash                          │
│      ▼                                                       │
│  Conductor ── sections, chords, events, the bar clock ─┐     │
│      │                                                 │     │
│      ▼                                                 ▼     │
│  Audio: 9 buses → echo + room → master               WebGL2: 4 layers
│  voices scheduled a bar ahead on the context clock    uniforms: palette,
│      │                                                 layers, flash,
│      └── levels (kick, bass, hat, brightness) ────────────┘
└──────────────────────────────────────────────────────────────┘
```

- **The conductor** owns the arrangement: which passage is playing, how long it has left, where
  the bar and the beat are, what the bass note is, and what transitions are due. It is seeded, pure
  and time-addressable. Audio schedules ahead; the picture reads the present; neither writes to it
  (except the audio engine's smoothed levels, which the picture reads).
- **The pattern layer is a hash, not a schedule**, so the two halves cannot drift apart.
- **Visuals** read the conductor's state and the audio's levels once per frame. No audio data
  crosses into the GPU beyond a handful of uniforms.

## 6. Non-functional requirements

| Requirement | Target |
| --- | --- |
| Audio continuity | no dropout over 8 hours in Chrome, Firefox, Safari on a mid-range laptop |
| Visual frame rate | 60 fps on a laptop iGPU at auto quality, 30 fps floor on phones |
| Start time | playing within 2 s of the click on a warm cache |
| Size | under 5 MB transferred for the whole app |
| Loudness | −15…−13 LUFS, true peak ≤ −1 dBTP |
| Battery | audio-only mode draws no GPU |
| Privacy | no network after load; nothing collected |
| Flashes | capped at 0.22 of picture brightness unless the reader asks otherwise |

## 7. Roadmap

1. **Specs** — this document.
2. **Audio prototype on Web Audio** — done: kick, bass, hats, claps, stabs, arps, pad, risers,
   impacts, sirens, and a master that measures itself.
3. **Visual prototype** — done: the four-layer stack with dynamic resolution and bloom.
4. **The app** — done: controls, seed links, sleep timer, PWA, mobile profile.
5. **Verification** — done: 89 unit tests over the pure modules and a 41-check headless-browser
   smoke test that measures a decoded screenshot, a decoded drop, and an offline render of the
   real engine.
6. **Soak** — *not done*: the eight-hour run (`tools/soak.ts`, ported from Singularity) is the next
   thing to write, and it is the only thing that can answer "does it stay that way".
7. **Motif web build** — shared with Generative Entropy (Motif M8). The conductor's voice and
   event contract is already the one Motif would slot into.
8. **Layer measurement** — Singularity's `tools/stars.ts` measures the nebula's layers by
   subtraction; the same trick against `__foraver.draw({ layers })` would measure this app's four
   layers against each other, which is what would prove the grammar above is the picture on
   screen.

## 8. Relation to Generative Singularity

| | Generative Singularity | FOraveR |
| --- | --- | --- |
| Music | endless ambient | endless techno |
| Time | seconds, no pulse | bars, 122–140 bpm |
| Visuals | nebulae and stars | kaleidoscope, plasma, fractal, noise |
| Shared | the seeded-generation approach, the loudness discipline, the conductor-is-the-source-of-truth rule, `tools/chrome.ts`'s shape, `src/audio/loudness.ts` (unchanged), the PWA and seed-link machinery | |

## 9. Open questions

- **Is 0.22 the right cap?** It was chosen to be clearly a pulse and clearly not a strobe, with
  no ear or eye involved. It has never been looked at by anyone.
- **Does the pad belong?** It is the one layer that is not rhythmic, and it is what a breakdown is
  made of. On a phone it may be the first thing to go.
- **Where does the siren come from?** It is a single pitched sweep inside a long drop, the way a DJ
  drops a vocal. It is currently the only thing in the set that is not derived from the chord.
- **Do the drops need to be harder?** Nothing in the arrangement forces a *peak*: every path into
  one is weighted the same, so a set can go an hour without one.
