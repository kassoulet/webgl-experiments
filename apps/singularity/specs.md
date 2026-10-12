# Generative Singularity — Endless Cosmic Drone & Deep Space Visuals

**Specification, draft, 2026-09-23.** A design document: numbers are targets to measure against,
not invariants. Sister project of **Generative Entropy** (both live in the FractalRave monorepo, `../../`), sharing its audio
engine, Motif, but not its product: **Generative Singularity is a web app. There is no stream,
no uplink, no server** — the music and the visuals are generated live in the listener's browser,
forever.

---

## 1. What it is

A browser page that plays an endless, slowly evolving ambient piece — cosmic drones, pads and
chords — under deep-space visuals: volumetric nebulae drifting through procedural starfields.
Open it and it plays; leave it open for hours and it never loops, never stops, never breaks.

One sentence: *an infinite ambient space journey that runs entirely in a browser tab.*

Where Generative Entropy is a non-stop techno act (a kick, drops, energy), Generative Singularity
is the opposite end: no beat, no drop, no energy curve to climb — slow harmonic motion, texture
and space, changing on the scale of minutes.

## 2. Audio

Everything is generated; nothing is sampled or pre-rendered.

| Layer | What it is | How it moves |
| --- | --- | --- |
| **Generative pads** | wide, slowly breathing chords of detuned oscillators, granular clouds and string-machine voices | voicings drift note by note; filters open and close over tens of seconds |
| **Tape-warped drones** | long sustained tones — root and fifth, octaves, sub — run through a tape model: wow and flutter (slow and fast pitch wobble), saturation, a soft high cut, a little hiss | the warp depth and the tape's "age" wander slowly; drones cross-fade between notes of the key |
| **Slow generative chords** | a harmonic progression that changes every 20–90 seconds: modal (minor, dorian, lydian…), with suspended and added-note voicings, voice-led so each change moves as few notes as possible | chords overlap as they change: a new one fades in under the old one |
| **Cosmic soundscapes** | unpitched layers: filtered noise winds, granular dust, shimmering high partials, very long reverb tails, occasional far-away events (a distant tone, a rising sweep) | sparse, random within rules, never rhythmic |

Rules for the sound:

- **No pulse.** Nothing that reads as a beat or a tempo; timing is in seconds, not bars.
- **Consonance first.** Every layer follows the current key and chord; changes are voice-led.
- **Slow.** No parameter jumps; every change is a glide or a cross-fade of at least several seconds.
- **Space.** Long reverbs and delays are part of the sound, not an effect on top: the reverb *is*
  the room of the piece.
- **Endless without repeating.** Seeded generation with state that drifts, so the same moment does
  not come back; a seed (or a shared link carrying it) reproduces a journey.
- **Loudness.** A gentle master (a slow leveller and a true-peak limiter), quieter than a streaming
  techno target: around −18 to −16 LUFS, with real dynamics.

### Engine

