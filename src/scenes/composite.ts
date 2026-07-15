import type { Gpu } from '../gpu/context'
import { FloatTarget, FullscreenPass, type RenderSurface } from '../gpu/targets'
import type { FrameContext, ParamSchema, SceneMeta, SceneRuntime, ShaderStage } from './types'

/**
 * The scene combiner (ARCHITECTURE.md's "combining algorithms" milestone): a
 * `CompositeScene` renders two child `SceneRuntime`s into their own offscreen
 * targets and blends the results with a small fullscreen shader. This is what
 * lets, say, a Julia-set domain warp and a GPGPU flow field share one frame.
 *
 * Children are ordinary `SceneRuntime`s — they have no idea they're being
 * composited. Each one gets its own `RenderSurface` (a `FloatTarget` sized to
 * match the *actual* output surface, not a fixed internal resolution) so their
 * own aspect-fit/point-size/etc. math, which reads `surface.width/height`,
 * keeps working unmodified.
 */

/** A named factory for a child scene: `id`/`label` describe it for the UI and
 * shader/param prefixing; `create()` builds a fresh, uninitialized runtime. */
export interface CompositeChild {
  id: string
  label: string
  create(): SceneRuntime
}

// Derived per-child seeds (ARCHITECTURE.md §1: no shared PRNG state between
// children — each XOR constant is an arbitrary odd 32-bit mixing constant,
// same "golden ratio" / murmur-style constants used elsewhere in this codebase
// for hash mixing, chosen only so A and B never see the same seed and thus
// never produce identical swarms/layouts when seeded from the same session).
const CHILD_A_SEED_XOR = 0x9e3779b9
const CHILD_B_SEED_XOR = 0x85ebca6b

