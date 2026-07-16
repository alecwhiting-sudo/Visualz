# Scene Handoff — mathematically interlinked scene switching

Design spec for the "interlink two algorithms" feature. Companion to
[ARCHITECTURE.md](../ARCHITECTURE.md) §3.3–3.6. Status: **design, awaiting architect
review.** One item requires a core-interface change and is flagged in §9.

## 0. The requirement, in one line

Scene A runs. The user triggers a switch. **A's on-screen output frame at that instant
becomes B's initial conditions** — not a background, but the seed of B's state. B takes
over. The whole thing must record, replay pixel-identically (same machine), and export
frame-perfectly, including chained switches A→B→C.

The unifying insight: **the handoff snapshot is a `SceneImage`.** Photo Swarm already
turns an RGBA image into simulation state (`setImage` → importance-sampled homes/colors).
Handoff generalizes "image in" to "any scene's rendered frame in": we read back A's frame
to a normalized RGBA snapshot and hand it to B's new duck-typed `ingest(snapshot)`, which
each scene interprets in its own mathematically meaningful way. No new GPU machinery — the
readback path already exists (`gpu/readback.ts`), and Photo Swarm's ingest is a one-line
delegate to the code it already has.

---

## 1. Capture: CPU readback, normalized (Q1)

**Decision: CPU readback (`readPixels`) of A's final frame, flipped and box-downscaled to a
canonical `{width,height,data:Uint8ClampedArray}` snapshot capped at 256px on the long
axis.** Not a GPU texture copy.

Why readback, not a GPU texture handle:
- **One shape serves every consumer.** Two of the strongest ingest targets (photoswarm,
  flowfield) do CPU importance-sampling — they need pixels on the CPU. The texture-primed
  targets (grayscott, kaleido, tunnel) upload the snapshot themselves inside `ingest`. A
  single CPU snapshot feeds both; a GPU handle would force two capture paths and cross-scene
  GPU-resource lifetime management.
- **It reuses the existing `SceneImage` contract verbatim.** `photoswarm.setImage` already
  consumes exactly this shape; its ingest is `setImage(snap)`.
- **Cost is irrelevant.** `readPixels` is a GPU→CPU stall (~1–5 ms at live res), but a switch
  is a *rare, user-triggered* event, not per-frame. iPhone 12 pays it once per switch; export
  is slower-than-realtime by design.
- **Live and export use the identical mechanism.** `readPixels` works the same on a
  `<canvas>` default framebuffer and on the export worker's `OffscreenCanvas`. Same code, same
  bytes on a given machine.

**Normalization (why not full-res):** the snapshot is downscaled to fit `INGEST_MAX = 256`
on its long axis (a 16:9 surface → 256×144), aspect preserved. This matches Photo Swarm's
existing 256px cap and the session `MAX_IMAGE_PIXELS = 65536` ceiling. Normalizing keeps the
ingest a well-defined function of A's *content* rather than of the exact output resolution,
and bounds the CPU sampling cost the same way `setImage` already is.

**Determinism of readback (the real subtlety, feeding *simulation* state):**
- On a **fixed machine + GPU + driver**, `readPixels` of identical rendered content returns
  identical bytes. The downscale+flip is pure integer/float CPU math, deterministic
  everywhere. So the snapshot is **byte-identical between the recording pass and any
  same-machine replay/export at the same resolution.** This is the hard requirement, and it
  is met — it is exactly the guarantee the existing `pixelHash` exact-replay tests already
  lean on.
- **Cross-GPU** (SwiftShader vs real hardware) a rendered frame can differ by ≤1 LSB per
  channel — the variance the golden tests already tolerate via `maxDiffPixelRatio`. Because
  ingest feeds *state*, that 1-LSB difference can be *amplified* over subsequent frames for a
  chaotic sink (Gray-Scott), or *damped* for a contractive one (kaleido feedback, spring-
  damped swarm). We accept this exactly as the golden tests already accept per-scene cross-GPU
  variance: **cross-machine byte-identity is explicitly not promised; same-machine is.** The
  golden test for a handoff pair therefore uses a *contractive* sink (§10), not Gray-Scott.
