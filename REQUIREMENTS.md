# Visualz — Requirements

A realtime, maths-driven music visualizer that runs in the browser on iPhone, Mac, and PC,
built as a **creative sandbox**: you don't just pick presets, you can open any visual up and
change its equations and code. Sessions can be performed live and then re-rendered
deterministically into social-ready video (YouTube, Instagram, Facebook).

These requirements were gathered interactively on 2026-07-15. Decisions marked **[decided]**
were explicit choices; items marked **[assumed]** are defaults to confirm before build.

---

## 1. Product definition

| Question | Decision |
|---|---|
| Primary user | **[decided]** The owner / creative explorers — depth and flexibility beat polish; a nerdy UI (exposed equations and parameters) is a feature, not a bug |
| Core experience | **[decided]** Realtime instrument first; deterministic video export second |
| V1 success milestone | **[decided]** "A creative sandbox" — the layered authoring system (knobs → equations → shaders) is the star. Fewer built-in scenes is acceptable if you can genuinely invent new maths in-app |
| Platform strategy | **[decided]** Web-first (WebGL2 baseline, WebGPU fast-path). Runs in any modern browser on iPhone/Mac/PC. Later wrappable as PWA, Tauri/Electron desktop, or Capacitor iOS app |
| Backend | **[decided]** None in v1. Static site; scenes/sessions persist to browser storage and export/import as JSON files |

### Why web-first
Cloud coding agents in Linux sandboxes can build, headlessly test (Playwright + the
pre-installed Chromium), and deploy web tech end-to-end. Native Swift/Metal would require
macOS runners and code signing that sandboxed agents can't do. This was the deciding
constraint the user named up front ("what can compile with cloud agents in sandbox").

---

## 2. Audio input

| Source | Status | Notes |
|---|---|---|
| Uploaded audio files (MP3/WAV/AAC/OGG) | **[decided]** v1 | Enables full-track pre-analysis: BPM, beat grid, onsets, section/drop detection, per-band energy envelopes. This powers both smarter realtime visuals and exact-sync export |
| MIDI / DAW sync | **[decided]** v1 | WebMIDI note + CC + clock. **Caveat accepted implicitly: WebMIDI is Chrome/Edge-only** — MIDI is a desktop-Chrome feature, not available on iPhone Safari |
| Live microphone | **[assumed]** v1 | Not explicitly selected, but cheap via WebAudio `getUserMedia` and the only live input that works on iPhone. Assumed in unless cut |
| System/desktop audio | Out of v1 | Impossible in mobile browsers; on desktop requires screen-capture-with-audio workarounds. Revisit if/when a desktop (Tauri) wrapper ships |
| Streaming services (Spotify etc.) | Out of scope | DRM prevents raw audio access |

### Audio analysis pipeline (derived requirement)
- Realtime path: streaming FFT (WebAudio `AnalyserNode` or AudioWorklet), per-band energy
  (bass/mid/high, configurable bands), spectral centroid, RMS, onset detection.
- Offline path (files): full-track analysis pass producing a beat grid, tempo, onsets,
  loudness curve, and section boundaries — stored with the session so export re-renders
  are deterministic.
- All analysis outputs are exposed as **named signals** (`bass`, `onset`, `beatPhase`,
  `centroid`, `rms`, `midi.cc[n]`, …) that any scene parameter or expression can bind to.

---

## 3. The creative engine (the star of v1)

### 3.1 Layered authoring model **[decided]**
Every visual is a **Scene** — a single data model with three progressively deeper editing layers:

1. **Knobs** — each scene exposes named, ranged parameters with sensible defaults;
   presets are saved parameter snapshots. Casual use never goes deeper than this.
2. **Equations** — scene parameters and internal fields can be driven by user-written
   math expressions in a small, safe DSL: `f(t, beatPhase, bass, centroid, x, y, …)`.
   Live-editable with instant visual feedback and inline error reporting.
3. **Code** — the scene's full shader (GLSL) / simulation source opens in an in-app
   editor. Edit → hot-recompile → see it live. Compile errors surface inline and never
   crash the running visual (last good version keeps rendering).

Requirements that fall out of this:
- Scenes are serializable JSON (params + expressions + source + signal bindings) so they
  can be saved, exported, imported, and diffed.
- A scene SDK/schema documented well enough that cloud agents can author new scenes as
  ordinary code contributions with headless screenshot tests.
- User-supplied expressions/shaders are sandboxed: bounded execution, no network/storage
  access from the DSL, GPU compile failures handled gracefully.

### 3.2 V1 maths families **[decided: geometry & symmetry + particles & physics]**
First-class renderers, each shipping with 2–4 built-in scenes:

- **Geometry & symmetry**: Lissajous/harmonograph curves, phyllotaxis, L-systems,
  tilings/kaleidoscope symmetry groups, 3D wireframes — crisp, mathematical aesthetics.
