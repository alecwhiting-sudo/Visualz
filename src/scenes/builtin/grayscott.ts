import { mulberry32 } from '../../core/prng'
import type { Gpu } from '../../gpu/context'
import { checkFloatRenderable, FullscreenPass, PingPong, type RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'

/**
 * Simulation family, scene 1 (docs/GRAYSCOTT.md): Gray-Scott reaction-diffusion.
 * State (U, V) lives in an RGBA32F ping-pong texture (`.r=U`, `.g=V`, `.ba`
 * reserved), 16 fixed Euler substeps per frame, each a separate ping-pong draw
 * (neighbor reads must see the previous substep's fully-settled state, not a
 * partially-written texture). GLSL below is transcribed verbatim from the spec.
 */

const DEFAULT_GRID = 256
const SUBSTEPS = 16
const DU = 1.0
const DV = 0.5
const WARP = 0.004
const SPOT_COUNT = 18

// Attribute-less fullscreen triangle: standard gl_VertexID trick, no VBO needed.
const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`

// docs/GRAYSCOTT.md §4 — one Euler substep, run SUBSTEPS×/frame ping-ponging.
const UPDATE_FS = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform int   uTexSize, uFrame;
uniform float uF, uK, uDu, uDv, uDt, uInject, uDropRadius;
out vec4 outState;

const int DROPS = 6;
uint hash32(uint x){ x=x+0x9e3779b9u; x^=x>>16u; x*=0x7feb352du; x^=x>>15u; x*=0x846ca68bu; x^=x>>16u; return x; }

vec2 rg(ivec2 c){                     // clamped fetch => Neumann (zero-flux) boundary
  c = clamp(c, ivec2(0), ivec2(uTexSize-1));
  return texelFetch(uState, c, 0).rg;
}
void main(){
  ivec2 tc = ivec2(gl_FragCoord.xy);
  vec2 s = texelFetch(uState, tc, 0).rg;
  float U = s.r, V = s.g;
  vec2 lap =
      0.2  * (rg(tc+ivec2(1,0)) + rg(tc+ivec2(-1,0)) + rg(tc+ivec2(0,1)) + rg(tc+ivec2(0,-1)))
    + 0.05 * (rg(tc+ivec2(1,1)) + rg(tc+ivec2(-1,1)) + rg(tc+ivec2(1,-1)) + rg(tc+ivec2(-1,-1)))
    - s;
  float uvv = U*V*V;
  float Un = U + (uDu*lap.r - uvv + uF*(1.0 - U)) * uDt;
  float Vn = V + (uDv*lap.g + uvv - (uF + uK)*V) * uDt;
  if (uInject > 0.5) {                // onset droplets, substep 0 only
    vec2 pos = (vec2(tc) + 0.5) / float(uTexSize);
    for (int d = 0; d < DROPS; d++) {
      uint h = hash32(uint(uFrame)*0x9e3779b9u + uint(d)*0x2c1b3c6du);
      vec2 c = vec2(float(hash32(h)), float(hash32(h+1u))) / 4294967296.0;
      if (distance(pos, c) < uDropRadius) { Vn = max(Vn, 0.5); Un = min(Un, 0.3); }
    }
  }
  outState = vec4(Un, Vn, 0.0, 1.0);
}`

// docs/GRAYSCOTT.md §5 — single opaque fullscreen display pass.
const RENDER_FS = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform int   uTexSize;
uniform vec2  uRes;
uniform float uAspect, uHueShift, uHueSpread, uBrightness, uEmboss, uWarp, uWarpPhase;
out vec4 outColor;

vec3 hsv2rgb(vec3 c){ vec4 K=vec4(1.,2./3.,1./3.,3.); vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www); return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y); }

