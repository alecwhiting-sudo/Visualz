# Visualz — working rules for Claude

Realtime maths-driven music visualizer. Read @REQUIREMENTS.md (what/why) and
@ARCHITECTURE.md (how) before designing anything new.

## Commands
- `npm run dev` — app at http://localhost:5173
- `npm run typecheck && npm test` — must pass before every commit
- `npm run test:e2e` — Playwright golden-image tests (deterministic render mode)
- `npx playwright test --update-snapshots` — ONLY when a visual change is intentional;
  say so in the commit message

## Hard rules (breaking these breaks deterministic export)
- NEVER use `Date.now()`, `performance.now()`, or `Math.random()` in `src/` outside
  `src/app/`. Time comes from `Transport`, randomness from the scene's seeded PRNG
  (`src/core/prng.ts`).
- All inputs (audio, MIDI, keys, touch) publish to the `SignalBus`; scenes read signals,
  never devices.
- Scenes implement `SceneRuntime` (`src/scenes/types.ts`) and must render correctly at
  16:9, 9:16, and 1:1.
- New scenes need a golden-image test in `tests/e2e/` (seeded, fixed frame).
- `@playwright/test` stays pinned at 1.56.x — goldens are tied to Chromium build 1194.
  Bumping it means regenerating every golden.

## Verification
Every engine/scene change is verified by running the checks above, not by reading code.
A change without a runnable check is not done. Golden tests run twice locally if
determinism is in doubt — the second run must match byte-for-byte.

## Delegation hierarchy
The main session (Opus 4.8) is the architect: it owns interface design, cross-module
changes, ARCHITECTURE.md/REQUIREMENTS.md edits, and final review before push.
Delegate the rest:

- **viz-builder** (Sonnet) — well-scoped implementation against an existing interface:
  a new scene, a module with a written spec, tests, mechanical refactors. Give it the
  exact files, the interface to implement, and the check to run.
- **viz-reasoner** (Opus 4.8) — hard problems: algorithm design (beat detection, DSL
  parsing, GPGPU techniques), gnarly debugging, numerical/maths correctness. Use when
  the answer matters more than the diff.
- **viz-reviewer** (Opus 4.8, read-only) — adversarial diff review before every
  non-trivial commit. It cannot edit; findings come back to the architect to route.
- Built-in **Explore** agent for codebase searches; don't burn main context on file dumps.

Route by uncertainty, not size: if the interface is settled and the spec fits in a
paragraph → builder. If the approach itself is unknown → reasoner. Architecture forks
always come back to the main session (and to the user when it changes REQUIREMENTS.md).