- **Particles & physics**: GPU particle swarms (target: 100k+ on desktop, auto-scaled down
  on mobile) driven by vector fields, strange attractors (Lorenz et al.), springs/gravity,
  audio-impulse forces.

Deferred families (design the renderer interface so these slot in later):
shader fields & fractals; simulations (reaction–diffusion, fluids, flocking, CA).

### 3.3 Imported media as raw material **[decided]**
- Users can import **images**, **silent video**, and **video with sound**.
- V1 usage mode: media becomes a **texture the maths distorts** — particles form/scatter
  the image, geometry warps it, feedback/kaleidoscope loops eat video frames.
- Video with sound: frames feed the visual pipeline while its audio track feeds the
  analysis pipeline simultaneously.
- Deferred: palette/edge extraction as a steering signal; layer-compositing/VJ-mixer model.

---

## 4. Performance & triggering

### 4.1 Performance floor **[decided]**
- 60 fps on **iPhone 12+ (Safari)** and **any 2020+ mid-range laptop**.
- WebGL2 is the compatibility baseline; WebGPU is a fast-path when available.
- Automatic quality scaling (particle counts, render resolution) to hold frame rate;
  a visible fps/quality indicator in dev mode.

### 4.2 Triggering & performance controls **[decided: auto events + keyboard/touch; MIDI from §2]**
- **Auto (audio-reactive)**: beat/onset/drop events can fire scene switches, palette
  shifts, bursts — configurable event→action mappings; "it just dances" with zero input.
- **Keyboard**: mappable hotkeys for scene switching and momentary/toggle effects.
- **Touch**: on-screen trigger grid + XY performance pads (must be first-class on iPhone).
- **MIDI**: learn-mode mapping of any knob/pad to any scene parameter or trigger
  (Chrome/Edge desktop only).
- Every mapping targets the same underlying signal/action system — one mapping layer,
  four input frontends.
- Deferred: timeline choreography ("at 1:32 switch scene, ramp warp to 0.8"). Note the
  session-recording format (§5) should be designed so a timeline editor can read/write it later.

---

## 5. Video export

### 5.1 Deterministic offline render **[decided]**
- Live performances are recorded as a **session**: input signals, triggers, and parameter
  changes timestamped against the audio timeline (not screen-captured).
- Export **re-renders the session frame-by-frame** via WebCodecs at exact specs, with the
  audio track muxed in. Slower than realtime is fine; dropped frames are impossible.
- Determinism requirement: given the same session file, the renderer produces identical
  frames — scenes must use seeded randomness and fixed-timestep simulation during export.

### 5.2 Output targets
| Platform | Aspect | Resolution | fps |
|---|---|---|---|
| YouTube | 16:9 | 1920×1080 (4K later) | 30/60 |
| Instagram Reels / Stories, FB | 9:16 | 1080×1920 | 30 |
| Instagram feed | 1:1 | 1080×1080 | 30 |
| Desktop/wallpaper use | 16:9 / native | up to display res | 60 |

- Container/codec: MP4 (H.264/AAC) where the browser's WebCodecs supports it; WebM
  (VP9/Opus) fallback. Files must upload cleanly to all three platforms without re-encoding.
- Scenes render aspect-aware (composition adapts, not letterboxes).
- Fallback: a "quick capture" MediaRecorder path is nice-to-have for instant rough clips.

---

## 6. Persistence & sharing **[decided: local-only, zero backend]**
- Scenes, presets, mappings, and sessions save to IndexedDB and export/import as JSON.
- Imported media stays local (object URLs / IndexedDB blobs); nothing uploads anywhere.
- Deferred: scene-state-in-URL shareable links; accounts/cloud gallery explicitly out of scope.

---

## 7. Build & agent-compatibility constraints
- TypeScript static web app; no server required to run (`npm run dev` / static `dist/`).
- Everything buildable and testable in a headless Linux sandbox:
  - Unit tests for the expression DSL, signal system, audio analysis (fixture WAVs).
  - Headless-Chromium (Playwright) screenshot tests per scene with seeded randomness —
    golden-image diffs so agents can verify visual changes without eyes.
  - Deterministic export tested by hashing rendered frames for a fixture session.
- No paid services, keys, or native toolchains required for CI.

## 8. Out of scope for v1 (explicit)
Cloud rendering; accounts/social features; system-audio capture; streaming-service input;
timeline editor (format designed for it, UI deferred); fractal/fluid renderer families
(interface designed for them); native app store builds.

## 9. Open questions (confirm before build)
1. **Live microphone** — assumed in (§2); confirm.
2. Is Chrome/Edge-only MIDI acceptable long-term, or does a desktop wrapper (Tauri) that
   adds native MIDI+system-audio deserve a v2 slot?
3. Expression DSL surface: math-only (`sin`, `noise`, vectors) or also stateful helpers
   (oscillators, envelopes, `lag()`/`smooth()`)?
4. Max export length/resolution for v1 (affects memory strategy in the WebCodecs muxer)?
5. Any aesthetic north star (references, artists, existing visualizers you love/hate)?
