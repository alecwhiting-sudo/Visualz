import { mulberry32 } from '../../core/prng'
import type { Gpu } from '../../gpu/context'
import { checkFloatRenderable, FloatTarget, FullscreenPass, PingPong, type RenderSurface } from '../../gpu/targets'
import { snapCountToSide, DEFAULT_COUNT, DEFAULT_SIDE } from '../families/particles/gpgpu'
import type { FrameContext, ParamSchema, SceneRuntime, SceneSnapshot, ShaderStage } from '../types'

/**
 * Particles family: "Photo Swarm" — an imported photo (or a procedural
 * fallback) is the raw material. Each particle's *home* is an importance-
 * sampled pixel of the image (home position + that pixel's color, baked into
 * two static RGBA textures at setImage()/init() time); the swarm's GPGPU
 * ping-pong state is the usual (px,py,vx,vy), same technique as flowfield.ts.
 * At rest a spring pulls every particle back to its home pixel, so the swarm
 * settles into the photo; bass-scaled curl-noise turbulence and onset-driven
 * radial shockwaves knock it apart.
 *
 * `setImage`/the built-in fallback image generator are duck-typed additions
 * on this class only (NOT part of `SceneRuntime` — most scenes have no
 * imported-media concept); `Engine.setSceneImage`/`sceneAcceptsImage` detect
 * them structurally (`src/engine/engine.ts`).
 */

export interface PhotoSwarmImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

// Attribute-less fullscreen triangle: identical to flowfield.ts's copy.
const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`

// hash32/lattice2/vnoise2/psi/curl copied verbatim from flowfield.ts's
// UPDATE_FS (docs/PARTICLES.md §5) so the turbulence noise stays bit-
// consistent with the rest of the particle family. No per-particle respawn
// hashing is needed here (unlike flowfield) — the spring keeps particles
// bounded near their home pixel, so `uFrame`/`uTexSize` aren't needed by this
// stage.
const UPDATE_FS = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform sampler2D uHome;
uniform float uDt, uTime, uReturn, uDamping, uTurbulence, uBass, uShock;
out vec4 outState;

uint hash32(uint x){ x=x+0x9e3779b9u; x^=x>>16u; x*=0x7feb352du; x^=x>>15u; x*=0x846ca68bu; x^=x>>16u; return x; }
float lattice2(int ix,int iy){ uint k = hash32(uint(ix)) ^ (uint(iy)*0x9e3779b9u); return float(hash32(k))/4294967296.0*2.0-1.0; }
float fade(float t){ return t*t*(3.0-2.0*t); }
float vnoise2(vec2 p){
  vec2 i=floor(p), f=p-i; vec2 u=vec2(fade(f.x),fade(f.y));
  int ix=int(i.x), iy=int(i.y);
  float a=lattice2(ix,iy), b=lattice2(ix+1,iy), c=lattice2(ix,iy+1), d=lattice2(ix+1,iy+1);
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}
float psi(vec2 p, float t){
  return vnoise2(p + vec2(t, -0.6*t))
       + 0.5*vnoise2(p*2.03 + vec2(-0.7*t+31.4, t+11.1));
}
vec2 curl(vec2 p, float t){
  const float e=0.01;
  float dx = psi(p+vec2(e,0.0),t) - psi(p-vec2(e,0.0),t);
  float dy = psi(p+vec2(0.0,e),t) - psi(p-vec2(0.0,e),t);
  return vec2(dy, -dx) / (2.0*e);
}
void main(){
  ivec2 tc = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uState, tc, 0);
  vec2 p = s.xy, v = s.zw;
  vec2 home = texelFetch(uHome, tc, 0).xy;

  // Spring toward home + curl-noise turbulence (bass-scaled) + a radial
  // shockwave impulse from the image center, all as accelerations; uDamping
  // is derived CPU-side from uReturn for a critically-damped-ish response
  // (see PhotoSwarmScene.update()).
  vec2 accel = (home - p) * uReturn;
  accel += curl(p * 1.6, uTime * 0.25) * uTurbulence * uBass;
  float r = length(p);
  vec2 dir = r > 1e-4 ? p / r : vec2(1.0, 0.0);
  accel += dir * uShock;

  v += accel * uDt;
  v *= exp(-uDamping * uDt);
  p += v * uDt;

  outState = vec4(p, v);
}`

