# FractalRave Web Apps

Four standalone web applications generating endless algorithmic audio-visual experiences in the browser. Built with TypeScript, Vite, WebGL2, and Web Audio — zero runtime dependencies.

## Apps

| App | Genre | Visuals | Port |
|-----|-------|---------|------|
| **Aurora** | Synth-pop / ambient | Aurora borealis, nebulae | 8088 |
| **FOraveR** | Techno (122–140 BPM) | Fractal kaleidoscope, plasma | 8089 |
| **Jeffer** | Electro (122–132 BPM) | Oscilloscope (master bus) | 8090 |
| **Generative Singularity** | Cosmic drone | Deep space, starfields | 8088 |

Each app is a **PWA** (offline-capable, installable) with deterministic seeded generation — share a URL fragment to reproduce the exact same journey.

## Quick Start

```bash
# Install all apps
npm run install:all

# Development (run in separate terminals)
npm run dev --prefix apps/aurora      # http://127.0.0.1:8088
npm run dev --prefix apps/foRAVEr     # http://127.0.0.1:8089
npm run dev --prefix apps/jeffer      # http://127.0.0.1:8090
npm run dev --prefix apps/singularity # http://127.0.0.1:8088

# Build all for production
npm run build:all

# Verify everything (typecheck + test + build)
npm run verify:all

# Smoke test (headless Chrome, requires Chrome/Chromium)
npm run smoke:all
```

## Architecture

```
webapps/
├── apps/
│   ├── aurora/
│   ├── foRAVEr/
│   ├── jeffer/
│   └── singularity/
└── packages/
    └── shared/          # @fractal-rave/shared (types, RNG, noise, conductor, color, profile, seed)
```

Each app:
- **TypeScript** (strict, two tsconfigs: app + tools/tests)
- **Vite** build (app + service worker)
- **WebGL2** shaders embedded as strings (offline-first)
- **Web Audio** with offline loudness verification (−14 LUFS target)
- **Headless Chrome smoke tests** (33–59 checks per app)
- **Layer measurement** via subtraction (`npm run stars`)

## Shared Package

`@fractal-rave/shared` exports:
- `Seed`, `RNG`, `Noise` — deterministic generation
- `Conductor` — time-addressable music/visual state
- `Color`, `Palette` — color science
- `Profile` — mobile/desktop quality settings
- `Types` — `Key`, `Chord`, `Section`, `Levels`, `Drift`, `EngineStats`, `RenderStats`, `PlayerStats`

Apps import via `"@fractal-rave/shared": "file:../../packages/shared"`.

## Commands (per app)

```bash
npm run dev          # Vite dev server with HMR
npm run build        # Production build → dist/
npm run serve        # Serve dist/ with COOP/COEP headers
npm run typecheck    # tsc on app + tools (both tsconfigs)
npm test             # Pure logic tests (node --test, ~0.4–4s)
npm run smoke        # Headless Chrome integration test (~1.5–3min)
npm run stars        # Visual layer measurement by subtraction
npm run soak         # Long-run stability (Singularity only)
npm run preview      # ANSI-block render of last capture
npm run icons        # Regenerate PWA icons
```

## Deployment

Each `dist/` is a static site. Deploy anywhere:
- `npm run build` → `dist/` (index.html, js/index.js, styles.css, sw.js, icons/, manifest.webmanifest)
- Service worker precaches `SHELL` (hand-written in `src/sw.ts`, must match Vite output)
- Requires HTTPS for PWA install / service worker

## License

MIT OR Apache-2.0 (per app)