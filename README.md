# Visualz

A realtime, maths-driven music visualizer for the browser (iPhone / Mac / PC), built as a
creative sandbox: presets → knobs → equations → live shader code, with deterministic
re-rendering of live performances into social-ready video.

- **[REQUIREMENTS.md](./REQUIREMENTS.md)** — what we're building and why
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — how: signal bus + replayable transport,
  thin WebGL2 layer, CPU expression DSL, WebCodecs export

## Status: v1 scope complete

Everything in [REQUIREMENTS.md](./REQUIREMENTS.md) v1 is built and CI-enforced:

- **Three authoring layers**: param knobs → expression DSL (`docs/DSL.md`) → in-app
  GLSL editing with hot-recompile (errors inline, last good program keeps rendering)
- **Two maths families**: geometry (Lissajous) and GPGPU particles (curl-noise flow
  field, Lorenz attractor — up to 262k particles, `docs/PARTICLES.md`)
- **Inputs on one signal bus**: audio (files analyzed offline into beat-grid feature
  timelines, `docs/ANALYSIS.md`; realtime detector for demo/mic, `docs/EVENTS.md`),
  keyboard, touch pads, XY pad — mapped to actions via one table
- **Deterministic sessions**: performances record as frame-stamped input events
  (including shader edits) and replay pixel-identically
- **Video export**: a Web Worker re-renders any session via WebCodecs to WebM
  (VP9 + Opus audio) at any aspect — 16:9, 9:16, 1:1 — while live playback continues

Suite: 205 unit tests + 30 Playwright e2e (golden images, pixel-hash determinism,
export validity). Deploys to GitHub Pages on push (`.github/workflows/pages.yml`).

## Develop

```bash
npm install
npm run dev        # app at http://localhost:5173
npm run typecheck
npm test           # unit tests (vitest)
npm run test:e2e   # golden-image tests (Playwright, deterministic render mode)
```

`/?test=1&seed=42` boots the engine in fixed-timestep render mode and exposes
`window.__viz.renderFrames(n)` — that's what the golden tests (and future export
pipeline) drive. Golden PNGs live in `tests/e2e/golden.spec.ts-snapshots/`;
regenerate intentionally with `npx playwright test --update-snapshots`.

`@playwright/test` is pinned to 1.56.x to match the Chromium build (1194) used to
generate the goldens — bumping it means regenerating them.