const RENDER_VS = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform sampler2D uColor;
uniform int uTexSize;
uniform float uAspect, uPointSize, uResHeight;
out vec3 vColor;
void main(){
  int i = gl_VertexID;
  ivec2 tc = ivec2(i % uTexSize, i / uTexSize);
  vec4 s = texelFetch(uState, tc, 0);
  vColor = texelFetch(uColor, tc, 0).rgb;
  vec2 p = s.xy;
  p.x /= max(uAspect,1.0);
  p.y *= min(uAspect,1.0);
  gl_Position = vec4(p, 0.0, 1.0);
  gl_PointSize = uPointSize * max(uResHeight/360.0, 1.0);
}`

const RENDER_FS = `#version 300 es
precision highp float;
in vec3 vColor;
uniform float uFalloff;
out vec4 outColor;
void main(){
  vec2 d = gl_PointCoord*2.0-1.0;
  float r2 = dot(d,d);
  if(r2 > 1.0) discard;
  float alpha = exp(-r2*uFalloff);
  outColor = vec4(vColor*alpha, alpha);
}`

const FALLOFF = 4.0

// Spring/damping tuning: `uDamping` is derived from `uReturn` every frame as
// `2 * DAMPING_RATIO * sqrt(uReturn)` — the classic damped-harmonic-oscillator
// critical-damping formula (`2*sqrt(k)`) scaled by a ratio just under 1, so the
// swarm's "reform" has a small, visible settle-bounce instead of either
// perfectly stiff snapping (ratio 1) or sustained ringing (ratio << 1).
const DAMPING_RATIO = 0.9

// Onset shockwave envelope (CPU, same shape as flowfield's `pulse`): decays
// exponentially, jumps on each onset pulse, clamped to a sane ceiling.
const SHOCK_DECAY = 6.0
const SHOCK_GAIN = 1.4
const SHOCK_MAX = 2.0

// Built-in fallback "photo": small enough that CPU importance-sampling stays
// cheap even at the 512^2 particle-count ladder rung.
const FALLBACK_IMAGE_SIZE = 96
const FALLBACK_BLOB_COUNT = 5

// Home-position importance sampling (docs/PARTICLES.md-style seeded CPU
// sampling): weight = luminance + a uniform floor, so dark image regions
// still get a few particles instead of being completely empty.
const LUMINANCE_FLOOR = 0.12

/**
 * Procedural fallback image (used whenever no `setImage()` has been called,
 * or it was called with `null`): a layered radial hue/value gradient plus a
 * handful of seeded soft color blobs. Pure function of `seed` — no
 * `Math.random`, no checked-in asset, looks like a "photo" in goldens.
 */
export function generateFallbackImage(seed: number): PhotoSwarmImage {
  const size = FALLBACK_IMAGE_SIZE
  // XOR'd against a constant so this stream never coincides with the swarm's
  // own home/color sampling rng (also seeded from `seed`).
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0)
  const data = new Uint8ClampedArray(size * size * 4)

  const baseHue = rng()
  const hueSpan = 0.4 + rng() * 0.3

  const blobs: { x: number; y: number; r: number; hue: number; strength: number }[] = []
  for (let i = 0; i < FALLBACK_BLOB_COUNT; i++) {
    blobs.push({
      x: rng() * 1.6 - 0.8,
      y: rng() * 1.6 - 0.8,
      r: 0.18 + rng() * 0.28,
      hue: rng(),
      strength: 0.5 + rng() * 0.5,
    })
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = ((x + 0.5) / size) * 2 - 1
      const ny = ((y + 0.5) / size) * 2 - 1
      const r = Math.sqrt(nx * nx + ny * ny)
      const angle = Math.atan2(ny, nx)

      let hue = baseHue + (angle / (2 * Math.PI)) * hueSpan
      let value = Math.max(0, 1 - r * 0.85)

      for (const b of blobs) {
        const d = Math.hypot(nx - b.x, ny - b.y)
        const bump = Math.max(0, 1 - d / b.r)
        if (bump <= 0) continue
        const w = bump * bump * b.strength
        hue = hue * (1 - w * 0.6) + b.hue * (w * 0.6)
        value = Math.min(1, value + w * 0.6)
      }

      const [rr, gg, bb] = hsv2rgb(((hue % 1) + 1) % 1, 0.75, Math.min(1, value))
      const idx = (y * size + x) * 4
      data[idx] = rr
      data[idx + 1] = gg
      data[idx + 2] = bb
      data[idx + 3] = 255
    }
  }
  return { width: size, height: size, data }
}

function hsv2rgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)
  let r = 0
  let g = 0
  let b = 0
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break
    case 1: r = q; g = v; b = p; break
    case 2: r = p; g = v; b = t; break
    case 3: r = p; g = q; b = v; break
    case 4: r = t; g = p; b = v; break
    default: r = v; g = p; b = q; break
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]
}

interface SwarmData {
  /** side*side*4 floats: xy = home position in canonical (pre-screen-aspect) world space, zw = 0. */
  homes: Float32Array
  /** side*side*4 bytes: the sampled pixel's RGBA. */
  colors: Uint8Array
}

/** Binary search for the first cdf entry >= target (cdf is non-decreasing). */
function lowerBound(cdf: Float64Array, target: number): number {
  let lo = 0
  let hi = cdf.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (cdf[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Deterministic function of (image pixels, side, seed): luminance-weighted
 * (+ uniform floor) importance sampling picks a source pixel per particle;
 * each home is the pixel's center (± sub-pixel seeded jitter), min-axis-fit
 * into the canonical [-1,1] world square so the image's own aspect ratio is
 * preserved (not stretched) — `render()`'s vertex shader applies the
 * additional screen-aspect adjustment on top, same convention as flowfield.
 */
function deriveSwarmData(image: PhotoSwarmImage, side: number, seed: number): SwarmData {
  const { width, height, data } = image
  const n = width * height
  const cdf = new Float64Array(n)
  let acc = 0
  for (let i = 0; i < n; i++) {
    const idx = i * 4
    const lum = (0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2]) / 255
    acc += lum + LUMINANCE_FLOOR
    cdf[i] = acc
  }
  const total = acc

  const imgAspect = width / height
  const count = side * side
  const homes = new Float32Array(count * 4)
  const colors = new Uint8Array(count * 4)
  const rng = mulberry32(seed)

  for (let p = 0; p < count; p++) {
    const target = rng() * total
    // LUMINANCE_FLOOR keeps total > 0, so the uniform fallback never runs;
    // if the floor is ever removed, note it draws a DIFFERENT number of rng()
    // values than the taken branch, which would fork determinism per pixel.
    const pixelIndex = total > 0 ? lowerBound(cdf, target) : Math.floor(rng() * n)
    const px = pixelIndex % width
    const py = Math.floor(pixelIndex / width)

    const jx = rng() - 0.5
    const jy = rng() - 0.5
    const cx = ((px + 0.5 + jx) / width) * 2 - 1
    const cy = ((py + 0.5 + jy) / height) * 2 - 1

    let hx: number
    let hy: number
    if (imgAspect >= 1) {
      hx = cx
      hy = -cy / imgAspect
    } else {
      hx = cx * imgAspect
      hy = -cy
    }

    const o = p * 4
    homes[o] = hx
    homes[o + 1] = hy
    homes[o + 2] = 0
    homes[o + 3] = 0

    const srcIdx = pixelIndex * 4
    colors[o] = data[srcIdx]
    colors[o + 1] = data[srcIdx + 1]
    colors[o + 2] = data[srcIdx + 2]
    colors[o + 3] = data[srcIdx + 3]
  }

  return { homes, colors }
}

interface UpdateLocs {
  uState: WebGLUniformLocation | null
  uHome: WebGLUniformLocation | null
  uDt: WebGLUniformLocation | null
  uTime: WebGLUniformLocation | null
  uReturn: WebGLUniformLocation | null
  uDamping: WebGLUniformLocation | null
  uTurbulence: WebGLUniformLocation | null
  uBass: WebGLUniformLocation | null
  uShock: WebGLUniformLocation | null
}

interface RenderLocs {
  uState: WebGLUniformLocation | null
  uColor: WebGLUniformLocation | null
  uTexSize: WebGLUniformLocation | null
  uAspect: WebGLUniformLocation | null
  uPointSize: WebGLUniformLocation | null
  uResHeight: WebGLUniformLocation | null
  uFalloff: WebGLUniformLocation | null
}

export class PhotoSwarmScene implements SceneRuntime {
  meta = { id: 'photoswarm', name: 'Photo Swarm', family: 'particles' as const }

  params: ParamSchema[] = [
    { name: 'count', label: 'Particle count', min: 4096, max: 262144, default: DEFAULT_COUNT, step: 1024 },
    { name: 'return', label: 'Spring return', min: 0.5, max: 12, default: 6.0 },
    { name: 'turbulence', label: 'Turbulence', min: 0, max: 4, default: 1.2 },
    { name: 'shockwave', label: 'Shockwave', min: 0, max: 4, default: 1.0 },
    { name: 'pointSize', label: 'Point size', min: 1, max: 6, default: 2.2 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu
  private initialized = false
  private seed = 0
  private side = DEFAULT_SIDE
  private pendingSide: number | null = null
  private shock = 0

  /** Explicitly set image, or `null` to use the procedural fallback. Safe to
   * set before `init()` (just stored) or after (re-derives + hard-resets). */
  private userImage: PhotoSwarmImage | null = null

  private pp!: PingPong
  private homeTex!: FloatTarget
  private colorTex!: FloatTarget
  private fsPass!: FullscreenPass
  private updateProgram!: WebGLProgram
  private renderProgram!: WebGLProgram
  private updateLoc!: UpdateLocs
  private renderLoc!: RenderLocs
  private pointsVao!: WebGLVertexArrayObject

  // Code layer: current source per editable stage (see flowfield.ts's comment).
  private updateSource = UPDATE_FS
  private renderSource = RENDER_FS

  init(gpu: Gpu, seed: number): void {
    const caps = checkFloatRenderable(gpu)
    if (!caps.ok) throw new Error(caps.reason)

    this.gpu = gpu
    this.seed = seed
    this.side = DEFAULT_SIDE
    this.pendingSide = null
    this.shock = 0
    for (const p of this.params) this.values.set(p.name, p.default)

    this.updateSource = UPDATE_FS
    this.renderSource = RENDER_FS

    const gl = gpu.gl
    const { homes, colors } = deriveSwarmData(this.resolveImage(), this.side, this.seed)
    this.pp = new PingPong(gpu, this.side, homes.slice())
    this.homeTex = new FloatTarget(gpu, this.side, homes)
    this.colorTex = new FloatTarget(gpu, this.side, undefined, 'rgba8')
    this.colorTex.upload(colors)
    this.fsPass = new FullscreenPass(gpu)

    this.updateProgram = gpu.compileProgram(FULLSCREEN_VS, this.updateSource)
    this.renderProgram = gpu.compileProgram(RENDER_VS, this.renderSource)
    this.updateLoc = this.lookupUpdateLocs(this.updateProgram)
    this.renderLoc = this.lookupRenderLocs(this.renderProgram)

    const vao = gl.createVertexArray()
    if (!vao) throw new Error('Failed to create points VAO')
    this.pointsVao = vao

    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    this.initialized = true
  }

  /**
   * Duck-typed image API (NOT part of `SceneRuntime` — see the class-level
   * comment). `null` reverts to the built-in procedural fallback. Re-derives
   * home positions/colors from the new pixels + the scene's existing seed and
   * hard-resets particle state to the new homes — a deterministic function of
   * (seed, pixels), the same "performative reset" contract as the particle
   * family's count re-init (docs/PARTICLES.md §6).
   */
  setImage(img: PhotoSwarmImage | null): void {
    if (img && (img.width <= 0 || img.height <= 0 || img.data.length < img.width * img.height * 4)) {
      throw new Error('PhotoSwarmScene.setImage: image dimensions/data are invalid')
    }
    this.userImage = img
    if (!this.initialized) return // init() will resolve this
    const { homes, colors } = deriveSwarmData(this.resolveImage(), this.side, this.seed)
    this.homeTex.upload(homes)
    this.colorTex.upload(colors)
    this.pp.resize(this.side, homes.slice())
    this.shock = 0
  }

  private resolveImage(): PhotoSwarmImage {
    return this.userImage ?? generateFallbackImage(this.seed)
  }

  /**
   * Scene handoff (docs/HANDOFF.md §2): the snapshot *is* the photo — one line,
   * since `SceneSnapshot` is structurally identical to `PhotoSwarmImage`. The
   * swarm re-homes to A's frame and keeps reforming it, exactly like any other
   * `setImage` call.
   */
  ingest(snap: SceneSnapshot): void {
    this.setImage(snap)
  }

  setParam(name: string, value: number): void {
    if (name === 'count') {
      const side = snapCountToSide(value)
      this.values.set('count', side * side)
      this.pendingSide = side !== this.side ? side : null
      return
    }
    this.values.set(name, value)
  }

  getParam(name: string): number {
    return this.values.get(name) ?? 0
  }

  update(ctx: FrameContext): void {
    const { frame, signals } = ctx
    const gl = this.gpu.gl

    // Count re-init (docs/PARTICLES.md §6): a hard swarm reset re-sampling the
    // current image at the new particle count, applied at the top of the next
    // update() call — home/color textures are sized to the particle count, so
    // they're rebuilt (not just resized) alongside the ping-pong state.
    if (this.pendingSide !== null) {
      this.side = this.pendingSide
      this.pendingSide = null
      const { homes, colors } = deriveSwarmData(this.resolveImage(), this.side, this.seed)
      this.homeTex.dispose()
      this.homeTex = new FloatTarget(this.gpu, this.side, homes)
      this.colorTex.dispose()
      this.colorTex = new FloatTarget(this.gpu, this.side, undefined, 'rgba8')
      this.colorTex.upload(colors)
      this.pp.resize(this.side, homes.slice())
      this.shock = 0
    }

    const bass = signals.get('bass')
    const onset = signals.get('onset')
    this.shock = this.shock * Math.exp(-SHOCK_DECAY * frame.dt) + SHOCK_GAIN * onset
    if (this.shock > SHOCK_MAX) this.shock = SHOCK_MAX

    const returnParam = this.getParam('return')
    const damping = 2 * DAMPING_RATIO * Math.sqrt(Math.max(returnParam, 0))

    this.pp.dst.bindTarget()
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)
    gl.useProgram(this.updateProgram)
    this.pp.src.bindTexture(0)
    this.homeTex.bindTexture(1)
    gl.uniform1i(this.updateLoc.uState, 0)
    gl.uniform1i(this.updateLoc.uHome, 1)
    gl.uniform1f(this.updateLoc.uDt, frame.dt)
    gl.uniform1f(this.updateLoc.uTime, frame.time)
    gl.uniform1f(this.updateLoc.uReturn, returnParam)
    gl.uniform1f(this.updateLoc.uDamping, damping)
    gl.uniform1f(this.updateLoc.uTurbulence, this.getParam('turbulence'))
    gl.uniform1f(this.updateLoc.uBass, bass)
    gl.uniform1f(this.updateLoc.uShock, this.shock * this.getParam('shockwave'))
    this.fsPass.draw()
    this.pp.swap()
  }

  render(_ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()
    // No trail accumulation (unlike flowfield): the point is a legible photo
    // at rest, which streak-trails would smear — clear to black every frame.
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE)
    gl.disable(gl.DEPTH_TEST)

    gl.useProgram(this.renderProgram)
    this.pp.src.bindTexture(0)
    this.colorTex.bindTexture(1)
    gl.uniform1i(this.renderLoc.uState, 0)
    gl.uniform1i(this.renderLoc.uColor, 1)
    gl.uniform1i(this.renderLoc.uTexSize, this.side)
    gl.uniform1f(this.renderLoc.uAspect, surface.width / surface.height)
    gl.uniform1f(this.renderLoc.uPointSize, this.getParam('pointSize'))
    gl.uniform1f(this.renderLoc.uResHeight, surface.height)
    gl.uniform1f(this.renderLoc.uFalloff, FALLOFF)
    gl.bindVertexArray(this.pointsVao)
    gl.drawArrays(gl.POINTS, 0, this.side * this.side)
    gl.bindVertexArray(null)
  }

  resize(width: number, height: number): void {
    this.gpu.resize(width, height)
    this.gpu.gl.clearColor(0, 0, 0, 1)
    this.gpu.gl.clear(this.gpu.gl.COLOR_BUFFER_BIT)
  }

  dispose(): void {
    const gl = this.gpu.gl
    gl.deleteProgram(this.updateProgram)
    gl.deleteProgram(this.renderProgram)
    gl.deleteVertexArray(this.pointsVao)
    this.fsPass.dispose()
    this.pp.dispose()
    this.homeTex.dispose()
    this.colorTex.dispose()
    this.initialized = false
  }

  private lookupUpdateLocs(program: WebGLProgram): UpdateLocs {
    const gl = this.gpu.gl
    return {
      uState: gl.getUniformLocation(program, 'uState'),
      uHome: gl.getUniformLocation(program, 'uHome'),
      uDt: gl.getUniformLocation(program, 'uDt'),
      uTime: gl.getUniformLocation(program, 'uTime'),
      uReturn: gl.getUniformLocation(program, 'uReturn'),
      uDamping: gl.getUniformLocation(program, 'uDamping'),
      uTurbulence: gl.getUniformLocation(program, 'uTurbulence'),
      uBass: gl.getUniformLocation(program, 'uBass'),
      uShock: gl.getUniformLocation(program, 'uShock'),
    }
  }

  private lookupRenderLocs(program: WebGLProgram): RenderLocs {
    const gl = this.gpu.gl
    return {
      uState: gl.getUniformLocation(program, 'uState'),
      uColor: gl.getUniformLocation(program, 'uColor'),
      uTexSize: gl.getUniformLocation(program, 'uTexSize'),
      uAspect: gl.getUniformLocation(program, 'uAspect'),
      uPointSize: gl.getUniformLocation(program, 'uPointSize'),
      uResHeight: gl.getUniformLocation(program, 'uResHeight'),
      uFalloff: gl.getUniformLocation(program, 'uFalloff'),
    }
  }

  getShaderSources(): ShaderStage[] {
    return [
      { key: 'update-fs', label: 'Swarm physics (update-fs)', source: this.updateSource },
      { key: 'render-fs', label: 'Point render (render-fs)', source: this.renderSource },
    ]
  }

  setShaderSource(key: string, source: string): void {
    const gl = this.gpu.gl
    switch (key) {
      case 'update-fs': {
        const program = this.gpu.compileProgram(FULLSCREEN_VS, source) // throws on GLSL error; old program untouched
        gl.deleteProgram(this.updateProgram)
        this.updateProgram = program
        this.updateLoc = this.lookupUpdateLocs(program)
        this.updateSource = source
        return
      }
      case 'render-fs': {
        const program = this.gpu.compileProgram(RENDER_VS, source)
        gl.deleteProgram(this.renderProgram)
        this.renderProgram = program
        this.renderLoc = this.lookupRenderLocs(program)
        this.renderSource = source
        return
      }
      default:
        throw new Error(`Unknown shader stage "${key}" for scene "${this.meta.id}"`)
    }
  }
}
