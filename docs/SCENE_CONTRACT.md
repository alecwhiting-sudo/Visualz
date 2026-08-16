# Scene Contract — rules every visual must follow

Companion to [REQUIREMENTS.md](../REQUIREMENTS.md) §4a and
[ARCHITECTURE.md](../ARCHITECTURE.md) §"Preview = export". This is the checklist
for adding a new visualization algorithm so it can never fall into the
live-vs-export trap that Terrain Flight / Terrain Mirror / Tunnel × Terrain fell
into (and were removed for).

## The one requirement, in plain English

> **What you see in the live preview must be what comes out of the export.**

This was always implied but never written down or tested, so scenes drifted from
it silently. It is now a first-class, tested requirement. A scene that fails it
does not ship.

## Why scenes broke it

The app runs a scene at **different speeds in different places**: the live
preview runs at your monitor's refresh (often ~120Hz), while an export runs at a
fixed 30 or 60 fps. Any scene whose look depends on *how often it is drawn* —
rather than *how much time has passed* — therefore looks different when exported.
Two specific mistakes caused every case:

1. **Accumulating inside the drawing step** (trails/fades drawn each frame). Draw
   more often → more accumulation → a washed-out export.
2. **Advancing motion "per frame" instead of "per second."** Fewer frames on
   export → slower motion → a different result.

## The rules (each is mechanically testable)

**R1 — Drawing never changes anything.** `render()` must be a pure function of
the scene's state and the output size: same state in ⇒ same pixels out. Calling
`render()` twice with no `update()` between must be **byte-identical**. No trail
pass, no framebuffer feedback, no scene state mutated inside `render()`.
→ *Test:* `rerender()` twice, assert equal `pixelHash()`.

**R2 — All history lives in the simulation, in `update()`, in seconds.** Trails,
motion, momentum, particle state — everything that carries between frames is
advanced in `update()`, scaled by elapsed time (`frame.dt`). Never advance by a
fixed amount per call. If a scene needs a trail, the trail is *state* the
simulation owns and `render()` only reads — it is not a side effect of how often
you drew.
→ *Test:* render to the same wall-clock time at 30/60/120 fps; results match.

**R3 — Time and randomness come only from the engine.** No `Date.now()`,
`performance.now()`, or `Math.random()` anywhere in `src/` outside `src/app/`.
Time is `frame.dt` / `frame.time` from the Transport; randomness is the scene's
seeded PRNG (`src/core/prng.ts`).
→ *Test:* lint rule (already enforced) + byte-identical `loadSession` replay.

**R4 — Stiff simulations use fixed sub-steps, never variable `dt`.** Reaction-
diffusion, verlet chains, and similar numerics destabilise under a variable
timestep. They sub-step at a fixed virtual `dt` a whole number of times per
update — so "just multiply everything by `dt`" is *banned* for these.

**R5 — Aspect- and resolution-independent.** Correct composition at 16:9, 9:16,
and 1:1, and at any supersample scale (no hard-coded pixel constants that break
at 4K).

## Definition of done for a new scene

A new scene is not done until **all** of these are true and green:

- [ ] Implements `SceneRuntime`; **all state mutates only in `update()`**.
- [ ] `render()` passes the purity check (`rerender()` twice = identical).
- [ ] Motion/trails are `frame.dt`-paced (R2); stiff sims fixed-sub-stepped (R4).
- [ ] No `Date.now`/`performance.now`/`Math.random` outside `src/app/` (R3).
- [ ] Ships an e2e spec with: golden image (16:9), non-blank at all three
      aspects, **render-purity** check, **frame-rate-independence** check
      (30/60/120 fps match), and byte-identical `loadSession` replay.
- [ ] `npm run typecheck && npm test && npm run test:e2e` all pass.

## Reference implementation

`src/scenes/builtin/terrain.ts` (the flat perspective grid) is the first scene
built to this contract — read it as the worked example. Its whole design is
"state in `update()`, pure `render()`, no trail," which is why it previews and
exports identically at every frame rate with no special-casing.

## The engine-level follow-up (not yet done)

R1/R2 are currently held by each scene individually. The durable fix is to make
the engine advance the simulation a fixed number of steps per second — identical
live and on export — so scenes get frame-rate independence for free (the
`framesToCatchUp` helper in `src/core/transport.ts` is written for exactly this
but not yet wired in). Until that lands, **every new scene must satisfy the rules
above on its own**, and the tests above are what hold the line.
