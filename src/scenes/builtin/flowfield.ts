import { mulberry32 } from '../../core/prng'
import type { Gpu } from '../../gpu/context'
import { checkFloatRenderable, FullscreenPass, PingPong } from '../../gpu/targets'
import { snapCountToSide, DEFAULT_COUNT, DEFAULT_SIDE } from '../families/particles/gpgpu'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'

/**
 * Particles family, scene 1 (docs/PARTICLES.md §5): a GPGPU flow field. Particle
 * state (px,py,vx,vy) lives in an RGBA32F ping-pong texture; velocity targets
 * come from the curl of a 2-octave value-noise potential (divergence-free flow).
 * All GLSL below is transcribed verbatim from the spec — do not hand-tune it.
 */

// Attribute-less fullscreen triangle: standard gl_VertexID trick, no VBO needed.
// Shared by the GPGPU update pass (whose fragment shader reads gl_FragCoord.xy
// to address its state texel) and the trail-fade quad (which just needs a
// triangle covering the viewport).
const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`

const FADE_FS = `#version 300 es
precision highp float;
uniform float uFade;
out vec4 outColor;
void main() { outColor = vec4(0.0, 0.0, 0.0, uFade); }`

const UPDATE_FS = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform int   uTexSize, uFrame;
uniform float uDt, uTime, uFieldScale, uDrift, uFlowSpeed, uResponse, uPulse;
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
  int idx = tc.y*uTexSize + tc.x;
  vec4 s = texelFetch(uState, tc, 0);
  vec2 p = s.xy, v = s.zw;
  vec2 target = curl(p*uFieldScale, uTime*uDrift) * uFlowSpeed;
  target += -p * uPulse;                       // onset impulse: centre attraction
  float a = 1.0 - exp(-uResponse*uDt);         // unconditionally stable
  v += (target - v) * a;
  p += v * uDt;
  if(abs(p.x)>1.5 || abs(p.y)>1.5){            // deterministic respawn keyed (idx, frame)
    uint fs = uint(idx)*2u ^ (uint(uFrame)*0x9e3779b9u);
    p = vec2(float(hash32(fs)), float(hash32(fs+1u)))/4294967296.0 * 2.8 - 1.4;
    v = vec2(0.0);
  }
  outState = vec4(p, v);
}`

