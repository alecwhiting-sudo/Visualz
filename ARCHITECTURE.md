# Visualz — Architecture

Companion to [REQUIREMENTS.md](./REQUIREMENTS.md). Decisions here were made interactively on
2026-07-15 and are marked **[decided]**.

---

## 1. The organizing idea

The hardest requirement is §5 of the requirements: a live performance must later re-render
**frame-perfectly** offline at exact resolutions/framerates. That is cheap if designed in from
day one and nearly impossible to retrofit. Two rules therefore govern every module:

1. **Nothing reads real time or real randomness.** Time comes only from the `Transport`
   (live mode: audio-clock driven; render mode: fixed timestep). Randomness comes only from a
   seeded PRNG owned by each scene instance. `Date.now()`, `performance.now()`, and
   `Math.random()` are forbidden in engine and scene code (enforced by lint rule).
2. **All inputs become signals on one bus.** Audio features, MIDI, keyboard, touch pads,
   expression outputs — every producer writes named signals (`bass`, `beatPhase`,
   `midi.cc.3`, `pad.x`, …); every consumer (scene params, event→action mappings) reads them.
   A **session recording is just the audio reference + the timestamped input-event log**;
   export replays that log through the identical pipeline at fixed timestep.

```
┌─ Inputs ───────────────┐   ┌─ Core ────────────────────┐   ┌─ Output ────────────┐
│ audio   (file / mic)   │   │ Transport (clock, seek)    │   │ Live canvas (rAF)   │
│ midi    (WebMIDI)      │──▶│ Signal bus                 │──▶│ Export worker       │
│ keys / touch pads      │   │ Mapping layer              │   │  WebCodecs → MP4    │
│ media   (img / video)  │   │ Expression DSL (CPU)       │   └─────────────────────┘
└────────────────────────┘   │ Scene runtime → GPU layer  │
                             │ Session recorder / player  │
                             └────────────────────────────┘
```

## 2. Decisions

| Fork | Decision | Rationale |
|---|---|---|
| GPU layer | **[decided]** Thin custom wrapper over WebGL2 (~1–2k lines: context, program compile with error surfacing, buffers, render targets, ping-pong, fullscreen pass, instanced draws). API shaped so a WebGPU backend can slot in later. | Shaders are the product surface (users edit them in-app); a framework's scene graph fights fullscreen/GPGPU work. Zero baggage, full determinism control. |
| Expression execution | **[decided]** CPU per-frame in v1: expressions compile (AST → sandboxed JS closure) and drive scene *parameters*, evaluated once per frame per binding. | Simple, safe, debuggable. Per-pixel maths already available at the scene-code layer. DSL grammar stays GLSL-compatible (no closures/strings) so a v2 transpiler can push the *same* expressions per-pixel/per-particle. |
| UI shell | **[decided]** React + TypeScript. Canvas and engine are framework-free; React owns panels, knobs, editors (CodeMirror 6 later). | Ecosystem and agent familiarity; perf irrelevant since rendering happens outside React. |
| App structure | Single Vite + TS app, plain folder modules, no monorepo. | Least friction for cloud agents and CI. |
| Persistence | IndexedDB + JSON file import/export, no backend (requirements §6). | |

## 3. Modules

### 3.1 `core/` — Transport, signals, PRNG
- **Transport**: `mode: 'live' | 'render'`. Live: engine's rAF loop calls
  `advanceTo(audioClockTime)`. Render: `step()` advances exactly `1/fps`. Emits
  `Frame { time, dt, frame }`. Seekable; seeking resets downstream frame state.
- **SignalBus**: flat `name → number` map, rewritten every frame; snapshot-able for the
  recorder. Event signals (onsets, triggers) are one-frame pulses.
- **PRNG**: `mulberry32(seed)`; scenes receive a seed and must derive all randomness from it.

### 3.2 `audio/` — two paths, one output shape
- **File path**: on import, a full offline analysis pass (beat grid, tempo, onsets, band
  energies, sections) produces typed-array **feature timelines** stored with the session.
  Playback — live *and* export — reads features by timeline lookup: deterministic by
  construction, and export needs no re-analysis.
- **Live path** (mic): AudioWorklet → streaming FFT → the same named signals, just computed
  on the fly. Mic sessions record the *feature stream*, since raw audio may not be kept.
- Both paths publish the same signal names; scenes never know the difference.

### 3.3 `scenes/` — the layered authoring model
A **Scene is data** (serializable JSON):
```ts
{ meta, seed, params: ParamSchema[], expressions: Record<string, string>,
  source: { shaders/sim }, bindings: Record<param, signalExpr> }
```
Its runtime is a small interface:
```ts
interface SceneRuntime {
  init(gpu: Gpu, seed: number): void
  update(frame: FrameContext): void        // CPU: read signals, advance state
  render(frame: FrameContext, target): void
  resize(w, h): void
  dispose(): void
}
```
- The **geometry/symmetry** and **particles/physics** families are shared libraries scenes
  import — not engine special cases. Fractal/fluid families later implement the same interface.
