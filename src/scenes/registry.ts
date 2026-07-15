import { LissajousScene } from './builtin/lissajous'
import { FlowFieldScene } from './builtin/flowfield'
import { LorenzScene } from './builtin/lorenz'
import { JuliaScene } from './builtin/julia'
import { KaleidoScene } from './builtin/kaleido'
import type { SceneRuntime } from './types'

/**
 * The scene registry: every scene id a session/URL/UI can reference, and how to
 * construct a fresh runtime instance for it. `Engine.loadSession` refuses to
 * apply a doc whose `scene.id` doesn't match the already-constructed scene
 * (there is no `SceneRuntime.reset()` hook — see docs/PARTICLES.md §0) — callers
 * (App.tsx, export/render.ts, the test harness) look up this registry first to
 * build the right scene *before* constructing the Engine.
 */
export const SCENES: Record<string, { name: string; create(): SceneRuntime }> = {
  lissajous: { name: 'Lissajous', create: () => new LissajousScene() },
  flowfield: { name: 'Flow Field', create: () => new FlowFieldScene() },
  lorenz: { name: 'Lorenz Attractor', create: () => new LorenzScene() },
  julia: { name: 'Julia Warp', create: () => new JuliaScene() },
  kaleido: { name: 'Kaleidoscope', create: () => new KaleidoScene() },
}
