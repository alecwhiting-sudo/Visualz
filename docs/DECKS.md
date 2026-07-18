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

## 5. OPEN UX FORK — what the 8 knobs mean with two live scenes

Unresolved; the user explicitly wants more time on this. Options:
- (a) Positional split: 1-3 → A, 4-6 → B, 7 → crossfader, 8 spare.
  Predictable, ships fastest, 3 knobs per scene.
- (b) Focus toggle: all 8 → the focused deck; crossfader on its own control.
  Full reach, one extra concept mid-performance.
- (c) Crossfader-follows: knobs drive the deck the fader favors; ambiguous
  mid-fade.
- (d) Today's composite behavior: slot 1=mix, 2=mode, 3+ = A's then B's
  params — works now but burns the front slots.

## 6. If/when approved, the incremental path

1. Cross-feed tap + `setUpstreamTexture` on photoswarm/kaleido/flowfield
   (golden-test one contractive pair, kaleido as B).
2. Punch + crossfader-as-performance-control.
3. Live deck rebind (`setChild` event).
Defer: engine-level decks, crossfade-into-ingest window, per-deck macro
banks, N>2 decks.
