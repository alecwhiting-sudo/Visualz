# A/B decks & cross-feed — design research (NOT YET APPROVED)

Status: research parked 2026-07-18. The user wants more thought before any
build — nothing in this document is committed work. Companion to
[HANDOFF.md](./HANDOFF.md) (one-shot ingest, shipped) and
[MACROS.md](./MACROS.md).

## 1. The finding

One-shot handoff ingest only produces lasting narrative when the receiving
scene *remembers* its initial condition. Audit of the five shipped ingests:

| Sink | Snapshot becomes | Legibility | Persistence |
|---|---|---|---|
| photoswarm | home + color texture (particles perpetually re-form it) | very high | indefinite — the genuine one |
| kaleido | seeds both feedback buffers | high | medium (fades in seconds) |
| grayscott | luminance → chemistry seed | medium | short (~1-3s, then RD owns it) |
| flowfield | luminance-sampled particle positions | medium | very short (advection smears) |
| tunnel | columns → band-history ring | low | very short |

Photoswarm works because homing is a memory attractor. Everything else is
dissipative/advective and washes the image out. **Sustained narrative needs
continuous coupling (A feeds B every frame), not a bigger snapshot.**
One-shot ingest stays valuable as *transition punctuation* (B born from A's
frame at the cut); cross-feed is the sustained groove. Complementary, not
competing.

## 2. Existing head start

`CompositeScene` (blend-* combos) already runs two full scenes to separate
render targets and blends them (crossfade/add/multiply/screen), and its
`mix` param is `OWN_PARAMS[0]` — already ctl.1 on hardware for any combo.
Missing: (a) the children are blind to each other (no A→B data path),
(b) the pair is fixed at construction (5 curated combos), (c) no punch.

## 3. Genuinely-strong pairs, ranked (payoff ÷ effort)

Perf rule: fractal scenes (julia, mandeldive, fractallab, resonance, morph)
are cheap single-pass shaders; GPGPU/feedback scenes (photoswarm, flowfield,
grayscott, kaleido, tunnel) are expensive. The iPhone-safe deck is **one
cheap field + one heavy consumer** — which the ranked pairs naturally are.

1. **fractal → photoswarm (continuous re-home)** — home texture = A's LIVE
   frame; the swarm chases a morphing target. Needs GPU home-derivation from
   a sampler (no per-frame readPixels). Highest payoff.
2. **anything → kaleido (feedback food)** — kaleido already eats its own
   previous frame; feed it A's live target instead. Nearly free.
3. **resonance → flowfield (force field)** — particles advect along A's
   gradient; on a Chladni field they settle onto nodal lines (sand on a
   plate). julia→flowfield = streaming along fractal contours. Same
   mechanism.
4. **domain warp** — B offsets its sample uv by A's luma/gradient. One
   sampler + two shader lines in B.
5. **palette sharing** — structural B colors itself by sampling A. Partly
   achievable today via multiply/screen blend modes.

## 4. Architecture options

**(i) Generalize CompositeScene (recommended first slice).** Three additions:
- Cross-feed tap: after `childA.render(ctx, targetA)`, hand `targetA` to a
  duck-typed `childB.setUpstreamTexture(target)` before B renders. Same seam
  style as `ingest`/`setImage`. No new recorded state — deterministic as a
  pure function of both children's frames (fixed A-before-B render order).
- Punch: momentary `mix→1` while held (pad/key/MIDI note), restore on
  release. Pure param automation — already recorded/replayed.
- Live rebind: `setChild('a'|'b', sceneId)` + additive session event
  `{frame,'setChild',slot,toScene}` mirroring the existing `switch` event.

**(ii) Engine-level dual-deck compositor (deferred end-state).** Decks as
first-class engine state, `ctx.upstream` texture in FrameContext, crossfade
replaces the hard cut, session doc grows a deck model. Architecture fork —
main session + user decision. Design (i)'s events as deck events so (ii)
can subsume them without a format break.

**Perf guardrail:** two full scenes at 60fps on iPhone 12 WebGL2 is the
floor. Fan the quality scaler into both children; refuse two GPGPU children
at full quality on mobile (auto-halve).

## 5. Knob mapping — DECIDED 2026-07-18, trial SHIPPED

User decision: a **view toggle** — the 8 slots address one of
**A | B | Fader-follows (mix < 0.5 → A, else B) | Both** (slot i drives A's
AND B's i-th param off one hardware edge). Global toggle for now;
**per-knob view assignment is explicitly deferred** to later.

Trial implementation (on the existing blend-* composites):
- View state = the recorded `macro.view` input signal (0/1/2/3) — rides the
  ordinary setInputSignal record/replay path, so mid-take flips replay
  byte-identically (e2e: tests/e2e/macroView.spec.ts).
- `Engine.macroParamSets()` resolves the view by filtering the composite's
  `a.` / `b.` param prefixes — no composite/scene API changes. Ordinary
  scenes are untouched (`[scene.params]`).
- `MacroRouter.route` takes param SETS; the per-slot edge is consumed once
  across sets, so "both" can't double-fire and a view flip never yanks the
  newly addressed deck — its params wait for the knob's next movement
  (pickup). This also makes fader-follows unambiguous mid-fade for free.
- `mix`/`mode` are NOT slot-addressable in any view (UI sliders +
  expressions only). Revisit if the user wants mix pinned to a hardware
  control.
- UI: segmented "Knobs A|B|Fader|Both" row above the knob list, deck scenes
  only; per-row slot chips follow the active view via `engine.macroSlotOf`.
- `startRecording` baselines the held `macro.view` value into the take as a
  frame-0 inputSignal event (review finding: a take armed with view B/Fader/
  Both selected otherwise replayed with the bus default, view A, re-routing
  every ctl edge to the wrong deck). Held `ctl.N` values are deliberately
  NOT baselined — see the code comment in `startRecording`.
- KNOWN GAP (deferred, review finding 2): Frames F1-F8 remain raw-positional
  on deck scenes ([mix, mode, a.*…]) and do NOT follow the knob-view toggle,
  so on views B/Fader/Both the frames and the slot chips address different
  params. Align frames to the active view if the trial sticks.

## 6. If/when approved, the incremental path

1. Cross-feed tap + `setUpstreamTexture` on photoswarm/kaleido/flowfield
   (golden-test one contractive pair, kaleido as B).
2. Punch + crossfader-as-performance-control.
3. Live deck rebind (`setChild` event).
Defer: engine-level decks, crossfade-into-ingest window, per-deck macro
banks, N>2 decks.