- **Cross-resolution** snapshots differ (256×144 from 640×360 vs from 1920×1080). This is the
  ordinary "different render resolution → different pixels" fact that already holds for every
  scene. Export-at-1080p twice is identical; export ≠ live-replay-at-540 is expected and fine.

**Vertical flip:** `readPixels` returns rows bottom-up; `ImageData`/`setImage` are top-down.
The capture flips vertically so B sees A right-side-up. Correctness only — determinism holds
either way — but do it.

Reference util (add next to `pixelHash`, which already `readPixels` the surface):

```ts
// src/gpu/snapshot.ts  (or append to gpu/readback.ts)
export interface SceneSnapshot { width: number; height: number; data: Uint8ClampedArray }
export const INGEST_MAX = 256

/** Read the bound drawing buffer, flip vertically, box-downscale to fit INGEST_MAX. Pure
 *  given the pixels; the caller binds the default framebuffer first. */
export function readSurfaceSnapshot(gl: WebGL2RenderingContext, w: number, h: number): SceneSnapshot {
  const raw = new Uint8Array(w * h * 4)
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw)   // bottom-up
  const scale = Math.max(1, Math.ceil(Math.max(w, h) / INGEST_MAX))
  const dw = Math.max(1, Math.floor(w / scale))
  const dh = Math.max(1, Math.floor(h / scale))
  const out = new Uint8ClampedArray(dw * dh * 4)
  for (let dy = 0; dy < dh; dy++) {
    for (let dx = 0; dx < dw; dx++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = dy * scale; sy < (dy + 1) * scale && sy < h; sy++) {
        const flippedY = h - 1 - sy                          // vertical flip
        for (let sx = dx * scale; sx < (dx + 1) * scale && sx < w; sx++) {
          const s = (flippedY * w + sx) * 4
          r += raw[s]; g += raw[s + 1]; b += raw[s + 2]; a += raw[s + 3]; n++
        }
      }
      const d = (dy * dw + dx) * 4
      out[d] = r / n; out[d + 1] = g / n; out[d + 2] = b / n; out[d + 3] = a / n
    }
  }
  return { width: dw, height: dh, data: out }
}
```

---

## 2. Ingest capability — one duck-typed method (Q2)