const RENDER_VS = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform int uTexSize;
uniform float uAspect, uPointSize, uResHeight;
out float vSpeed;
void main(){
  int i = gl_VertexID;
  vec4 s = texelFetch(uState, ivec2(i % uTexSize, i / uTexSize), 0);
  vSpeed = length(s.zw);
  vec2 p = s.xy;
  p.x /= max(uAspect,1.0);
  p.y *= min(uAspect,1.0);
  gl_Position = vec4(p, 0.0, 1.0);
  gl_PointSize = uPointSize * max(uResHeight/360.0, 1.0);
}`

const RENDER_FS = `#version 300 es
precision highp float;
in float vSpeed;
uniform float uHueShift, uFalloff;
out vec4 outColor;
vec3 hsv2rgb(vec3 c){ vec4 K=vec4(1.,2./3.,1./3.,3.); vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www); return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y); }
void main(){
  vec2 d = gl_PointCoord*2.0-1.0;
  float r2 = dot(d,d);
  if(r2 > 1.0) discard;
  float alpha = exp(-r2*uFalloff);
  vec3 col = hsv2rgb(vec3(fract(uHueShift + vSpeed*0.5), 0.85, 1.0));
  outColor = vec4(col*alpha, alpha);
}`

const FALLOFF = 4.0

/** CPU seed (docs/PARTICLES.md §5): p uniform in [-1.5,1.5]², v = 0. */
export function seedFlowState(seed: number, n: number): Float32Array {
  const rng = mulberry32(seed)
  const out = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) {
    out[i * 4 + 0] = rng() * 3 - 1.5
    out[i * 4 + 1] = rng() * 3 - 1.5
    out[i * 4 + 2] = 0
    out[i * 4 + 3] = 0
  }
  return out
}

interface UpdateLocs {
  uState: WebGLUniformLocation | null
  uTexSize: WebGLUniformLocation | null
  uFrame: WebGLUniformLocation | null
  uDt: WebGLUniformLocation | null
  uTime: WebGLUniformLocation | null
  uFieldScale: WebGLUniformLocation | null
  uDrift: WebGLUniformLocation | null
  uFlowSpeed: WebGLUniformLocation | null
  uResponse: WebGLUniformLocation | null
  uPulse: WebGLUniformLocation | null
}

interface RenderLocs {
  uState: WebGLUniformLocation | null
  uTexSize: WebGLUniformLocation | null
  uAspect: WebGLUniformLocation | null
  uPointSize: WebGLUniformLocation | null
  uResHeight: WebGLUniformLocation | null
  uHueShift: WebGLUniformLocation | null
  uFalloff: WebGLUniformLocation | null
}

export class FlowFieldScene implements SceneRuntime {
  meta = { id: 'flowfield', name: 'Flow Field', family: 'particles' as const }

  params: ParamSchema[] = [
    { name: 'count', label: 'Particle count', min: 4096, max: 262144, default: DEFAULT_COUNT, step: 1024 },
    { name: 'fieldScale', label: 'Field scale', min: 0.5, max: 6, default: 2.0 },
    { name: 'flowSpeed', label: 'Flow speed', min: 0, max: 2, default: 0.6 },
    { name: 'drift', label: 'Drift', min: 0, max: 2, default: 0.3 },
    { name: 'response', label: 'Response', min: 0.5, max: 8, default: 3.0 },
    { name: 'pointSize', label: 'Point size', min: 1, max: 6, default: 2.0 },
    { name: 'trail', label: 'Trail fade', min: 0.02, max: 0.5, default: 0.12 },
    { name: 'hueShift', label: 'Hue shift', min: 0, max: 1, default: 0.55 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu
  private seed = 0
  private side = DEFAULT_SIDE
  private pendingSide: number | null = null
  private pulse = 0

  private pp!: PingPong
  private fsPass!: FullscreenPass
  private updateProgram!: WebGLProgram
  private fadeProgram!: WebGLProgram
  private renderProgram!: WebGLProgram
  private updateLoc!: UpdateLocs
  private fadeLoc!: { uFade: WebGLUniformLocation | null }
  private renderLoc!: RenderLocs
  private pointsVao!: WebGLVertexArrayObject

  // Code layer (ARCHITECTURE.md §3.3): current source per editable stage, reset
  // to the stock defaults every init() so loadSession's dispose+init starts
  // clean. Unlike lissajous, uniform locations here are cached (not
  // per-render getUniformLocation calls) so a program swap must refresh them.
  private updateSource = UPDATE_FS
  private renderSource = RENDER_FS

  init(gpu: Gpu, seed: number): void {
    const caps = checkFloatRenderable(gpu)
    if (!caps.ok) throw new Error(caps.reason)

    this.gpu = gpu
    this.seed = seed
    this.side = DEFAULT_SIDE
    this.pendingSide = null
    this.pulse = 0
    for (const p of this.params) this.values.set(p.name, p.default)

    this.updateSource = UPDATE_FS
    this.renderSource = RENDER_FS

    const gl = gpu.gl
    this.pp = new PingPong(gpu, this.side, seedFlowState(seed, this.side * this.side))
    this.fsPass = new FullscreenPass(gpu)

    this.updateProgram = gpu.compileProgram(FULLSCREEN_VS, this.updateSource)
    this.fadeProgram = gpu.compileProgram(FULLSCREEN_VS, FADE_FS)
    this.renderProgram = gpu.compileProgram(RENDER_VS, this.renderSource)

    this.updateLoc = this.lookupUpdateLocs(this.updateProgram)
    this.fadeLoc = { uFade: gl.getUniformLocation(this.fadeProgram, 'uFade') }
    this.renderLoc = this.lookupRenderLocs(this.renderProgram)

    const vao = gl.createVertexArray()
    if (!vao) throw new Error('Failed to create points VAO')
    this.pointsVao = vao

    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
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

    // Count re-init semantics (docs/PARTICLES.md §6): a hard swarm reset to
    // fresh seed positions, applied at the top of the next update() call.
    if (this.pendingSide !== null) {
      this.side = this.pendingSide
      this.pendingSide = null
      this.pp.resize(this.side, seedFlowState(this.seed, this.side * this.side))
    }

    const bass = signals.get('bass')
    const high = signals.get('high')
    const onset = signals.get('onset')
    this.pulse = this.pulse * Math.exp(-6 * frame.dt) + 2.5 * onset
    if (this.pulse > 3) this.pulse = 3

    const flowSpeed = this.getParam('flowSpeed') * (1 + 0.8 * bass)
    const fieldScale = this.getParam('fieldScale') * (1 + 0.25 * high)

    this.pp.dst.bindTarget()
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)
    gl.useProgram(this.updateProgram)
    this.pp.src.bindTexture(0)
    gl.uniform1i(this.updateLoc.uState, 0)
    gl.uniform1i(this.updateLoc.uTexSize, this.side)
    gl.uniform1i(this.updateLoc.uFrame, frame.frame)
    gl.uniform1f(this.updateLoc.uDt, frame.dt)
    gl.uniform1f(this.updateLoc.uTime, frame.time)
    gl.uniform1f(this.updateLoc.uFieldScale, fieldScale)
    gl.uniform1f(this.updateLoc.uDrift, this.getParam('drift'))
    gl.uniform1f(this.updateLoc.uFlowSpeed, flowSpeed)
    gl.uniform1f(this.updateLoc.uResponse, this.getParam('response'))
    gl.uniform1f(this.updateLoc.uPulse, this.pulse)
    this.fsPass.draw()
    this.pp.swap()
  }

  render(_ctx: FrameContext): void {
    const gl = this.gpu.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.gpu.width, this.gpu.height)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(this.fadeProgram)
    gl.uniform1f(this.fadeLoc.uFade, this.getParam('trail'))
    this.fsPass.draw()

    gl.blendFunc(gl.ONE, gl.ONE)
    gl.useProgram(this.renderProgram)
    this.pp.src.bindTexture(0)
    gl.uniform1i(this.renderLoc.uState, 0)
    gl.uniform1i(this.renderLoc.uTexSize, this.side)
    gl.uniform1f(this.renderLoc.uAspect, this.gpu.width / this.gpu.height)
    gl.uniform1f(this.renderLoc.uPointSize, this.getParam('pointSize'))
    gl.uniform1f(this.renderLoc.uResHeight, this.gpu.height)
    gl.uniform1f(this.renderLoc.uHueShift, this.getParam('hueShift'))
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
    gl.deleteProgram(this.fadeProgram)
    gl.deleteProgram(this.renderProgram)
    gl.deleteVertexArray(this.pointsVao)
    this.fsPass.dispose()
    this.pp.dispose()
  }

  private lookupUpdateLocs(program: WebGLProgram): UpdateLocs {
    const gl = this.gpu.gl
    return {
      uState: gl.getUniformLocation(program, 'uState'),
      uTexSize: gl.getUniformLocation(program, 'uTexSize'),
      uFrame: gl.getUniformLocation(program, 'uFrame'),
      uDt: gl.getUniformLocation(program, 'uDt'),
      uTime: gl.getUniformLocation(program, 'uTime'),
      uFieldScale: gl.getUniformLocation(program, 'uFieldScale'),
      uDrift: gl.getUniformLocation(program, 'uDrift'),
      uFlowSpeed: gl.getUniformLocation(program, 'uFlowSpeed'),
      uResponse: gl.getUniformLocation(program, 'uResponse'),
      uPulse: gl.getUniformLocation(program, 'uPulse'),
    }
  }

  private lookupRenderLocs(program: WebGLProgram): RenderLocs {
    const gl = this.gpu.gl
    return {
      uState: gl.getUniformLocation(program, 'uState'),
      uTexSize: gl.getUniformLocation(program, 'uTexSize'),
      uAspect: gl.getUniformLocation(program, 'uAspect'),
      uPointSize: gl.getUniformLocation(program, 'uPointSize'),
      uResHeight: gl.getUniformLocation(program, 'uResHeight'),
      uHueShift: gl.getUniformLocation(program, 'uHueShift'),
      uFalloff: gl.getUniformLocation(program, 'uFalloff'),
    }
  }

  getShaderSources(): ShaderStage[] {
    return [
      { key: 'update-fs', label: 'Field update (update-fs)', source: this.updateSource },
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
