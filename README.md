# Visualz

A realtime, maths-driven music visualizer for the browser (iPhone / Mac / PC), built as a
creative sandbox: presets → knobs → equations → live shader code, with deterministic
re-rendering of live performances into social-ready video.

- **[REQUIREMENTS.md](./REQUIREMENTS.md)** — what we're building and why
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — how: signal bus + replayable transport,
  thin WebGL2 layer, CPU expression DSL, WebCodecs export

## Status

Working skeleton proving the architecture end-to-end: deterministic `Transport`,
`SignalBus`, seeded PRNG, thin GPU layer, an audio-reactive Lissajous scene
(geometry family) with live param knobs, file-audio playback with band-energy
signals, and a headless golden-image test harness.

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
