# Sessions (rig files) vs Performances (takes) — architecture plan

Status: PLAN, written 2026-07-19 at the user's request. No implementation
yet; §7 lists the decisions awaiting the user. Companion to
ARCHITECTURE.md §3.5 (session recorder — which this plan RENAMES in
concept to "performance/take" to free the word "session").

## 1. The two things, named

The user's framing, confirmed against the code:

- A **Performance** (existing `SessionDoc`, the take card's Save button):
  an immutable RECORDING — initial state + a timestamped event log +
  audio reference. Replayable frame-perfectly. Already shipped.
- A **Session** (new): the user's LIVING RIG — "how I left each
  algorithm": knob values, expressions, shader edits, per-scene, plus the
  global performance furniture (frames F1-F8, transition/handoff dials).
  Mutable, sparse (only touched algorithms), exportable/reloadable JSON.

Today NOTHING survives a scene switch: params reset to schema defaults
(fresh scene instance), expressions are wiped (`engine.switchScene` →
`bindings.clear()`), shader edits are lost. The Session concept is what
fixes that, and the file format falls out of the runtime fix.

## 2. Same file or two files? — DECIDED RECOMMENDATION: two files, shared shapes

The tempting unification ("a performance is a session with more data") is
structurally almost true — `SessionDoc.scene {params, shaders, image}` +
`bindings` IS a per-scene override block. But the two objects have
opposite lifecycles, and coupling them is the long-term architectural
trap:

| | Session (rig) | Performance (take) |
|---|---|---|
| Mutability | living document, constantly updated | immutable once recorded |
| Scope | MANY scenes, sparse | ONE starting scene + events |
| Audio | none | embedded feature timeline |
| Determinism duty | none (it's setup) | frame-perfect replay contract |
| Size | ~KB | ~100KB-MB (timeline, events) |

If one format held both, loading a take would either overwrite your rig
(destructive surprise) or need merge rules (complexity forever), and every
future rig feature would have to prove it doesn't break take replay.

**Instead: two file kinds sharing one TypeScript shape.** Extract
`SceneOverride { params?, bindings?, shaders? }` as a shared type; the
take doc's initial-state block and the session file's per-scene entries
both use it (one serializer, one validator). Bridge feature (cheap,
later): "Extract rig from performance" — harvest a take's initial state
into the current session.

File discrimination: a required top-level `kind: 'session' | 'performance'`
plus the existing `version`. The load UI routes on `kind`, so a user can
throw either file at one "Load" affordance and the right thing happens
(risk R5).

## 3. Session file format (v1)

```jsonc
{
  "kind": "session",
  "version": 1,
  "name": "friday set",                  // optional, user-editable
  "scenes": {                            // SPARSE: only algorithms the user touched
    "photoswarm": {
      "params": { "return": 0.7 },      // SPARSE ABSOLUTE: only keys that differ
      "bindings": { "turbulence": "0 + bass * 0.6" },
      "shaders": { "render-fs": "..." } // only stages that differ from stock
    },
    "glyphrain": { "params": { "hue": 0.6 } }
  },
  "global": {
    "frames": [[0.1, 0.5, ...], null, ...],  // F1-F8 normalized snapshots
    "transitionSpeed": 1.0,
    "handoffFadeSeconds": 2.0,
    "macroView": 0,
    "switchTargetId": "kaleido"
  }
}
```

- **Sparse absolute, not diffs-as-deltas**: store only CHANGED keys, but
  store their absolute values. Untouched keys inherit whatever the
  app's current defaults are — so when we retune a scene's defaults in an
  update, the user gets the improvement everywhere they didn't express an
  opinion, and keeps their exact setting everywhere they did (risk R3).
- **Image**: NOT in v1 session files. The photo is media, potentially
  hundreds of KB base64; it already lives in take docs where determinism
  requires it. Session-side the app keeps its existing runtime reapply
  behavior; embedding is a v2 option behind a size warning (risk R6).
- **MIDI mapping**: stays in localStorage (device/machine-scoped, already
  persisted separately). Optionally an informational `midi` block later —
  applied only when device ids match. Not v1 (risk R7).

## 4. Runtime architecture — where per-scene memory lives

**DECIDED RECOMMENDATION: App-level `SceneMemory`, applied through the
engine's existing recorded seams. The engine stays ignorant.**

- **Capture** on scene EXIT (both switch paths funnel through App:
  `onSceneChange` and `onSwitchScene`) and on a debounce while playing
  with the current scene (so export mid-scene is current): read
  `scene.params` values (diffed vs schema defaults), `engine.getBinding`
  per param, `getShaderSources` diffed vs stock.
- **Apply** on scene ENTER, immediately after the switch, via
  `engine.setParam` / `setBinding` / `setShaderSource` — the
  RECORDING-AWARE methods. This is the crucial trick: if a take is
  running, the restoration is captured as ordinary recorded events right
  after the switch event, so **replay/export reproduce the restored rig
  with zero take-schema changes and zero new determinism surface**
  (risk R1). A failed expression compile or shader compile on restore is
  skipped with a surfaced note, never a crash (same contract as
  loadSession's).

The rejected alternative — engine-owned memory applied inside
`switchScene` — would force the memory map into the take doc (replayed
switches would need it), growing the performance schema and coupling the
two lifecycles exactly as §2 warns.

## 5. Lifecycle semantics

- App cold start: **empty session, pure defaults** (user's stated spec).
- "New session" button: clears SceneMemory + globals to defaults.
- Export: serialize current SceneMemory + globals (capturing the live
  scene first). Import: replace the current session wholesale (prompt if
  the current one has unexported changes), then apply the current scene's
  override immediately.
- Unknown scene ids on import (renamed/removed algorithms — Hyperbolic
  precedent) are dropped with a visible note, never an error (risk R2).
- Working-session persistence across reloads: OPEN QUESTION §7.1 — the
  spec says fresh load = defaults, but the MIDI-mapping episode showed
  reload-loss hurts; proposal is a "Restore previous session?" banner
  rather than silent auto-restore.

## 6. Risk assessment

- **R1 — determinism** (was the big one): applying restores through
  recorded seams makes rig restoration replay-native. Residual risk: a
  restore burst adds N events at the switch frame (tens, not thousands);
  negligible. LOW.
- **R2 — schema drift** (scenes/params renamed across app versions):
  sparse-absolute keys + tolerant parser (skip unknown ids/params/stages,
  report) means old files degrade gracefully, never brick. LOW after
  mitigation; MEDIUM if we ever store positional (index-keyed) data —
  so: always key by name, never by position (frames are the exception,
  positional BY DESIGN — they're already positional at runtime).
- **R3 — defaults evolution**: sparse-absolute (§3) is the mitigation;
  full-snapshot files would freeze old defaults forever. Decided.
- **R4 — unified file format**: rejected (§2); revisit only if a concrete
  feature needs a take to carry a full rig, and then embed a session
  BLOCK inside the performance file rather than merging identities.
- **R5 — user confusion between the two files**: `kind` discriminator +
  one Load affordance that routes + distinct default filenames
  (`*.session.json` / `*.take.json`). LOW.
- **R6 — file bloat** (image/shaders): shaders are KBs (fine); image
  excluded v1. LOW.
- **R7 — machine-scoped state in a portable file** (MIDI): excluded v1.
  LOW.
- **R8 — mid-take rig mutation**: capturing memory DURING a take is fine
  (capture is passive); a session IMPORT mid-take must be blocked (one
  guard in the import handler), like image loads already are. LOW.

## 7. Decisions (user, 2026-07-19)

1. **Reload behavior — restore banner via localStorage.** The user asked
   how a banner works for a static web app: the browser's per-site
   localStorage (already used for MIDI mappings) persists on the user's
   device with no server. The working session auto-saves there
   (debounced); next load in the same browser shows "Restore previous
   session?" — dismiss = pure defaults. Other devices/browsers start
   clean; the export file is the portability mechanism.
2. **Frames are PER-ALGORITHM.** F1-F8 banks are keyed by scene id and
   live inside each scene's rig entry (`frames?` on the session-side
   entry, not the shared SceneOverride — take docs don't carry frames).
   Switching algorithms swaps the visible bank; an untouched algorithm
   has an empty bank. This supersedes the global-positional behavior
   frames shipped with.
3. **Take card offers all three saves**: session only, performance only,
   or both (two file downloads).

## 8. Build order (when approved)

1. `SceneMemory` runtime (capture/apply on switch) — the immediate UX win,
   no file format yet. Includes e2e: switch away/back preserves knobs +
   expressions + shader edit; mid-take restore replays byte-identically.
2. Shared `SceneOverride` type extraction (take doc refactor, no format
   change on disk).
3. Session file export/import + New Session + tolerant parser + tests.
4. Bridge: "Extract rig from performance". Deferred: image embedding,
   MIDI block, per-scene frames if chosen in §7.2.
