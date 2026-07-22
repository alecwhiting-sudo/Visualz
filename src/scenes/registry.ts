import { LissajousScene } from './builtin/lissajous'
import { FlowFieldScene } from './builtin/flowfield'
import { JuliaScene } from './builtin/julia'
import { MandelDiveScene } from './builtin/mandeldive'
import { KaleidoScene } from './builtin/kaleido'
import { GrayScottScene } from './builtin/grayscott'
import { MorphogenScene } from './builtin/morphogen'
import { TunnelScene } from './builtin/tunnel'
import { FractalLabScene } from './builtin/fractallab'
import { ResonanceScene } from './builtin/resonance'
import { PhotoSwarmScene } from './builtin/photoswarm'
import { GlyphLatticeScene } from './builtin/glyphlattice'
import { WaveChamberScene } from './builtin/waves'
import { GlyphGeometryScene } from './builtin/glyphgeometry'
import { GlyphRainScene } from './builtin/glyphrain'
import { PhysarumScene } from './builtin/physarum'
import { OrbitDiveScene } from './builtin/orbitdive'
import { WhipLineScene } from './builtin/whipline'
import { GuillocheScene } from './builtin/guilloche'
import { TerrainFlightScene, TerrainMirrorScene } from './builtin/terrain'
import { OrreryScene } from './builtin/orrery'
import { WhipStormScene } from './builtin/whipstorm'
import { CompositeScene, type CompositeChild } from './composite'
import type { SceneRuntime } from './types'

// Child factories for the composite combos below — shared descriptors (safe to
// reuse across multiple CompositeScenes: `create()` builds a fresh instance
// per composite, so e.g. flowfieldChild backs two unrelated combos below
// without the two combos' flow fields sharing any state).
const juliaChild: CompositeChild = { id: 'julia', label: 'Julia Warp', create: () => new JuliaScene() }
const flowfieldChild: CompositeChild = { id: 'flowfield', label: 'Flow Field', create: () => new FlowFieldScene() }
const grayscottChild: CompositeChild = { id: 'grayscott', label: 'Reaction-Diffusion', create: () => new GrayScottScene() }
const mandelDiveChild: CompositeChild = { id: 'mandeldive', label: 'Mandel Dive', create: () => new MandelDiveScene() }
const kaleidoChild: CompositeChild = { id: 'kaleido', label: 'Kaleidoscope', create: () => new KaleidoScene() }
const tunnelChild: CompositeChild = { id: 'tunnel', label: 'Audio Tunnel', create: () => new TunnelScene() }
const morphChild: CompositeChild = { id: 'morph', label: 'Morphogen', create: () => new MorphogenScene() }
const terrainMirrorChild: CompositeChild = { id: 'terrainmirror', label: 'Terrain Mirror', create: () => new TerrainMirrorScene() }

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
  julia: { name: 'Julia Warp', create: () => new JuliaScene() },
  mandeldive: { name: 'Mandel Dive', create: () => new MandelDiveScene() },
  kaleido: { name: 'Kaleidoscope', create: () => new KaleidoScene() },
  grayscott: { name: 'Reaction-Diffusion', create: () => new GrayScottScene() },
  morph: { name: 'Morphogen', create: () => new MorphogenScene() },
  tunnel: { name: 'Audio Tunnel', create: () => new TunnelScene() },
  fractallab: { name: 'Fractal Lab', create: () => new FractalLabScene() },
  resonance: { name: 'Resonance', create: () => new ResonanceScene() },
  photoswarm: { name: 'Photo Swarm', create: () => new PhotoSwarmScene() },
  glyphlattice: { name: 'Glyph Lattice', create: () => new GlyphLatticeScene() },
  waves: { name: 'Wave Chamber', create: () => new WaveChamberScene() },
  glyphgeometry: { name: 'Glyph Geometry', create: () => new GlyphGeometryScene() },
  glyphrain: { name: 'Glyph Rain', create: () => new GlyphRainScene() },
  physarum: { name: 'Physarum', create: () => new PhysarumScene() },
  orbitdive: { name: 'Orbit Dive', create: () => new OrbitDiveScene() },
  whipline: { name: 'Whip Line', create: () => new WhipLineScene() },
  guilloche: { name: 'Guilloché', create: () => new GuillocheScene() },
  terrain: { name: 'Terrain Flight', create: () => new TerrainFlightScene() },
  terrainmirror: { name: 'Terrain Mirror', create: () => new TerrainMirrorScene() },
  orrery: { name: 'Orrery', create: () => new OrreryScene() },
  whipstorm: { name: 'Whip Storm', create: () => new WhipStormScene() },
  'blend-julia-flow': {
    name: 'Julia × Flow field',
    create: () =>
      new CompositeScene(
        { id: 'blend-julia-flow', name: 'Julia × Flow field', family: 'geometry' },
        juliaChild,
        flowfieldChild,
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
  'blend-mandel-kaleido': {
    name: 'Mandel × Kaleido',
    create: () =>
      new CompositeScene(
        { id: 'blend-mandel-kaleido', name: 'Mandel × Kaleido', family: 'geometry' },
        mandelDiveChild,
        kaleidoChild,
      ),
  },
  'blend-tunnel-morph': {
    name: 'Tunnel × Morphogen',
    create: () =>
      new CompositeScene(
        { id: 'blend-tunnel-morph', name: 'Tunnel × Morphogen', family: 'geometry' },
        tunnelChild,
        morphChild,
      ),
  },
  'blend-tunnel-kaleido': {
    name: 'Tunnel × Kaleido',
    create: () =>
      new CompositeScene(
        { id: 'blend-tunnel-kaleido', name: 'Tunnel × Kaleido', family: 'geometry' },
        tunnelChild,
        kaleidoChild,
      ),
  },
  'blend-tunnel-terrainmirror': {
    name: 'Tunnel × Terrain Mirror',
    create: () =>
      new CompositeScene(
        { id: 'blend-tunnel-terrainmirror', name: 'Tunnel × Terrain Mirror', family: 'geometry' },
        tunnelChild,
        terrainMirrorChild,
      ),
  },
}
