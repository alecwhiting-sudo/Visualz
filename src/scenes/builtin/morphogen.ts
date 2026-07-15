import { mulberry32 } from '../../core/prng'
import type { Gpu } from '../../gpu/context'
import { FullscreenPass, type RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'

/**
 * Geometry family: a "morphogenesis" scene that continuously journeys through
 * four pattern generators (wave interference, phyllotaxis spiral, hex-folded
 * rings, domain-warped flow noise), crossfading between neighbors as
 * `journeyPhase` advances. Same GPU-stateless shape as julia.ts — one
 * fullscreen fragment pass, pure function of uniforms every frame; all
 * persistent state (the journey phase and audio-reactive envelopes) lives on
 * the CPU in `update()`.
 */

// Attribute-less fullscreen triangle: identical to julia.ts's copy.
const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`

// hash32/vnoise2 copied verbatim from flowfield.ts's UPDATE_FS (same block
// julia.ts also copies verbatim) so g3Flow's domain-warp noise stays
// bit-consistent with the rest of the codebase's noise builtin.
const RENDER_FS = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uAspect, uTime, uScale, uJourney;
uniform float uHueShift, uHueSpread, uContrast, uBrightness, uFlash;
out vec4 outColor;

const float PI = 3.14159265359;
const float TAU = 6.28318530718;

uint hash32(uint x){ x=x+0x9e3779b9u; x^=x>>16u; x*=0x7feb352du; x^=x>>15u; x*=0x846ca68bu; x^=x>>16u; return x; }
float lattice2(int ix,int iy){ uint k = hash32(uint(ix)) ^ (uint(iy)*0x9e3779b9u); return float(hash32(k))/4294967296.0*2.0-1.0; }
float fade(float t){ return t*t*(3.0-2.0*t); }
float vnoise2(vec2 p){
  vec2 i=floor(p), f=p-i; vec2 u=vec2(fade(f.x),fade(f.y));
  int ix=int(i.x), iy=int(i.y);
  float a=lattice2(ix,iy), b=lattice2(ix+1,iy), c=lattice2(ix,iy+1), d=lattice2(ix+1,iy+1);
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}

vec3 hsv2rgb(vec3 c){ vec4 K=vec4(1.,2./3.,1./3.,3.); vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www); return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y); }

float g0Interference(vec2 p, float scale, float time){
  float freq = scale * 6.0;
  vec2 d0 = vec2(cos(0.0), sin(0.0));
  vec2 d1 = vec2(cos(2.1), sin(2.1));
  vec2 d2 = vec2(cos(4.2), sin(4.2));
  float w0 = dot(p, d0) * freq + time * 1.3;
  float w1 = dot(p, d1) * freq + time * 1.1;
  float w2 = dot(p, d2) * freq + time * 0.9;
  float s = sin(w0) + sin(w1) + sin(w2);
  float band = 0.5 + 0.5 * sin(s);
  return pow(band, 3.0);
}

float g1Phyllotaxis(vec2 p, float scale, float time){
  float r = length(p);
  float a = atan(p.y, p.x);
  float u = sqrt(max(r, 0.0)) * scale * 3.0 - time * 0.15;
  float v = a * 8.0 / TAU;
  vec2 cell = floor(vec2(u, v));
  vec2 f = fract(vec2(u, v));
  uint h = hash32(uint(cell.x + 4096.0) * 0x2545f491u ^ uint(cell.y + 4096.0) * 0x9e3779b1u);
  vec2 jitter = vec2(float(hash32(h)), float(hash32(h + 1u))) / 4294967296.0;
  float d = length(f - jitter);
  return exp(-d * d * 30.0);
}

float g2Hexfold(vec2 p, float scale, float time){
  float r = length(p);
  float ang = atan(p.y, p.x);
  float seg = PI / 3.0;
  float af = mod(ang, seg);
  if (af > seg * 0.5) af = seg - af;
  vec2 folded = r * vec2(cos(af), sin(af));
  float rr = folded.x + 0.3 * folded.y;
  float band = sin(rr * scale * 10.0 - time);
  return pow(0.5 + 0.5 * band, 4.0);
}

float g3Flow(vec2 p, float scale, float time){
  vec2 q = p * scale * 2.0 + vec2(time * 0.3);
  float n = vnoise2(q) + 0.5 * vnoise2(q * 2.03 + vec2(17.3, -9.1));
  n /= 1.5;
  return smoothstep(0.15, 0.85, n * 0.5 + 0.5);
}

void main(){
  // Min-axis-fit: the shorter screen axis spans exactly [-1, 1].
  vec2 uv = (gl_FragCoord.xy / uResolution) * 2.0 - 1.0;
  uv.x *= max(uAspect, 1.0);
  uv.y /= min(uAspect, 1.0);
  vec2 p = uv;

  float g0v = g0Interference(p, uScale, uTime);
  float g1v = g1Phyllotaxis(p, uScale, uTime);
  float g2v = g2Hexfold(p, uScale, uTime);
  float g3v = g3Flow(p, uScale, uTime);

  int idx = int(min(floor(uJourney), 3.0));
  float frac = smoothstep(0.0, 1.0, fract(uJourney));
  float cur, nxt;
  if (idx == 0) { cur = g0v; nxt = g1v; }
  else if (idx == 1) { cur = g1v; nxt = g2v; }
  else if (idx == 2) { cur = g2v; nxt = g3v; }
  else { cur = g3v; nxt = g0v; }
  float intensity = clamp(mix(cur, nxt, frac), 0.0, 1.0);

  float hue = fract(uHueShift + intensity * uHueSpread + uJourney * 0.13);
  float value = pow(intensity, uContrast) * uBrightness * (1.0 + uFlash);
  vec3 col = hsv2rgb(vec3(hue, 0.8, clamp(value, 0.0, 1.0)));
  outColor = vec4(col, 1.0);
}`

// Envelope tuning, same shape as julia.ts: bass smoothing rate, lunge
// decay/scale (an onset "jump" added on top of the steady journey speed),
// and the onset flash decay/gain/max trio reused verbatim across scenes.
const BASS_SMOOTH_RATE = 3.0
const LUNGE_DECAY = 3.0
const LUNGE_SCALE = 0.35
const FLASH_DECAY = 8.0
const FLASH_GAIN = 1.0
const FLASH_MAX = 3.0

interface RenderLocs {
  uResolution: WebGLUniformLocation | null
  uAspect: WebGLUniformLocation | null
  uTime: WebGLUniformLocation | null
  uScale: WebGLUniformLocation | null
  uJourney: WebGLUniformLocation | null
  uHueShift: WebGLUniformLocation | null
  uHueSpread: WebGLUniformLocation | null
  uContrast: WebGLUniformLocation | null
  uBrightness: WebGLUniformLocation | null
  uFlash: WebGLUniformLocation | null
}

export class MorphogenScene implements SceneRuntime {
  meta = { id: 'morph', name: 'Morphogen', family: 'geometry' as const }

  params: ParamSchema[] = [
    { name: 'journeySpeed', label: 'Journey speed', min: 0, max: 0.2, default: 0.04 },
    { name: 'jumpOnOnset', label: 'Onset lunge', min: 0, max: 1, default: 0.5 },
    { name: 'scale', label: 'Scale', min: 0.4, max: 3, default: 1.0 },
    { name: 'hueShift', label: 'Hue shift', min: 0, max: 1, default: 0.1 },
    { name: 'hueSpread', label: 'Hue spread', min: 0.1, max: 1, default: 0.4 },
    { name: 'contrast', label: 'Contrast', min: 0.5, max: 3, default: 1.4 },
    { name: 'brightness', label: 'Brightness', min: 0.3, max: 2, default: 1.0 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu
  private fsPass!: FullscreenPass
  private renderProgram!: WebGLProgram
  private renderLoc!: RenderLocs

  // CPU-only state (ARCHITECTURE.md §1): journeyPhase accumulates dt every
  // frame (never wraps on the CPU side — only the uniform sent to the shader
  // wraps into [0,4)), so mid-session param changes stay continuous.
  private journeyPhase = 0
  private lungeVel = 0
  private smoothedBass = 0
  private flash = 0

  // Code layer: current source for the one editable stage.
  private renderSource = RENDER_FS

  init(gpu: Gpu, seed: number): void {
    this.gpu = gpu
    for (const p of this.params) this.values.set(p.name, p.default)

    const rng = mulberry32(seed)
    // Different seeds start in different pattern "worlds".
    this.journeyPhase = rng() * 4
    this.lungeVel = 0
    this.smoothedBass = 0
    this.flash = 0

    this.renderSource = RENDER_FS

    const gl = gpu.gl
    this.fsPass = new FullscreenPass(gpu)
    this.renderProgram = gpu.compileProgram(FULLSCREEN_VS, this.renderSource)
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
    const { frame, signals } = ctx
    const bass = signals.get('bass')
    const onset = signals.get('onset')
    const dt = frame.dt

    const a = 1 - Math.exp(-BASS_SMOOTH_RATE * dt)
    this.smoothedBass += (bass - this.smoothedBass) * a

    this.lungeVel = this.lungeVel * Math.exp(-LUNGE_DECAY * dt) + this.getParam('jumpOnOnset') * LUNGE_SCALE * onset
    this.journeyPhase += this.getParam('journeySpeed') * dt + this.lungeVel * dt * 10

    this.flash = this.flash * Math.exp(-FLASH_DECAY * dt) + FLASH_GAIN * onset
    if (this.flash > FLASH_MAX) this.flash = FLASH_MAX
  }

  render(ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)

    const journey = ((this.journeyPhase % 4) + 4) % 4
    const scale = this.getParam('scale') * (1 + 0.2 * this.smoothedBass)

    gl.useProgram(this.renderProgram)
    gl.uniform2f(this.renderLoc.uResolution, surface.width, surface.height)
    gl.uniform1f(this.renderLoc.uAspect, surface.width / surface.height)
    gl.uniform1f(this.renderLoc.uTime, ctx.frame.time)
    gl.uniform1f(this.renderLoc.uScale, scale)
    gl.uniform1f(this.renderLoc.uJourney, journey)
    gl.uniform1f(this.renderLoc.uHueShift, this.getParam('hueShift'))
    gl.uniform1f(this.renderLoc.uHueSpread, this.getParam('hueSpread'))
    gl.uniform1f(this.renderLoc.uContrast, this.getParam('contrast'))
    gl.uniform1f(this.renderLoc.uBrightness, this.getParam('brightness'))
    gl.uniform1f(this.renderLoc.uFlash, this.flash)
    this.fsPass.draw()
  }

  resize(width: number, height: number): void {
    this.gpu.resize(width, height)
    this.gpu.gl.clearColor(0, 0, 0, 1)
    this.gpu.gl.clear(this.gpu.gl.COLOR_BUFFER_BIT)
  }

  dispose(): void {
    const gl = this.gpu.gl
    gl.deleteProgram(this.renderProgram)
    this.fsPass.dispose()
  }

  private lookupRenderLocs(program: WebGLProgram): RenderLocs {
    const gl = this.gpu.gl
    return {
      uResolution: gl.getUniformLocation(program, 'uResolution'),
      uAspect: gl.getUniformLocation(program, 'uAspect'),
      uTime: gl.getUniformLocation(program, 'uTime'),
      uScale: gl.getUniformLocation(program, 'uScale'),
      uJourney: gl.getUniformLocation(program, 'uJourney'),
      uHueShift: gl.getUniformLocation(program, 'uHueShift'),
      uHueSpread: gl.getUniformLocation(program, 'uHueSpread'),
      uContrast: gl.getUniformLocation(program, 'uContrast'),
      uBrightness: gl.getUniformLocation(program, 'uBrightness'),
      uFlash: gl.getUniformLocation(program, 'uFlash'),
    }
  }

  getShaderSources(): ShaderStage[] {
    return [{ key: 'render-fs', label: 'Morphogen (render-fs)', source: this.renderSource }]
  }

  setShaderSource(key: string, source: string): void {
    const gl = this.gpu.gl
    switch (key) {
      case 'render-fs': {
        const program = this.gpu.compileProgram(FULLSCREEN_VS, source) // throws on GLSL error; old program untouched
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