Not part of `SceneRuntime` (most scenes don't ingest), exactly like `setImage`:

```ts
// src/scenes/types.ts
export interface SceneSnapshot { width: number; height: number; data: Uint8ClampedArray }
export interface IngestingScene { ingest(snapshot: SceneSnapshot): void }
```

The engine duck-types it (`typeof scene.ingest === 'function'`). `SceneSnapshot` is
structurally identical to `SceneImage`/`PhotoSwarmImage`, so shapes are mutually assignable.

`ingest` must be a **pure function of (snapshot, that scene's seed)** — seeded PRNG only, no
`Date.now`/`Math.random` (invariant I4). It is always called **immediately after `init`,
before the scene's first `update`** (§4).

| Scene | Persistent state | `ingest(snap)` semantics |
|---|---|---|
| **photoswarm** | home/color textures + GPGPU swarm | `this.setImage(snap)` — the snapshot **is** the photo. The swarm re-homes to A's frame and keeps reforming it. **One line; already implemented.** |
| **grayscott** | (U,V) ping-pong field 256² | Luminance → chemistry: `V = 0.5·L`, `U = 1 − V` per grid cell (mirrors the spot-seed's `U=0.5,V=0.25`). Bright regions of A become active reaction nuclei. Rebuild the field via `pp.resize(grid, seededField)`. |
| **kaleido** | two RGBA8 feedback targets 512² | Prime the loop: resample snap → 512² RGBA8, `upload` into **both** ping-pong targets, `flip=false`. A's frame is literally what the kaleidoscope starts folding. |
| **tunnel** | 512×1 RGBA32F band-history ring | Prefill the ring: for each of 512 texels sample the snapshot column at `x=i/512`, write `(r,g,b,luma)→(bass,mid,high,rms)`. A's horizontal structure becomes the tunnel's depth rings. *(Weakest fit — tunnel state is audio history, not spatial; kept honest, flagged.)* |
| **flowfield** | GPGPU particle state (px,py,vx,vy) | Importance-sample initial **positions** from snapshot luminance (bright → dense), `v=0`, via `pp.resize(side, seededState)`. Colors are speed-derived in flowfield, so no color ingest. |
| **julia, mandeldive, morphogen** | none — pure functions of `(t, params)` + tiny CPU envelopes | **Non-ingesting (no `ingest` method).** The switch still works as a hard cut; B boots fresh. |

**Why the three fractal/geometry scenes are declared non-ingesting, not force-fitted:** they
hold no spatial field to seed — only a journey phase and audio envelopes driven by time. A
"palette hijack" (average image hue → `hueShift`) would be dishonest and add per-scene code
for a barely-visible effect. The requirement is fully satisfied by the five scenes that have
real state to seed; a scene with no `ingest` degrades gracefully to a plain hard cut. A shared
palette-ingest helper is a clean v2 addition (§8) if we later want it.

Reference ingests (grayscott, flowfield reuse a shared importance sampler — see §8):

```ts
// grayscott
ingest(snap: SceneSnapshot): void {
  const side = this.grid
  const field = new Float32Array(side * side * 4)
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const L = sampleLuminance(snap, x / side, y / side)      // nearest/box, [0,1]
    const i = (y * side + x) * 4
    const V = 0.5 * L
    field[i] = 1 - V; field[i + 1] = V; field[i + 2] = 0; field[i + 3] = 1
  }
  this.pp.resize(side, field)                                 // hard reset to the seeded field
}

// kaleido
ingest(snap: SceneSnapshot): void {
  const rgba = resampleToRGBA8(snap, SIM_SIZE, SIM_SIZE)      // Uint8Array, aspect-fit or stretch
  this.targets[0].upload(rgba); this.targets[1].upload(rgba)
  this.flip = false
}

// flowfield
ingest(snap: SceneSnapshot): void {
  this.pp.resize(this.side, importanceSampleState(snap, this.seed, this.side * this.side))
  this.pulse = 0
}

// photoswarm
ingest(snap: SceneSnapshot): void { this.setImage(snap) }
```

---

## 3. Switch semantics: hard cut (Q3)

**Decision: hard cut at frame N. No crossfade in v1.** Justification:
1. **Ingest already provides continuity.** B starts *as* A's frame (the swarm is the photo,
   the kaleido buffer is A's image). The "pop" a crossfade normally hides is largely absent by
   construction — the whole point of interlinking is that B is visually born from A.
2. **Determinism stays trivial.** Exactly one scene is live at every frame (invariant I1). No
   fade-window state machine, no "when does A finally die" bookkeeping in the event log.
3. **iPhone floor.** A true crossfade means running A *and* B simultaneously for W frames
   (A's state at frame N cannot be cheaply reconstructed once disposed) — 2× GPU during the
   window, on the weakest target.

**v2 crossfade, noted for the interface:** because we *already capture A's final frame*, a
future crossfade needs **no double simulation** — blend the static captured snapshot texture
→ B's live render over a fixed W frames, reusing `CompositeScene`'s blend shader (mode 0,
`uMix = f/W`). Deterministic (W fixed, snapshot deterministic). Design the switch event now so
W is an optional field later; don't build it.

---

## 4. Engine: the in-place switch (Q4 mechanism)

Today the App switches scenes by tearing down the whole Engine and rebuilding
(`onSceneChange`). A mid-session handoff cannot rebuild the world (it would lose the transport,
recorder, signal history, and the very frame we need to capture). Add an **in-place** switch.

```ts
// engine.ts — scene becomes mutable (see §9, core-interface flag)

/** Hand off to another scene mid-session: capture A's current frame, build B, feed it in.
 *  Live callers (App button/hotkey) and the session player both call this; the only
 *  difference is replay runs with recorder === null so it never re-records. Throws on an
 *  unknown scene id (a corrupt doc must fail loudly, never silently keep rendering A). */
switchScene(toId: string): void {
  const entry = SCENES[toId]
  if (!entry) throw new Error(`switchScene: unknown scene "${toId}"`)

  // 1. Capture A's frame BEFORE building B — B.init() ends with gl.clear() on the default
  //    framebuffer and would wipe the surface we need. Bind the default surface explicitly.
  this.surface.bind()
  const snapshot = readSurfaceSnapshot(this.gpu.gl, this.gpu.width, this.gpu.height)

  // 2. Build + init + ingest B while A is still alive, so any failure leaves A intact (I8).
  const next = entry.create()
  next.init(this.gpu, this.seed)                 // may throw (e.g. float-renderable check)
  if (hasIngest(next)) next.ingest(snapshot)     // may throw

  // 3. Commit: record, dispose A, swap, clear A-scoped state.
  if (this.recorder) this.recorder.recordSwitch(this.transport.frame, toId)
  this.scene.dispose()
  this.scene = next
  this.bindings.clear()        // bindings were authored against A's param schema
  // ARCHITECT AMENDMENT (§5a): when B ingested, the snapshot becomes the stored
  // image; when B is non-ingesting, clear it. See §5a for why.
  this.storedImage = hasIngest(next) ? snapshot : null
}

private playerTarget: PlayerTarget = {
  // ...existing...
  switchScene: (id) => this.switchScene(id),   // reuses the method; recorder is null on replay
}
```

Notes:
- **Seed (I9):** B is initialized with `this.seed` (the session seed) — the same value every
  replay uses. No time- or switch-count-derived seed. A→A is therefore a deterministic cold
  reset of A that then ingests its own last frame.
- **Bindings cleared, mappings left alone.** Bindings reference A's param names and are cleared
  (this clear is *implicit in the switch event* — do **not** emit per-param `clearBinding`
  events; replay's `switchScene` clears them the same way, invariant I6). Active
  ramps/pulses in `MappingRuntime` are left untouched: their `params.set(unknownName, …)`
  writes are harmless (every scene's `setParam` tolerates unknown names) and skipping a reset
  avoids dropping a currently-held key. This is deterministic because it is identical in live
  and replay.
- **`hasIngest`**: `typeof (scene as Partial<IngestingScene>).ingest === 'function'`.

---

## 5. Session model & replay (Q4)

New event (additive; `version` stays `1`):

```ts
// session/types.ts — add to the SessionEvent union
| { frame: number; type: 'switch'; toScene: string }
```

- **recorder.ts:** `recordSwitch(frame, toScene) { this.events.push({ frame, type: 'switch', toScene }) }`
- **player.ts:** add `switchScene(id: string): void` to `PlayerTarget`; add the case
  `case 'switch': target.switchScene(event.toScene); break`.
- **serialize.ts:** add `'switch'` to `KNOWN_EVENT_TYPES`; validate `typeof e.toScene ===
  'string' && e.toScene.length > 0`. **Do not** validate `toScene` against the registry here —
  `serialize.ts` is deliberately registry-decoupled (it doesn't check `scene.id` either).
  An unknown id surfaces at apply time when `switchScene` throws, consistent with how
  `loadSession`/`renderSessionToVideo` validate `doc.scene.id`.

**The snapshot is never serialized (invariant I7).** The event carries only the target id;
B's initial conditions are *recomputed* on replay by re-capturing A's re-rendered frame. That
is the entire point — and it is what forces the same-machine byte-identity discipline of §1.

**Why replay reproduces the handoff — the timing chain (invariant I5):**
1. A switch is recorded at `transport.frame` = N, the last completed frame. At that instant the
   default framebuffer holds A's frame-N render (`preserveDrawingBuffer: true`, confirmed in
   `gpu/context.ts`).
2. In live mode the App calls `switchScene` from an event handler *between* rAF ticks →
   surface = frame N, recorded at N.
3. On replay, `renderFrames`/`tick` call `player.applyUpTo(transport.frame)` **before**
   `step()` + `updateAndRender`. So the switch fires when `transport.frame === N`, and the
   surface still holds frame N (rendered at the end of the previous iteration). Identical
   capture input.
4. Frame N is itself deterministic (invariant I2, the existing replay guarantee). Same machine
   ⇒ same readback bytes ⇒ same snapshot (I3) ⇒ same B init state (I4).

**Export path (architecture-critical):** `renderSessionToVideo` builds one Engine with
`SCENES[doc.scene.id].create()` — the *initial* scene — then `loadSession` + a `renderFrames`
loop. Switch events flow through the armed player into `switchScene` mid-loop. **No change to
`render.ts` is required** beyond the player/engine wiring above; the export worker gains the
handoff for free. Export determinism (render twice at the same resolution → identical
`frameHashes`) holds because every step in the chain is deterministic on that machine.

**Interaction with `doc.scene.image`:** unchanged for recordings that start before any
switch. `doc.scene.image` is the *initial* scene's imported media, applied at `loadSession`.
Switch events add no image data. A switch *into* photoswarm gets its material from the
recomputed ingest snapshot, not from `doc.scene.image`.

### 5a. ARCHITECT AMENDMENT — recording started AFTER a handoff

The spec as reviewed had a hole: `startRecording` snapshots the *current* scene id + params,
but a scene that was switched-into holds state born from an ingest snapshot that exists
nowhere in the new doc — replay would boot B with its fallback material, not A's frame.
Fix (small, closes invariant I2 for post-switch recordings):

- `switchScene` sets `this.storedImage = snapshot` when B ingested it (they are the same
  shape — `SceneSnapshot` ≡ `SceneImage`, and INGEST_MAX=256 fits MAX_IMAGE_PIXELS=65536),
  and `null` when B is non-ingesting. The existing recorder plumbing then serializes it into
  `doc.scene.image` automatically for any recording started later.
- `loadSession` applies `doc.scene.image` via `ingest` when the scene has one, falling back
  to the existing `setImage` duck-type (photoswarm's ingest delegates to setImage, so its
  behavior is unchanged; grayscott/kaleido/tunnel/flowfield gain faithful restore).
- New invariant **I11**: after any switch, the engine's stored image reflects exactly the
  material the live scene was born from (or null), so a recording started at ANY point
  replays the scene's true initial state.
- Test to add: switch A→B (ingesting), THEN `startRecording`, render, stop, `loadSession`,
  render same frames — pixelHash must match the live hash.

---

## 6. Controls (Q5)

Minimal v1 surface, all routed through `engine.switchScene` so every path records identically:

- **Target selector + "Switch (hand off)" button** in the panel. The selector picks B (a
  registry id, distinct from the existing current-scene dropdown, which stays a cold
  full-teardown change with no ingest). The button calls `engine.switchScene(targetId)`.
- **Hotkey:** a dedicated key (e.g. `Tab` or `x`) handled in the App's keyboard wiring that
  calls `engine.switchScene(targetId)` for the currently selected target. Handled directly in
  App for v1, **not** through the mapping table (see below).
- **Chained switches** work with zero extra machinery: `switchScene` always operates on the
  current `this.scene` and `this.surface`, so A→B→C is three ordinary switch events at
  different frames, applied in order by the player's monotonic cursor (invariant I10).

**Why the switch is a direct control, not a mapping Action (v1):** the mapping `Action` union
is param-centric (`set`/`ramp`/`pulse`) and `MappingRuntime` only holds a `ParamAccess`
(get/set) — it has no engine reference and no string target. ARCHITECTURE §3.4 *already lists
"trigger scene" as a mapping target*, so the eventual home is settled, but wiring it needs
`MappingRuntime` to gain a scene-switch callback — a cross-module change deferred to when the
MIDI frontend lands (§8). v1 keeps switch direct: fully recordable and replayable via the
`switch` event, just not yet learn-mappable.

**App must re-sync scene-derived UI after a switch** (params panel, meta label, shader-stage
list, `sceneAcceptsImage`) — the same refresh `onSceneChange` does — because `engine.scene`
now points at B. Call `setSceneId(targetId)` and rebuild the param panel from
`engine.scene.params` synchronously after `switchScene` returns.

---

## 7. Failure modes (Q6)

| Situation | Behavior |
|---|---|
| Switch **during recording** | Recorded as a `switch` event — the point. |
| Switch **during replay/export** | Comes from the event log via the player; not re-recorded (recorder is null). |
| Switch **while offline analysis is running** | Orthogonal. Analysis runs in a Worker and only affects the audio timeline/signals; the switch swaps the *scene*. Signals keep flowing to B. No interaction. |
| Switch to an **unknown scene id** | `switchScene` throws. App only offers registry ids, so live never hits it; a hand-edited corrupt doc fails loudly at apply time (replay/export), never renders a wrong scene silently. |
| **Rapid double switch same frame** (A→B→C at frame N) | Both events at N; player applies both at `applyUpTo(N)`. CORRECTED post-implementation (review finding): B's `init()` ends with a `gl.clear` on the default framebuffer, so the second capture reads **B's cleared black frame**, not A's frame N — C is seeded from black. Fully deterministic and identical live-vs-replay (I10 holds); just visually a blank seed. Don't double-switch inside one frame if you want the chain to carry content. |
| **Switch to the same scene** (A→A) | Allowed, no special-casing: dispose A, build fresh A with the session seed, ingest A's own last frame (a soft reset + self-ingest). |
| **B.init or B.ingest throws** (e.g. float targets unavailable) | Capture and build happen *before* A is disposed (I8); on throw A stays live and nothing is recorded. Live handler should try/catch and surface the error; the engine keeps a working scene. |

---

## 8. What NOT to build in v1 (Q7)

- **Crossfade / transition window.** Hard cut only. (v2: blend the captured snapshot texture →
  B over W fixed frames via `CompositeScene`'s blend — no double simulation, §3.)
- **Mapping-layer "trigger scene" Action / MIDI-mappable switch.** Direct button + hotkey for
  now; §6. (Wiring needs `MappingRuntime`→engine access.)
- **Palette/param ingest for julia/mandeldive/morphogen.** They stay non-ingesting; switch is a
  hard cut. (v2: a shared `paletteIngest` helper if wanted.)
- **GPU-texture-handle / zero-copy ingest.** CPU readback only.
- **Per-switch seed derivation.** B gets the session seed.
- **Timeline-scheduled switches.** The timeline editor is deferred anyway; the `switch` event
  is already timeline-friendly (it's `{frame, …}`).
- **Storing the snapshot in the session.** Forbidden — it is recomputed (I7).
- **Cross-machine / cross-resolution byte-identity of the handoff.** Same-machine, same-res
  only — the existing golden/exact-replay stance.
- **Scene stack / undo / N>2 blends.**

---

## 9. Core-interface change to flag to the architect

`Engine.scene` is currently `readonly scene: SceneRuntime`. An in-place switch must reassign
it. **Recommended:** drop `readonly` (or back it with a private field + public getter).

Impact is contained: inside `engine.ts` every `this.scene.*` is a call site that naturally
follows the mutable field; the only external readers (App) go through the public property
(`engine.scene.params`, `.meta`) and will simply observe the current scene. No other module
holds a cached `SceneRuntime` reference across frames. This is the one decision that belongs to
the architect session; everything else in this spec sits behind existing duck-typed seams.

---

## 10. Implementation plan

Order (each step compiles/tests before the next):

1. **`scenes/types.ts`** — add `SceneSnapshot`, `IngestingScene`. *(types only)*
2. **`session/types.ts`** — add the `'switch'` event to the union.
3. **`session/recorder.ts`** — `recordSwitch`.
4. **`session/player.ts`** — `PlayerTarget.switchScene` + `'switch'` case.
5. **`session/serialize.ts`** — `'switch'` in `KNOWN_EVENT_TYPES` + `toScene` validation.
6. **`gpu/snapshot.ts`** (or append to `readback.ts`) — `readSurfaceSnapshot` + `INGEST_MAX`.
7. **`engine/engine.ts`** — `scene` mutable (§9); `switchScene`; `playerTarget.switchScene`;
   `hasIngest`. *(core change)*
8. **Per-scene `ingest`** — photoswarm (delegate), grayscott, kaleido, tunnel, flowfield.
   Optionally extract photoswarm's luminance-CDF sampler to
   `scenes/families/particles/imageSample.ts` (`importanceSampleState(snap, seed, count)` →
   `Float32Array` xy=pos zw=0) and reuse it in flowfield's ingest; add small
   `sampleLuminance` / `resampleToRGBA8` helpers (pure, testable).
9. **`testing/hooks.ts`** — `window.__viz.switchScene(id)` → `engine.switchScene(id)`; add to
   `VizTestApi`.
10. **`app/App.tsx`** — target selector + Switch button + hotkey; re-sync scene-derived UI
    after `switchScene` (§6).

### Test plan

**Unit (vitest):**
- `recorder`: `recordSwitch` appends the right event; `finish` includes it in frame order.
- `player`: a `switch` event calls `target.switchScene(toScene)` exactly once; chained
  switches fire in frame order via the monotonic cursor.
- `serialize`: round-trips a doc with switch events; rejects `toScene` non-string/empty;
  **accepts** a syntactically valid but unknown `toScene` (registry check is deferred).
- `readSurfaceSnapshot`: on a hand-built raw buffer, asserts the vertical flip, the box
  average, aspect preservation, and long-axis ≤ `INGEST_MAX` (deterministic fixture).
- ingest helpers: `importanceSampleState` / `sampleLuminance` are pure functions of
  (snapshot, seed) — same input, same output twice.

**E2e (Playwright, render mode via `__viz`) — all at fixed resolution on SwiftShader:**
- **Handoff golden (required, ≥1 pair).** Use a **contractive sink** so cross-GPU 1-LSB
  readback variance stays within `maxDiffPixelRatio`: boot `scene=flowfield`,
  `renderFrames(K)`, `switchScene('photoswarm')`, `renderFrames(M)`, screenshot-diff a checked-
  in golden; assert non-blank. (Second suggested pair: `grayscott` → `kaleido` — kaleido's
  decaying feedback is contractive and the RD field is unmistakable in the fold. **Avoid a
  Gray-Scott *sink* in a golden** — it amplifies the 1-LSB variance chaotically; Gray-Scott as
  a *source* is fine.)
- **Replay byte-identity spanning a switch (required — proves I3–I7).** `startRecording`;
  `renderFrames(K)`; `switchScene(B)`; `renderFrames(M)`; `doc = stopRecording()`; record
  `H = pixelHash()` at the final frame. Then `loadSession(doc)`; `renderFrames(K+M)`; assert
  `pixelHash() === H`. Run the replay twice; assert identical (CLAUDE.md double-run rule). This
  is the critical determinism test.
- **Export determinism spanning a switch.** `exportSession(doc, {collectHashes})` twice →
  identical `frameHashes`. Exercises the OffscreenCanvas worker building the initial scene then
  switching mid-replay. (Do **not** assert export frames equal live-replay frames — different
  resolution.)
- **Edge cases.** A→A switch renders without crashing and is byte-deterministic on re-run;
  `switchScene('nope')` (and a hand-built doc with a bad `toScene` run through
  `loadSession`+`renderFrames`) throws.

---

## 11. Invariants (numbered)

1. **Single active scene.** Exactly one `engine.scene` per frame; a switch replaces it
   atomically *between* frames. Nothing ever renders a half-swapped world.
2. **Deterministic pre-switch state.** A's frame N is a pure function of (seed, initial
   params/bindings/shaders, event/signal stream ≤ N) — the existing replay invariant, unchanged.
3. **Snapshot reproducibility (same-machine).** snapshot = `readSurfaceSnapshot` after frame N.
   Identical GPU-rendered content on the same GPU/driver → identical readback bytes; the
   downscale/flip is pure CPU math. So the snapshot is byte-identical between record and any
   same-machine replay/export at the same resolution. Cross-GPU/cross-res may differ (accepted,
   §1).
4. **Deterministic ingest.** Each `ingest(snapshot)` is a pure function of (snapshot, scene
   seed) — seeded PRNG only. Given (3), B's initial state is reproducible.
5. **Switch timing fidelity.** Recorded at `transport.frame` (last completed frame); replayed
   by `applyUpTo(sameFrame)` before stepping — so the captured surface holds the identical
   frame in record and replay. Same edge-based model as every recorded input.
6. **Shared apply path.** Live `switchScene(id)` and replay (`player → switchScene(id)`) run
   the identical code; only difference is replay never records (recorder null). No behavior
   branches on live-vs-replay inside the switch — including the implicit bindings-clear.
7. **Snapshot never serialized.** The session stores only `{frame,'switch',toScene}`; the
   snapshot is recomputed on replay. This both keeps docs small and forces (3).
8. **Atomic, fail-safe construction.** B is captured-for, created, init'd, and ingested before
   A is disposed; on any failure A stays active and nothing is recorded.
9. **Seed continuity.** A switched-in scene is init'd with `engine.seed` (the session seed) —
   no time/count-derived seed.
10. **Order-preserving chains.** Switches apply strictly in recorded frame order (player's
    monotonic cursor); A→B→C reproduces the same intermediate captures every run.