const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`

// Blend pass: samples both children's targets (already rendered at the output
// surface's own size) and combines per `uMode`. Modes documented inline —
// each takes the RGB-only color (children's own alpha is internal
// accumulation state, e.g. flowfield's trail fade, and must not leak into the
// composited output).
const BLEND_FS = `#version 300 es
precision highp float;
uniform sampler2D uTexA, uTexB;
uniform vec2 uResolution;
uniform float uMix;
uniform int uMode;
out vec4 outColor;
void main(){
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec3 a = texture(uTexA, uv).rgb;
  vec3 b = texture(uTexB, uv).rgb;
  vec3 col;
  if (uMode == 0) {
    // 0: crossfade — linear interpolation from A to B.
    col = mix(a, b, uMix);
  } else if (uMode == 1) {
    // 1: add — A plus B scaled by uMix (can overexpose to white; that's the look).
    col = a + b * uMix;
  } else if (uMode == 2) {
    // 2: multiply — A darkened by B (product), dialed in over uMix.
    col = mix(a, a * b, uMix);
  } else {
    // 3: screen — the photographic "light" blend (inverse of multiplying
    // inverses), dialed in over uMix.
    col = mix(a, 1.0 - (1.0 - a) * (1.0 - b), uMix);
  }
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`

const OWN_PARAMS: ParamSchema[] = [
  { name: 'mix', label: 'Mix', min: 0, max: 1, default: 0.5 },
  { name: 'mode', label: 'Blend mode', min: 0, max: 3, default: 0, step: 1 },
]

interface BlendLocs {
  uTexA: WebGLUniformLocation | null
  uTexB: WebGLUniformLocation | null
  uResolution: WebGLUniformLocation | null
  uMix: WebGLUniformLocation | null
  uMode: WebGLUniformLocation | null
}

export class CompositeScene implements SceneRuntime {
  meta: SceneMeta

  // Built in init(), after both children have their own (post-init) params —
  // empty until then. Nothing reads `.params` before init(): Engine's
  // constructor calls scene.init() immediately after construction, and every
  // other reader (App.tsx, loadSession) goes through `engine.scene.params`.
  params: ParamSchema[] = OWN_PARAMS

  private readonly childA: SceneRuntime
  private readonly childB: SceneRuntime

  private values = new Map<string, number>()
  private gpu!: Gpu
  private fsPass!: FullscreenPass
  private blendProgram!: WebGLProgram
  private blendLoc!: BlendLocs
  private blendSource = BLEND_FS

  // Lazy, size-matched, persistent-across-frames targets (see render()):
  // recreated only when the surface's dimensions change, so children's own
  // trail/feedback accumulation survives frame to frame like it would on the
  // canvas directly.
  private targetA: FloatTarget | null = null
  private targetB: FloatTarget | null = null
  private targetW = 0
  private targetH = 0

  constructor(meta: SceneMeta, childA: CompositeChild, childB: CompositeChild) {
    this.meta = meta
    this.childA = childA.create()
    this.childB = childB.create()
  }

  init(gpu: Gpu, seed: number): void {
    this.gpu = gpu
    this.childA.init(gpu, (seed ^ CHILD_A_SEED_XOR) >>> 0)
    this.childB.init(gpu, (seed ^ CHILD_B_SEED_XOR) >>> 0)

    for (const p of OWN_PARAMS) this.values.set(p.name, p.default)
    this.params = [
      ...OWN_PARAMS,
      ...this.childA.params.map((p) => ({ ...p, name: `a.${p.name}`, label: `A: ${p.label}` })),
      ...this.childB.params.map((p) => ({ ...p, name: `b.${p.name}`, label: `B: ${p.label}` })),
    ]

    this.blendSource = BLEND_FS
    this.fsPass = new FullscreenPass(gpu)
    this.blendProgram = gpu.compileProgram(FULLSCREEN_VS, this.blendSource)
    this.blendLoc = this.lookupBlendLocs(this.blendProgram)

    // Targets are dropped on dispose() and rebuilt lazily on the first
    // render() at whatever size the surface turns out to be.
    this.targetA = null
    this.targetB = null
    this.targetW = 0
    this.targetH = 0
  }

  /**
   * Routing (documented since it's the whole point of the prefix scheme):
   * - `mix` / `mode` are this scene's own params.
   * - `a.<name>` / `b.<name>` strip the prefix and forward to that child.
   * - Any other, unprefixed name that isn't one of the two own params above
   *   forwards to BOTH children unprefixed. This is what lets a generic
   *   caller (the test harness's `?count=`, a future "apply to all" UI
   *   action) reach a param a specific child happens to expose without
   *   knowing which side it lives on; each child's own `setParam` already
   *   tolerates unknown names (see e.g. julia.ts's plain `values.set`), so
   *   forwarding to a child that doesn't have that param is harmless.
   */
  setParam(name: string, value: number): void {
    if (name === 'mix' || name === 'mode') {
      this.values.set(name, value)
      return
    }
    if (name.startsWith('a.')) {
      this.childA.setParam(name.slice(2), value)
      return
    }
    if (name.startsWith('b.')) {
      this.childB.setParam(name.slice(2), value)
      return
    }
    this.childA.setParam(name, value)
    this.childB.setParam(name, value)
  }

  /** Mirrors setParam's routing; an unprefixed, non-own name reads childA's
   * value (arbitrary but deterministic — getParam has no "both" to return). */
  getParam(name: string): number {
    if (name === 'mix' || name === 'mode') return this.values.get(name) ?? 0
    if (name.startsWith('a.')) return this.childA.getParam(name.slice(2))
    if (name.startsWith('b.')) return this.childB.getParam(name.slice(2))
    return this.childA.getParam(name)
  }

  update(ctx: FrameContext): void {
    this.childA.update(ctx)
    this.childB.update(ctx)
  }

  render(ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    const w = surface.width
    const h = surface.height

    if (!this.targetA || !this.targetB || this.targetW !== w || this.targetH !== h) {
      this.targetA?.dispose()
      this.targetB?.dispose()
      const a = new FloatTarget(this.gpu, { width: w, height: h }, undefined, 'rgba8')
      const b = new FloatTarget(this.gpu, { width: w, height: h }, undefined, 'rgba8')
      // texStorage2D leaves rgba8 storage uninitialized — clear both so
      // children start compositing from a deterministic black frame, same as
      // a freshly-cleared canvas (mirrors kaleido.ts's own target init).
      for (const t of [a, b]) {
        t.bindTarget()
        gl.clearColor(0, 0, 0, 1)
        gl.clear(gl.COLOR_BUFFER_BIT)
      }
      this.targetA = a
      this.targetB = b
      this.targetW = w
      this.targetH = h
    }

    this.childA.render(ctx, this.targetA)
    this.childB.render(ctx, this.targetB)

    surface.bind()
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)

    gl.useProgram(this.blendProgram)
    this.targetA.bindTexture(0)
    gl.uniform1i(this.blendLoc.uTexA, 0)
    this.targetB.bindTexture(1)
    gl.uniform1i(this.blendLoc.uTexB, 1)
    gl.uniform2f(this.blendLoc.uResolution, w, h)
    gl.uniform1f(this.blendLoc.uMix, this.blendMix())
    gl.uniform1i(this.blendLoc.uMode, this.blendMode())
    this.fsPass.draw()
  }

  /** Own resize just forwards to gpu, like every other scene — children are
   * NOT resized here; they derive width/height from whatever RenderSurface
   * they're handed each render() call (their own offscreen target, sized to
   * match this scene's surface), not from a persistent size of their own. */
  resize(width: number, height: number): void {
    this.gpu.resize(width, height)
    this.gpu.gl.clearColor(0, 0, 0, 1)
    this.gpu.gl.clear(this.gpu.gl.COLOR_BUFFER_BIT)
  }

  dispose(): void {
    const gl = this.gpu.gl
    this.childA.dispose()
    this.childB.dispose()
    this.targetA?.dispose()
    this.targetB?.dispose()
    this.targetA = null
    this.targetB = null
    this.targetW = 0
    this.targetH = 0
    gl.deleteProgram(this.blendProgram)
    this.fsPass.dispose()
  }

  getShaderSources(): ShaderStage[] {
    const own: ShaderStage[] = [{ key: 'blend-fs', label: 'Blend (blend-fs)', source: this.blendSource }]
    const a = (this.childA.getShaderSources?.() ?? []).map((s) => ({
      key: `a.${s.key}`,
      label: `A: ${s.label}`,
      source: s.source,
    }))
    const b = (this.childB.getShaderSources?.() ?? []).map((s) => ({
      key: `b.${s.key}`,
      label: `B: ${s.label}`,
      source: s.source,
    }))
    return [...own, ...a, ...b]
  }

  /**
   * Routes by prefix, mirroring setParam: `blend-fs` recompiles the blend
   * program (refreshing cached uniform locations on success; on GLSL error
   * `gpu.compileProgram` throws and the previous program is left untouched).
   * `a.<key>` / `b.<key>` strip the prefix and forward to that child's own
   * `setShaderSource` (throwing if that child has no code layer). Anything
   * else throws — unknown key.
   */
  setShaderSource(key: string, source: string): void {
    if (key === 'blend-fs') {
      const gl = this.gpu.gl
      const program = this.gpu.compileProgram(FULLSCREEN_VS, source) // throws on GLSL error; old program untouched
      gl.deleteProgram(this.blendProgram)
      this.blendProgram = program
      this.blendLoc = this.lookupBlendLocs(program)
      this.blendSource = source
      return
    }
    if (key.startsWith('a.')) {
      if (!this.childA.setShaderSource) {
        throw new Error(`Child A ("${this.childA.meta.id}") has no code layer for shader stage "${key}"`)
      }
      this.childA.setShaderSource(key.slice(2), source)
      return
    }
    if (key.startsWith('b.')) {
      if (!this.childB.setShaderSource) {
        throw new Error(`Child B ("${this.childB.meta.id}") has no code layer for shader stage "${key}"`)
      }
      this.childB.setShaderSource(key.slice(2), source)
      return
    }
    throw new Error(`Unknown shader stage "${key}" for scene "${this.meta.id}"`)
  }

  private blendMix(): number {
    const v = this.values.get('mix') ?? OWN_PARAMS[0].default
    return Math.min(1, Math.max(0, v))
  }

  private blendMode(): number {
    const v = Math.round(this.values.get('mode') ?? OWN_PARAMS[1].default)
    return Math.min(3, Math.max(0, v))
  }

  private lookupBlendLocs(program: WebGLProgram): BlendLocs {
    const gl = this.gpu.gl
    return {
      uTexA: gl.getUniformLocation(program, 'uTexA'),
      uTexB: gl.getUniformLocation(program, 'uTexB'),
      uResolution: gl.getUniformLocation(program, 'uResolution'),
      uMix: gl.getUniformLocation(program, 'uMix'),
      uMode: gl.getUniformLocation(program, 'uMode'),
    }
  }
}
