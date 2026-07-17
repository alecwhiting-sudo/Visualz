# Macro controls — eight generic knobs that survive scene switches

Design spec, architect-authored from the user requirement: "generalise controls
1-8 … map the midi to general controls so that when we switch algorithms there
are still controls in place … if there are only five parameters then those
knobs are inert for the time of that algorithm."

## 0. The problem

Per-param MIDI bindings die on every handoff/scene switch (bindings are
authored against a scene's param names and are cleared by `switchScene`),
forcing a re-learn after each switch. Performers expect the opposite: map the
hardware ONCE, and the mapping follows whatever scene is live.

## 1. The model

- Eight **macro slots**, `ctl.1` … `ctl.8` — ordinary named signals on the bus.
- Hardware maps to slots (not to params): MIDI learn binds a CC to `ctl.N`
  once, in the MIDI panel. This mapping is scene-independent and survives every
  switch.
- Each frame the engine's **MacroRouter** drives the current scene's params
  *positionally*: param index i (schema order) ← slot i+1, range-mapped
  (`min + ctl * (max - min)`). A scene with 5 params uses slots 1–5; slots 6–8
  are inert for that scene.
- **Precedence**: a param with an explicit user binding (DSL expression) is
  skipped by the router — expressions outrank macros. UI slider/rotary edits of
  a macro-DRIVEN param are allowed and simply get overwritten on the next
  engaged-slot frame (same as any bound param; the control is rendered live).

## 2. Pickup semantics (the crux)

Bus signals persist, so after a switch `ctl.N` still holds the old knob
position — driving the new scene's params from it immediately would yank them
all to stale values on every switch. Therefore:

- Each slot has an **engaged** flag. All flags reset to false on `switchScene`
  AND on cold scene change (new Engine) AND on `loadSession`.
- A slot engages when a NEW value arrives for `ctl.N` (an `inputSignal` event
  routes through `Engine.setInputSignal` / the player's `setInputSignal`) after
  the reset. Until then the slot is dormant and the param keeps its
  default/current value.
- Engagement is therefore a pure function of the recorded event stream and the
  switch events — replay and export reproduce it exactly (the same
  `inputSignal` events arrive at the same frames; the same `switch` events
  reset at the same frames). No new session event types are needed.

## 3. What records into sessions

Nothing new. Hardware moves already record as `inputSignal` events
(`ctl.N`, value). Switches already record as `switch` events. The router is
deterministic downstream of both, exactly like DSL bindings: it runs
identically live and in replay. The slot→CC hardware mapping itself is
session-scoped app state (like device active flags), NOT stored in the doc —
the doc stores the resulting `ctl.N` signal values, which is what determinism
needs.

## 4. Engine surface

```ts
// engine.ts
setMacroSlotCount(n)            // fixed 8 in v1; constant, not persisted
// internal: MacroRouter { engaged: boolean[8] }
//   - Engine.setInputSignal(name, v): if name is ctl.N → engaged[N-1] = true
//     (both live path and playerTarget path route through here — verify; if
//     the playerTarget writes inputSignals directly, hook both)
//   - switchScene()/loadSession()/constructor: engaged.fill(false)
//   - updateAndRender, after bindings evaluate: for each engaged slot i with
//     param p_i = scene.params[i] and no user binding on p_i:
//     scene.setParam(p_i.name, p_i.min + bus.ctl(i+1) * (p_i.max - p_i.min),
//     with schema.step snapping identical to the UI's)
// isMacroDriven(paramName): boolean — for the UI to render live values
```

Router runs AFTER binding evaluation each frame (bindings win by simply being
skipped; no double-write). Range-mapping lives in the router, NOT in learn —
`ctl.N` stays a clean 0..1 signal.

**Edge-triggered routing (amendment, 2026-07-17):** an engaged slot writes its
param only when its raw ctl value CHANGED since that slot last routed (per-slot
`lastRouted` memory, cleared at every reset point). Level-triggered routing
re-asserted the stale hardware value every frame, which made UI knob edits on a
macro-driven param impossible — the slider snapped back the instant you let
go. With edges, hardware and software knobs trade control: last writer wins,
and the hardware re-takes the param only when it genuinely moves. Determinism
holds because `startRecording` is a reset point too (review finding, alongside
construction / `switchScene` / `loadSession`): a take always begins from a
dormant router with cleared edge memory — exactly the state `loadSession`
replays from — so `engaged`/`lastRouted` are a pure function of the recorded
ctl stream. Without that reset, engagement carried over from unrecorded
pre-roll input (positioning knobs while the track was stopped) could make
live skip a repeated ctl value that replay would treat as a fresh edge.

## 5. MIDI panel UI

- The MIDI disclosure gains a **Controls 1–8** block: 8 rows, each showing the
  slot number, its learned CC (or "—"), and its live 0..1 value bar.
- **"Map controls…"** button: sequential learn — turn hardware knobs in the
  order you want them as slots 1..8; each distinct CC that arrives claims the
  next slot; Esc/click ends early. Individual per-row re-learn buttons too.
- The per-param MIDI learn (SCENE tab / perform strip / disclosure) stays for
  explicit expression bindings; macro mapping is the new default workflow.
- Perform rotaries and studio sliders render macro-driven params live (same
  visual language as bound params — accent needle — via `isMacroDriven`).
- Rotary/slider rows of macro-driven params show "ctl N" as their source hint
  where bound params show the expression.

## 6. Tests

- Unit: router pickup (dormant after switch until a ctl event arrives; engaged
  slot drives positional param with range map + step snap; user-bound param
  skipped; 5-param scene ignores slots 6-8).
- E2e: record a session with ctl.N inputSignal events spanning a handoff
  switch; replay byte-identical (proves engagement resets deterministically);
  perform rotary visibly tracks a ctl-driven param (DOM assertion on the
  rendered value, via __viz.setInputSignal('ctl.1', …)).

## 7. Not in v1

Slot count config; per-scene custom slot→param ordering; storing hardware
mappings in session docs; soft-takeover value matching (catch the value before
engaging) — pickup-on-first-move is the v1 behavior.