**Motif on the web** (Motif's `ROADMAP.md`, M8): Motif compiled to WebAssembly, rendering in an
AudioWorklet, with its mixer and master (fundsp effects, ebur128 metering). What this project adds
to Motif, and what Motif gains from it:

- a **tape model** (wow/flutter as modulated delay, saturation, high cut, hiss);
- **long sustains**: notes that are held and cross-faded rather than triggered and decayed (Plaits'
  internal envelope is percussive; drones need gated or re-triggered overlapping voices, or a
  dedicated sustained voice);
- a **harmony generator**: key, mode, chord progression with voice leading, driving every pitched
  layer;
- **seconds-based time**: the scheduler runs on free time, not on bars (Motif's clock is in
  cycles; at a fixed slow tempo one cycle can simply be one second).

The engine choice is open until Motif's web build exists (§7): the fallback is the browser's own
Web Audio graph (oscillators, `ConvolverNode` reverb, `DelayNode` tape wobble), which is enough for
a first version but harder to keep deterministic.

## 3. Visuals (GLSL)

WebGL2 fragment shaders; no geometry beyond a full-screen triangle.

| Layer | What it is |
| --- | --- |
| **Volumetric nebulae** | clouds of gas and dust raymarched through 3D noise (fbm of simplex/value noise with domain warping), with emission and absorption, so light seems to glow through depth; a 2D-layered fallback (several parallax planes of 2D fbm) for weak GPUs |
| **Procedural starfields** | stars from hashed cells at several depths (parallax), with size, colour temperature and twinkle from the hash; a few bright stars with diffraction spikes; a faint Milky-Way band |
| **Motion** | a slow drift of the camera through the volume — minutes to cross a nebula; no cuts |
| **Colour** | palettes from real emission nebulae (H-alpha red, O-III teal, S-II gold) and a few imaginary ones, changing slowly with the music's harmony |

Rules for the picture:

- **Slow and continuous**, like the sound: no flashes, no cuts, no strobing (the photosensitivity
  concern of Generative Entropy does not arise, and must not be introduced).
- **Driven by the audio**, gently: the harmony picks the palette, the pad and drone levels breathe
  the nebula's brightness, far-away sound events can light a distant star — never a beat-synced
  pulse.
- **Resolution-independent**: render at a scaled internal resolution with dynamic resolution
  scaling to hold the frame rate, then upscale; the raymarch step count is the quality knob.

This is GLSL (WebGL2), not the WGSL of Complex Plane: the target is every browser, including those
without WebGPU. A WebGPU path can come later.

## 4. The app

- **One static page**: HTML, the wasm engine, the shaders. Hosted on any static host; no backend,
  no accounts, no analytics required.
- **Start**: a single "enter" click (browsers require a user gesture before audio), then full
  screen.
- **Controls, minimal and hidden until the pointer moves**: volume, a seed (and a "copy link"
  that carries it), visuals quality (auto / low / high), audio-only mode (screen off, for sleep or
  focus), a sleep timer with a slow fade-out.
- **Mobile**: plays on phones; the 2D nebula fallback and fewer voices there; keeps playing with
  the screen locked where the platform allows.
- **Offline**: installable as a PWA; once loaded, it needs no network.

## 5. Architecture

```
┌──────────────────────── browser tab ─────────────────────────┐
│  UI (controls)                                               │
│      │ seed, volume, quality                                 │
│      ▼                                                       │
│  Conductor (JS/wasm) ── harmony, section, "events" ──┐       │
│      │                                               │       │
│      ▼                                               ▼       │
│  AudioWorklet: Motif wasm            WebGL2: nebula + stars  │
│  pads · drones · chords · scapes     uniforms: palette,      │
│  tape · reverb · master              brightness, drift, time │
│      │                                               ▲       │
│      └── levels, events (shared memory) ─────────────┘       │
└──────────────────────────────────────────────────────────────┘
```

- **Conductor**: owns the long-horizon state — key, mode, current chord and the next one, the
  mood/section, when a far-away event happens. Both audio and visuals read it; it is seeded.
- **Audio** renders in the AudioWorklet; a render-ahead worker plus a `SharedArrayBuffer` ring keeps
  the audio thread lock- and allocation-free (the same rule as Motif's native player). This needs
  cross-origin isolation headers (COOP/COEP) on the host.
- **Visuals** read the conductor's state and the audio's levels once per frame (no audio data
  crosses into the GPU beyond a few uniforms).

## 6. Non-functional requirements

| Requirement | Target |
| --- | --- |
| Audio continuity | no dropout over 8 hours in Chrome, Firefox, Safari on a mid-range laptop |
| Visual frame rate | 60 fps on a laptop iGPU at the auto quality, 30 fps floor on phones |
| Start time | playing within 2 s of the click on a warm cache |
| Size | under 5 MB transferred for the whole app |
| Loudness | around −18 to −16 LUFS, true peak ≤ −1 dBTP |
| Battery | audio-only mode draws no GPU |
| Privacy | no network after load; nothing collected |

## 7. Roadmap

Progress against these steps is tracked in [`README.md`](README.md) § "Status against the roadmap".

1. **Specs** — this document.
2. **Visual prototype**: a single WebGL2 page with the starfield and a 2D-layered nebula, then the
   raymarched volumetric nebula; dynamic resolution; measured on a laptop and a phone.
3. **Audio prototype on Web Audio** (the fallback engine): a drone, a pad, a slow chord
   progression, a reverb — to settle the musical rules before the engine work.
4. **Motif web build** (shared with Generative Entropy: Motif M8) — the wasm engine in an
   AudioWorklet.
5. **Motif additions**: sustained voices, the tape model, the harmony generator, seconds-based
   scheduling (each useful to Generative Entropy's drones and textures too).
6. **Conductor** and the audio-driven visuals.
7. **The app**: controls, seed links, sleep timer, PWA, mobile profile.
8. **Soak**: 8 hours on each browser.

## 8. Relation to Generative Entropy

| | Generative Entropy | Generative Singularity |
| --- | --- | --- |
| Music | non-stop techno, DJ-style transitions | endless ambient: drones, pads, chords, soundscapes |
| Time | bars and beats, the score's Rocket rows | free time, seconds |
| Visuals | Complex Plane fractals (WGSL, wgpu; WebGL2 player) | nebulae and starfields (GLSL, WebGL2) |
| Delivery | 24/7 YouTube stream (and a planned web version) | a web app only |
| Shared | **Motif** (engine, mixer, master, web build), the seeded-generation approach, the loudness and continuity discipline | |

## 9. Open questions

- ~~**Engine timing**: wait for Motif's web build, or ship a Web Audio version first?~~ Decided:
  the Web Audio version shipped first (the README records it); Motif's wasm build replaces it later.
- **Sustained voices in Motif**: extend the Plaits voice with a held gate, or add a dedicated
  drone voice?
- **Volumetric cost on phones**: is the raymarched nebula viable at all, or is the 2D fallback the
  phone experience?
- ~~**Where it lives**: a folder here for now; its own repository when work starts.~~ Resolved:
  `apps/singularity/` in the FractalRave monorepo.