- Hot-recompile: editing shader source recompiles; on GLSL error the last good program keeps
  rendering and the error surfaces inline.
- Composition must be **aspect-aware** (render target may be 16:9, 9:16, or 1:1).

### 3.4 `mapping/` — one table, four frontends
`Mapping { source, target, transform }` where source ∈ {key, touch pad, MIDI CC/note,
audio event}, target ∈ {set param, ramp param, trigger scene, pulse effect}. Keyboard,
touch, MIDI, and auto beat-events are thin frontends writing into the same table. A future
timeline editor is a fifth frontend writing scheduled events — no new architecture.

### 3.5 `session/` — record & replay
- Recorder: appends `(frame, event)` tuples — input events, mapping actions, param changes —
  plus references to the audio file/feature timelines and the full scene JSON at start.
- Player: feeds the log back into the mapping layer while the Transport runs. Live playback
  and offline export use the *same* player.

### 3.6 `export/` — deterministic offline render **[architecture-critical]**
- Runs in a **Web Worker with OffscreenCanvas**: replays the session at fixed timestep at
  exact output resolution, encodes frames via WebCodecs `VideoEncoder`, muxes with the audio
  track (`mp4-muxer` for H.264/AAC MP4; `webm-muxer` VP9/Opus fallback).
- Slower-than-realtime is fine; dropped frames are structurally impossible.
- Determinism is CI-tested by hashing rendered frames for a fixture session.

### 3.7 `gpu/` — the thin layer
Context creation, program compile with mapped error lines, VBO/VAO helpers, render targets +
ping-pong pairs, fullscreen-triangle pass, instanced draw, GPGPU-via-texture utilities for
particles (WebGL2 has no compute). Interface deliberately mirrors WebGPU concepts (passes,
pipelines, bind-group-shaped uniform blocks) so a WebGPU backend is an additive second
implementation, not a rewrite.

### 3.8 `dsl/` — expressions (v1: CPU)
- Grammar: arithmetic, comparisons, ternary, vec2/3 constructors, pure builtins
  (`sin cos pow …`, `noise`, `smoothstep`), and **stateful helpers** (`smooth(x, t)`,
  `env(attack, release, trig)`, `lfo(hz)`) whose state lives in the frame context keyed by
  expression id — so seek/replay resets cleanly and determinism holds.
- Compile: parse → AST → JS closure over `(frame, signals)`. No user-code `eval` of raw
  strings beyond the parser; no host access from expressions.
- The AST is the future GLSL-transpile input; grammar therefore avoids anything GLSL can't do.

## 4. Directory layout
```
src/
  core/       transport.ts  signals.ts  prng.ts
  gpu/        context.ts  program.ts  targets.ts
  audio/      engine.ts  analysis.ts  worklet/
  dsl/        parse.ts  compile.ts  builtins.ts
  scenes/     types.ts  families/{geometry,particles}/  builtin/
  mapping/    mappings.ts  frontends/{keyboard,touch,midi,audioEvents}.ts
  session/    recorder.ts  player.ts
  export/     worker.ts  encode.ts
  app/        React shell: panels, knobs, meters, editors
  testing/    hooks.ts (window.__viz test harness)
tests/
  unit/       vitest: dsl, transport, signals, analysis (fixture WAVs)
  e2e/        Playwright: golden-image scene tests, export frame-hash test
```

## 5. Testing strategy (agent-first)
- **Unit (vitest)**: DSL parser/compiler, transport stepping, PRNG, feature extraction
  against fixture audio.
- **Golden images (Playwright + headless Chromium)**: `/?test=1&seed=S` boots the engine in
  render mode with synthetic deterministic signals and exposes `window.__viz.renderFrames(n)`;
  tests step to a known frame and screenshot-diff against checked-in PNGs
  (small `maxDiffPixelRatio` for driver variance).
- **Export determinism**: render a fixture session twice, assert identical frame hashes.
- Lint rule bans `Date.now` / `performance.now` / `Math.random` in `src/` outside
  `app/` and explicitly-marked live-input adapters.

## 6. Known risks & mitigations
- **iPhone Safari** is the perf floor and the weakest WebGL2/WebCodecs platform → auto
  quality scaling; export can fall back to WebM or lower fps on-device.
- **WebCodecs H.264 support varies** → capability-detect at export time, offer WebM fallback;
  keep muxing behind one `encode.ts` interface.
- **GPGPU particles without compute shaders** (WebGL2) → texture ping-pong technique, sized
  by quality scaler; WebGPU backend later lifts the ceiling.
- **Golden-image flake across GPUs** → CI always renders on SwiftShader; thresholds tuned;
  every golden test also asserts non-blank output so a silent all-black regression fails.
