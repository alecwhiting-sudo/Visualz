import type { Gpu } from '../../gpu/context'
import { FloatTarget, FullscreenPass, type RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'

/**
 * Geometry family: a polar "tunnel" flying through a 512-frame ring history
 * of the audio bands (bass/mid/high/rms). Mostly GPU-stateless like julia.ts
 * (one fullscreen fragment pass reading uniforms), but with one piece of
 * persistent GPU state: a 512x1 RGBA32F history texture that `update()`
 * writes one texel into per frame — the ring buffer the tunnel's polar
 * distance-to-depth mapping samples into.
 */

const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`

const HISTORY_SIZE = 512

const RENDER_FS = `#version 300 es
precision highp float;
uniform sampler2D uHistory;
uniform vec2 uResolution;
uniform float uAspect, uTime;
uniform float uSpeed, uTwist, uRingsBack, uHueShift, uBrightness, uFlash;
uniform int uRings, uSpokes, uFrame;
out vec4 outColor;

const float TUBE_RADIUS = 0.35;
const float ROT_SPEED = 0.15;

vec3 hsv2rgb(vec3 c){ vec4 K=vec4(1.,2./3.,1./3.,3.); vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www); return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y); }

void main(){
  vec2 uv = (gl_FragCoord.xy / uResolution) * 2.0 - 1.0;
  uv.x *= max(uAspect, 1.0);
  uv.y /= min(uAspect, 1.0);
  vec2 p = uv;

  float rad = length(p);
  float a = atan(p.y, p.x);
  float invR = TUBE_RADIUS / max(rad, 1e-4);
  float depth = invR + uTime * uSpeed;

  int idx = int(mod(float(uFrame) - depth * uRingsBack, 512.0));
  vec4 hist = texelFetch(uHistory, ivec2(idx, 0), 0);
  float bassVal = hist.r, midVal = hist.g, highVal = hist.b, rmsVal = hist.a;

  float rr = rad * (1.0 - 0.25 * bassVal);
  float invR2 = TUBE_RADIUS / max(rr, 1e-4);
  float depth2 = invR2 + uTime * uSpeed;

  float hue = fract(uHueShift + midVal * 0.3 + depth2 * 0.05);
  float band = sin(depth2 * float(uRings));
  float brightness = band * band * (0.3 + rmsVal) * exp(-rad * 0.6);

  float aTw = a + depth2 * uTwist + uTime * ROT_SPEED;
  brightness *= 0.75 + 0.25 * sin(aTw * float(uSpokes) + depth2);
  brightness *= uBrightness * (1.0 + uFlash);

  vec3 col = hsv2rgb(vec3(hue, 0.75 + 0.2 * highVal, clamp(brightness, 0.0, 1.0)));
  outColor = vec4(col, 1.0);
}`

const FLASH_DECAY = 8.0
const FLASH_GAIN = 1.0
const FLASH_MAX = 3.0

interface RenderLocs {
  uHistory: WebGLUniformLocation | null
  uResolution: WebGLUniformLocation | null
  uAspect: WebGLUniformLocation | null
  uTime: WebGLUniformLocation | null
  uSpeed: WebGLUniformLocation | null
  uTwist: WebGLUniformLocation | null
  uRingsBack: WebGLUniformLocation | null
  uHueShift: WebGLUniformLocation | null
  uBrightness: WebGLUniformLocation | null
  uFlash: WebGLUniformLocation | null
  uRings: WebGLUniformLocation | null
  uSpokes: WebGLUniformLocation | null
  uFrame: WebGLUniformLocation | null
}

export class TunnelScene implements SceneRuntime {
  meta = { id: 'tunnel', name: 'Audio Tunnel', family: 'geometry' as const }

  params: ParamSchema[] = [
    { name: 'speed', label: 'Speed', min: 0.2, max: 3, default: 1.0 },
    { name: 'twist', label: 'Twist', min: 0, max: 2, default: 0.5 },
    { name: 'rings', label: 'Rings', min: 2, max: 20, default: 8, step: 1 },
    { name: 'spokes', label: 'Spokes', min: 0, max: 12, default: 6, step: 1 },
    { name: 'ringsBack', label: 'Rings back', min: 20, max: 200, default: 90 },
    { name: 'hueShift', label: 'Hue shift', min: 0, max: 1, default: 0.85 },
    { name: 'brightness', label: 'Brightness', min: 0.3, max: 2, default: 1 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu
  private fsPass!: FullscreenPass
  private renderProgram!: WebGLProgram
  private renderLoc!: RenderLocs

  // Persistent GPU state: a 512x1 RGBA32F ring buffer of (bass, mid, high,
  // rms) history, one texel written per frame in update(). Constructed with
  // no `initial` array — FloatTarget's rgba32f branch defaults to a fresh
  // zero-filled Float32Array, which is exactly "clear to zeros" with no
  // extra code needed here.
  private historyTex!: FloatTarget

  private flash = 0

  private renderSource = RENDER_FS

  // seed is unused: the tunnel has no CPU-side randomness (its variation
  // comes entirely from the deterministic audio-feature history), but the
  // param is kept for interface conformance with SceneRuntime — same
  // `_seed`-prefix convention as kaleido.ts's init().
  init(gpu: Gpu, _seed: number): void {
    this.gpu = gpu
    for (const p of this.params) this.values.set(p.name, p.default)

    this.flash = 0

    this.renderSource = RENDER_FS

    const gl = gpu.gl
    this.fsPass = new FullscreenPass(gpu)
    this.renderProgram = gpu.compileProgram(FULLSCREEN_VS, this.renderSource)
    this.renderLoc = this.lookupRenderLocs(this.renderProgram)

    this.historyTex?.dispose()
    this.historyTex = new FloatTarget(gpu, { width: HISTORY_SIZE, height: 1 })

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
    const mid = signals.get('mid')
    const high = signals.get('high')
    const rms = signals.get('rms')
    const onset = signals.get('onset')

    this.flash = this.flash * Math.exp(-FLASH_DECAY * frame.dt) + FLASH_GAIN * onset
    if (this.flash > FLASH_MAX) this.flash = FLASH_MAX

    // Transport frame count (not a private incrementing counter) so replay
    // and export land on the identical ring texel deterministically.
    const writeHead = frame.frame % HISTORY_SIZE
    const gl = this.gpu.gl
    gl.bindTexture(gl.TEXTURE_2D, this.historyTex.texture)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, writeHead, 0, 1, 1, gl.RGBA, gl.FLOAT, new Float32Array([bass, mid, high, rms]))
    gl.bindTexture(gl.TEXTURE_2D, null)
  }

  render(ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)

    gl.useProgram(this.renderProgram)
    this.historyTex.bindTexture(0)
    gl.uniform1i(this.renderLoc.uHistory, 0)
    gl.uniform2f(this.renderLoc.uResolution, surface.width, surface.height)
    gl.uniform1f(this.renderLoc.uAspect, surface.width / surface.height)
    gl.uniform1f(this.renderLoc.uTime, ctx.frame.time)
    gl.uniform1f(this.renderLoc.uSpeed, this.getParam('speed'))
    gl.uniform1f(this.renderLoc.uTwist, this.getParam('twist'))
    gl.uniform1f(this.renderLoc.uRingsBack, this.getParam('ringsBack'))
    gl.uniform1f(this.renderLoc.uHueShift, this.getParam('hueShift'))
    gl.uniform1f(this.renderLoc.uBrightness, this.getParam('brightness'))
    gl.uniform1f(this.renderLoc.uFlash, this.flash)
    gl.uniform1i(this.renderLoc.uRings, Math.round(this.getParam('rings')))
    gl.uniform1i(this.renderLoc.uSpokes, Math.round(this.getParam('spokes')))
    gl.uniform1i(this.renderLoc.uFrame, ctx.frame.frame)
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
    this.historyTex.dispose()
  }

  private lookupRenderLocs(program: WebGLProgram): RenderLocs {
    const gl = this.gpu.gl
    return {
      uHistory: gl.getUniformLocation(program, 'uHistory'),
      uResolution: gl.getUniformLocation(program, 'uResolution'),
      uAspect: gl.getUniformLocation(program, 'uAspect'),
      uTime: gl.getUniformLocation(program, 'uTime'),
      uSpeed: gl.getUniformLocation(program, 'uSpeed'),
      uTwist: gl.getUniformLocation(program, 'uTwist'),
      uRingsBack: gl.getUniformLocation(program, 'uRingsBack'),
      uHueShift: gl.getUniformLocation(program, 'uHueShift'),
      uBrightness: gl.getUniformLocation(program, 'uBrightness'),
      uFlash: gl.getUniformLocation(program, 'uFlash'),
      uRings: gl.getUniformLocation(program, 'uRings'),
      uSpokes: gl.getUniformLocation(program, 'uSpokes'),
      uFrame: gl.getUniformLocation(program, 'uFrame'),
    }
  }

  getShaderSources(): ShaderStage[] {
    return [{ key: 'render-fs', label: 'Tunnel (render-fs)', source: this.renderSource }]
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