float Vat(vec2 st){                   // manual bilinear from NEAREST float texture
  vec2 t = st*float(uTexSize) - 0.5;
  ivec2 i = ivec2(floor(t)); vec2 f = t - vec2(i); ivec2 mx = ivec2(uTexSize-1);
  float v00=texelFetch(uState,clamp(i,           ivec2(0),mx),0).g;
  float v10=texelFetch(uState,clamp(i+ivec2(1,0),ivec2(0),mx),0).g;
  float v01=texelFetch(uState,clamp(i+ivec2(0,1),ivec2(0),mx),0).g;
  float v11=texelFetch(uState,clamp(i+ivec2(1,1),ivec2(0),mx),0).g;
  return mix(mix(v00,v10,f.x), mix(v01,v11,f.x), f.y);
}
void main(){
  vec2 ndc = (gl_FragCoord.xy/uRes)*2.0 - 1.0;
  ndc.x *= max(uAspect,1.0);          // invert the min-axis fit -> square sim space
  ndc.y /= min(uAspect,1.0);
  vec2 st = ndc*0.5 + 0.5;
  st += uWarp * vec2(sin((st.y+uWarpPhase)*6.2831), cos((st.x+uWarpPhase)*6.2831));
  if (any(lessThan(st, vec2(0.0))) || any(greaterThan(st, vec2(1.0)))) { outColor = vec4(0.02,0.02,0.03,1.0); return; }
  float v = Vat(st);
  float tx = 1.0/float(uTexSize);
  float gx = Vat(st+vec2(tx,0.0)) - Vat(st-vec2(tx,0.0));
  float gy = Vat(st+vec2(0.0,tx)) - Vat(st-vec2(0.0,tx));
  vec3 n = normalize(vec3(-gx, -gy, uEmboss*0.15 + 1e-3));
  float shade = mix(1.0, clamp(dot(n, normalize(vec3(-0.5,-0.5,1.0))),0.0,1.0), uEmboss);
  float vv = clamp(v/0.45, 0.0, 1.0);
  vec3 col = hsv2rgb(vec3(fract(uHueShift + uHueSpread*vv), 0.7, 1.0)) * vv;
  outColor = vec4(col * shade * uBrightness, 1.0);
}`

/**
 * CPU seed (docs/GRAYSCOTT.md §6): U=1,V=0 everywhere, then 18 strong V-blobs
 * (spots-only nuclei — the reaction is contractive so deterministic starting
 * blobs lock the pattern's overall layout across builds). Center and radius
 * (in texels) are drawn from `mulberry32(seed)` in the order center.x,
 * center.y, radius per spot; inside each spot: U=0.5, V=0.25.
 */
export function seedGrayScottState(seed: number, side: number): Float32Array {
  const rng = mulberry32(seed)
  const out = new Float32Array(side * side * 4)
  for (let i = 0; i < side * side; i++) {
    out[i * 4 + 0] = 1 // U
    out[i * 4 + 1] = 0 // V
    out[i * 4 + 2] = 0
    out[i * 4 + 3] = 1
  }
  for (let spot = 0; spot < SPOT_COUNT; spot++) {
    const cx = rng() * side
    const cy = rng() * side
    const radius = 3 + rng() * 6
    const minX = Math.max(0, Math.floor(cx - radius))
    const maxX = Math.min(side - 1, Math.ceil(cx + radius))
    const minY = Math.max(0, Math.floor(cy - radius))
    const maxY = Math.min(side - 1, Math.ceil(cy + radius))
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cx
        const dy = y - cy
        if (dx * dx + dy * dy <= radius * radius) {
          const idx = (y * side + x) * 4
          out[idx + 0] = 0.5
          out[idx + 1] = 0.25
        }
      }
    }
  }
  return out
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

interface UpdateLocs {
  uState: WebGLUniformLocation | null
  uTexSize: WebGLUniformLocation | null
  uFrame: WebGLUniformLocation | null
  uF: WebGLUniformLocation | null
  uK: WebGLUniformLocation | null
  uDu: WebGLUniformLocation | null
  uDv: WebGLUniformLocation | null
  uDt: WebGLUniformLocation | null
  uInject: WebGLUniformLocation | null
  uDropRadius: WebGLUniformLocation | null
}

interface RenderLocs {
  uState: WebGLUniformLocation | null
  uTexSize: WebGLUniformLocation | null
  uRes: WebGLUniformLocation | null
  uAspect: WebGLUniformLocation | null
  uHueShift: WebGLUniformLocation | null
  uHueSpread: WebGLUniformLocation | null
  uBrightness: WebGLUniformLocation | null
  uEmboss: WebGLUniformLocation | null
  uWarp: WebGLUniformLocation | null
  uWarpPhase: WebGLUniformLocation | null
}

export class GrayScottScene implements SceneRuntime {
  meta = { id: 'grayscott', name: 'Reaction-Diffusion', family: 'simulation' as const }

  params: ParamSchema[] = [
    { name: 'feed', label: 'Feed rate (F)', min: 0.02, max: 0.06, default: 0.0545 },
    { name: 'kill', label: 'Kill rate (k)', min: 0.05, max: 0.066, default: 0.062 },
    { name: 'speed', label: 'Evolution speed', min: 0.3, max: 1.1, default: 1.0 },
    { name: 'dropletSize', label: 'Onset droplet size', min: 0.01, max: 0.06, default: 0.03 },
    { name: 'hueShift', label: 'Hue', min: 0, max: 1, default: 0.55 },
    { name: 'hueSpread', label: 'Hue spread', min: 0, max: 1, default: 0.35 },
    { name: 'emboss', label: 'Relief depth', min: 0, max: 1, default: 0.5 },
    { name: 'brightness', label: 'Brightness', min: 0.3, max: 2.0, default: 1.0 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu

  // Sim resolution (docs/GRAYSCOTT.md §0): fixed 256² ship default; test mode
  // bakes a smaller grid via `setGridSize()`, which MUST be called before
  // `init()` — init() constructs the PingPong at whatever `grid` currently
  // holds and there is no resize-in-place path (same accepted position as
  // PARTICLES §0: no SceneRuntime.reset()).
  private grid = DEFAULT_GRID

  private pp!: PingPong
  private fsPass!: FullscreenPass
  private updateProgram!: WebGLProgram
  private renderProgram!: WebGLProgram
  private updateLoc!: UpdateLocs
  private renderLoc!: RenderLocs

  // Code layer (ARCHITECTURE.md §3.3): current source per editable stage, reset
  // to the stock defaults every init(). Uniform locations are cached, so a
  // program swap in setShaderSource must refresh them.
  private updateSource = UPDATE_FS
  private renderSource = RENDER_FS

  /** Test-mode-only grid override (docs/GRAYSCOTT.md §9 accepted flag #2). Not
   * part of `SceneRuntime` — callers that know about `GrayScottScene`
   * specifically (the test harness) may call it; generic engine code never
   * does. Must run before `init()`. */
  setGridSize(n: number): void {
    this.grid = n
  }

  init(gpu: Gpu, seed: number): void {
    const caps = checkFloatRenderable(gpu)
    if (!caps.ok) throw new Error(caps.reason)

    this.gpu = gpu
    for (const p of this.params) this.values.set(p.name, p.default)

    this.updateSource = UPDATE_FS
    this.renderSource = RENDER_FS

    const gl = gpu.gl
    this.pp = new PingPong(gpu, this.grid, seedGrayScottState(seed, this.grid))
    this.fsPass = new FullscreenPass(gpu)

    this.updateProgram = gpu.compileProgram(FULLSCREEN_VS, this.updateSource)
    this.renderProgram = gpu.compileProgram(FULLSCREEN_VS, this.renderSource)
    this.updateLoc = this.lookupUpdateLocs(this.updateProgram)
    this.renderLoc = this.lookupRenderLocs(this.renderProgram)

    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  setParam(name: string, value: number): void {
    this.values.set(name, value)
  }

  getParam(name: string): number {
    return this.values.get(name) ?? 0
  }

  update(ctx: FrameContext): void {
    // Frame-clocked, NOT dt-clocked (docs/GRAYSCOTT.md §0/§6): frame.dt is
    // deliberately unused. Explicit Euler here is only *conditionally* stable
    // (clean through dt_sub≈1.15, NaN by 1.24), so dt_sub must stay a fixed
    // constant per substep, not derived from wall/audio dt — otherwise a
    // 30fps render and a 60fps live session would take different step sizes
    // and diverge frame-for-frame. (Contrast flowfield's `a = 1-exp(-r*dt)`
    // response, which is unconditionally stable and safe to drive off
    // frame.dt directly.) 16 fixed substeps run every call regardless of dt.
    const { frame, signals } = ctx
    const gl = this.gpu.gl

    const bass = signals.get('bass')
    const onset = signals.get('onset')

    const uF = clamp(this.getParam('feed') * (1 + 0.15 * bass), 0.02, 0.062)
    const uK = this.getParam('kill')
    const uDt = clamp(this.getParam('speed'), 0.3, 1.1)
    const uDropRadius = this.getParam('dropletSize')
    const wantsInject = onset > 0.5

    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)
    gl.useProgram(this.updateProgram)
    gl.uniform1i(this.updateLoc.uTexSize, this.grid)
    gl.uniform1i(this.updateLoc.uFrame, frame.frame)
    gl.uniform1f(this.updateLoc.uF, uF)
    gl.uniform1f(this.updateLoc.uK, uK)
    gl.uniform1f(this.updateLoc.uDu, DU)
    gl.uniform1f(this.updateLoc.uDv, DV)
    gl.uniform1f(this.updateLoc.uDt, uDt)
    gl.uniform1f(this.updateLoc.uDropRadius, uDropRadius)
    gl.uniform1i(this.updateLoc.uState, 0)

    for (let i = 0; i < SUBSTEPS; i++) {
      this.pp.dst.bindTarget()
      this.pp.src.bindTexture(0)
      gl.uniform1f(this.updateLoc.uInject, i === 0 && wantsInject ? 1 : 0)
      this.fsPass.draw()
      this.pp.swap()
    }
  }

  render(ctx: FrameContext, surface: RenderSurface): void {
    const { signals } = ctx
    const gl = this.gpu.gl
    surface.bind()
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)

    gl.useProgram(this.renderProgram)
    this.pp.src.bindTexture(0)
    gl.uniform1i(this.renderLoc.uState, 0)
    gl.uniform1i(this.renderLoc.uTexSize, this.grid)
    gl.uniform2f(this.renderLoc.uRes, surface.width, surface.height)
    gl.uniform1f(this.renderLoc.uAspect, surface.width / surface.height)
    gl.uniform1f(this.renderLoc.uHueShift, this.getParam('hueShift'))
    gl.uniform1f(this.renderLoc.uHueSpread, this.getParam('hueSpread'))
    gl.uniform1f(this.renderLoc.uBrightness, this.getParam('brightness'))
    gl.uniform1f(this.renderLoc.uEmboss, this.getParam('emboss'))
    gl.uniform1f(this.renderLoc.uWarp, WARP)
    gl.uniform1f(this.renderLoc.uWarpPhase, signals.get('beatPhase'))
    this.fsPass.draw()
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
    this.fsPass.dispose()
    this.pp.dispose()
  }

  private lookupUpdateLocs(program: WebGLProgram): UpdateLocs {
    const gl = this.gpu.gl
    return {
      uState: gl.getUniformLocation(program, 'uState'),
      uTexSize: gl.getUniformLocation(program, 'uTexSize'),
      uFrame: gl.getUniformLocation(program, 'uFrame'),
      uF: gl.getUniformLocation(program, 'uF'),
      uK: gl.getUniformLocation(program, 'uK'),
      uDu: gl.getUniformLocation(program, 'uDu'),
      uDv: gl.getUniformLocation(program, 'uDv'),
      uDt: gl.getUniformLocation(program, 'uDt'),
      uInject: gl.getUniformLocation(program, 'uInject'),
      uDropRadius: gl.getUniformLocation(program, 'uDropRadius'),
    }
  }

  private lookupRenderLocs(program: WebGLProgram): RenderLocs {
    const gl = this.gpu.gl
    return {
      uState: gl.getUniformLocation(program, 'uState'),
      uTexSize: gl.getUniformLocation(program, 'uTexSize'),
      uRes: gl.getUniformLocation(program, 'uRes'),
      uAspect: gl.getUniformLocation(program, 'uAspect'),
      uHueShift: gl.getUniformLocation(program, 'uHueShift'),
      uHueSpread: gl.getUniformLocation(program, 'uHueSpread'),
      uBrightness: gl.getUniformLocation(program, 'uBrightness'),
      uEmboss: gl.getUniformLocation(program, 'uEmboss'),
      uWarp: gl.getUniformLocation(program, 'uWarp'),
      uWarpPhase: gl.getUniformLocation(program, 'uWarpPhase'),
    }
  }

  getShaderSources(): ShaderStage[] {
    return [
      { key: 'update-fs', label: 'Reaction-diffusion update (update-fs)', source: this.updateSource },
      { key: 'render-fs', label: 'Field render (render-fs)', source: this.renderSource },
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
        const program = this.gpu.compileProgram(FULLSCREEN_VS, source)
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
