import { LissajousScene } from './builtin/lissajous'
import { FlowFieldScene } from './builtin/flowfield'
import { LorenzScene } from './builtin/lorenz'
import { JuliaScene } from './builtin/julia'
import { KaleidoScene } from './builtin/kaleido'
import { GrayScottScene } from './builtin/grayscott'
import { CompositeScene, type CompositeChild } from './composite'
import type { SceneRuntime } from './types'

// Child factories for the composite combos below — shared descriptors (safe to
// reuse across multiple CompositeScenes: `create()` builds a fresh instance
// per composite, so e.g. flowfieldChild backs two unrelated combos below
// without the two combos' flow fields sharing any state).
const juliaChild: CompositeChild = { id: 'julia', label: 'Julia Warp', create: () => new JuliaScene() }
const flowfieldChild: CompositeChild = { id: 'flowfield', label: 'Flow Field', create: () => new FlowFieldScene() }
const kaleidoChild: CompositeChild = { id: 'kaleido', label: 'Kaleidoscope', create: () => new KaleidoScene() }
const lorenzChild: CompositeChild = { id: 'lorenz', label: 'Lorenz Attractor', create: () => new LorenzScene() }
const grayscottChild: CompositeChild = { id: 'grayscott', label: 'Reaction-Diffusion', create: () => new GrayScottScene() }

/**
 * The scene registry: every scene id a session/URL/UI can reference, and how to
 * construct a fresh runtime instance for it. `Engine.loadSession` refuses to
 * apply a doc whose `scene.id` doesn't match the already-constructed scene
 * (there is no `SceneRuntime.reset()` hook — see docs/PARTICLES.md §0) — callers
 * (App.tsx, export/render.ts, the test harness) look up this registry first to
 * build the right scene *before* constructing the Engine.
 *
 * The `blend-*` entries are `CompositeScene`s (src/scenes/composite.ts) —
 * curated pairings of two standalone scenes above, blended via a shared
 * mix/mode control. Each `create()` builds fresh child instances, so a
 * composite never shares GPU/CPU state with its standalone counterpart.
 */
export const SCENES: Record<string, { name: string; create(): SceneRuntime }> = {
  lissajous: { name: 'Lissajous', create: () => new LissajousScene() },
  flowfield: { name: 'Flow Field', create: () => new FlowFieldScene() },
  lorenz: { name: 'Lorenz Attractor', create: () => new LorenzScene() },
  julia: { name: 'Julia Warp', create: () => new JuliaScene() },
  kaleido: { name: 'Kaleidoscope', create: () => new KaleidoScene() },
  grayscott: { name: 'Reaction-Diffusion', create: () => new GrayScottScene() },
  'blend-julia-flow': {
    name: 'Julia × Flow field',
    create: () =>
      new CompositeScene(
        { id: 'blend-julia-flow', name: 'Julia × Flow field', family: 'geometry' },
        juliaChild,
        flowfieldChild,
      ),
  },
  'blend-kaleido-lorenz': {
    name: 'Kaleido × Lorenz',
    create: () =>
      new CompositeScene(
        { id: 'blend-kaleido-lorenz', name: 'Kaleido × Lorenz', family: 'geometry' },
        kaleidoChild,
        lorenzChild,
      ),
  },
  'blend-rd-flow': {
    name: 'Reaction × Flow field',
    create: () =>
      new CompositeScene(
        { id: 'blend-rd-flow', name: 'Reaction × Flow field', family: 'simulation' },
        grayscottChild,
        flowfieldChild,
      ),
  },
}
