import { mulberry32 } from '../../core/prng'
import type { Gpu } from '../../gpu/context'
import { FullscreenPass, type RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'

/**
 * Cymatics — Chladni resonance plate. A standing-wave field whose nodal lines
 * (where the plate doesn't move, and where sand would collect) glow as bright
 * filigree, the antinodes dark between them. The pattern is a superposition of
 * a handful of plate eigenmodes with integer wavenumbers; as their amplitudes
 * breathe (slow LFOs + audio bands) the nodal lines migrate and reconnect, the
 * classic "dancing sand" look. A slow drift sweeps the whole field.
 *
 * Built to the SCENE CONTRACT (docs/SCENE_CONTRACT.md), like julia.ts:
 *  - render() is a PURE fullscreen fragment pass — a function of uniforms only,
 *    no trail, no feedback, no ping-pong. Re-rendering a frame is byte-identical.
 *  - All state (mode LFO phases, band envelopes, the drift offset) lives in
 *    update() and advances in SECONDS (frame.dt), so the plate resonates at the
 *    same rate per wall-second at 30/60/120fps — preview matches export.
 *  - Randomness is seeded once at init() (mulberry32): the mode wavenumbers,
 *    LFO rates/phases and drift direction are drawn from the scene seed, never
 *    per frame. The field itself is a pure function of position + those uniforms.
 *  - The plate field is defined everywhere, so it fills the whole canvas at any
 *    aspect (square cells; the long axis just shows more of the plate).
 */

const MODES = 5

const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`

const RENDER_FS = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uAspect, uScale, uSharpness, uHue, uBrightness, uFlash, uRot;
uniform vec2 uDrift;
uniform float uN[${MODES}];
uniform float uM[${MODES}];
uniform float uAmp[${MODES}];
out vec4 outColor;

const float PI = 3.14159265;

vec3 hsv2rgb(vec3 c){ vec4 K=vec4(1.,2./3.,1./3.,3.); vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www); return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y); }

void main(){
  // Aspect-fill: the shorter screen axis spans the plate; the longer axis shows
  // more plate (square cells, full-bleed at any aspect — the field is defined
  // everywhere, so there is no letterbox).
  vec2 uv = (gl_FragCoord.xy / uResolution) * 2.0 - 1.0;
  uv.x *= max(uAspect, 1.0);
  uv.y /= min(uAspect, 1.0);
  float cs = cos(uRot), sn = sin(uRot);
  uv = mat2(cs, -sn, sn, cs) * uv;      // Spin: slow plate rotation
  vec2 q = uv * uScale + uDrift;

  // Chladni superposition: each mode is the symmetric standing wave
  // sin(nπx)sin(mπy) + sin(mπx)sin(nπy). Nodes are where the sum crosses zero.
  float z = 0.0;
  float norm = 1e-3;
  for (int i = 0; i < ${MODES}; i++) {
    float a = uAmp[i];
    z += a * ( sin(uN[i]*PI*q.x) * sin(uM[i]*PI*q.y) + sin(uM[i]*PI*q.x) * sin(uN[i]*PI*q.y) );
    norm += abs(a) * 2.0;
  }
  float an = abs(z) / norm;               // 0 on the nodal lines, up to ~1 at antinodes

  // Sand collects on the nodes: bright thin lines where |z| ~ 0.
  float line = 1.0 - smoothstep(0.0, uSharpness, an);
  // Two-tone antinode fields (which side of the node), faintly lit.
  vec3 nodeCol = hsv2rgb(vec3(fract(uHue), 0.55, 1.0));
  vec3 fieldCol = hsv2rgb(vec3(fract(uHue + (z > 0.0 ? 0.5 : 0.42)), 0.7, 1.0));
  vec3 col = nodeCol * line + fieldCol * (an * 0.10 * (1.0 - line));

  col *= uBrightness * (1.0 + uFlash);
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`

// Envelope tuning (same exponential shapes used across the codebase).
const BAND_SMOOTH_RATE = 4.0
const FLASH_DECAY = 8.0
const FLASH_GAIN = 0.8
const FLASH_MAX = 2.0

interface RenderLocs {
  uResolution: WebGLUniformLocation | null
  uAspect: WebGLUniformLocation | null
  uScale: WebGLUniformLocation | null
  uSharpness: WebGLUniformLocation | null
  uHue: WebGLUniformLocation | null
  uBrightness: WebGLUniformLocation | null
  uFlash: WebGLUniformLocation | null
  uRot: WebGLUniformLocation | null
  uDrift: WebGLUniformLocation | null
  uN: WebGLUniformLocation | null
  uM: WebGLUniformLocation | null
  uAmp: WebGLUniformLocation | null
}

export class CymaticsScene implements SceneRuntime {
  meta = { id: 'cymatics', name: 'Cymatics', family: 'geometry' as const }

  params: ParamSchema[] = [
    { name: 'scale', label: 'Scale', min: 1.2, max: 8, default: 3.4 },
    { name: 'sharpness', label: 'Sharpness', min: 0.02, max: 0.3, default: 0.1 },
    // Morph is the big evolution driver: it wobbles the plate's wavenumbers off
    // their integer values over time, so the whole nodal figure continuously
    // reshapes rather than just breathing in brightness.
    { name: 'morph', label: 'Morph', min: 0, max: 1.2, default: 0.55 },
    { name: 'evolve', label: 'Evolve', min: 0, max: 3, default: 1 }, // master tempo for morph/spin/breath/drift
    { name: 'spin', label: 'Spin', min: 0, max: 1, default: 0.12 },
    { name: 'flow', label: 'Flow', min: 0, max: 1.2, default: 0.3 },
    { name: 'react', label: 'Audio', min: 0, max: 1.5, default: 0.7 },
    { name: 'hue', label: 'Hue', min: 0, max: 1, default: 0.55 },
    { name: 'brightness', label: 'Glow', min: 0.3, max: 2, default: 1 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu
  private fsPass!: FullscreenPass
  private renderProgram!: WebGLProgram
  private renderLoc!: RenderLocs

  // Seeded per-mode setup (fixed for the instance's life; drawn once at init).
  private modeN = new Float32Array(MODES)
  private modeM = new Float32Array(MODES)
  private baseAmp = new Float32Array(MODES)
  private lfoRate = new Float32Array(MODES)
  private morphRate = new Float32Array(MODES)

  // CPU state (all advanced ONLY in update(), all in seconds).
  private lfoPhase = new Float32Array(MODES)
  private morphPhase = new Float32Array(MODES)
  private amp = new Float32Array(MODES)
  private effN = new Float32Array(MODES) // wavenumbers after Morph wobble (per frame)
  private effM = new Float32Array(MODES)
  private spinPhase = 0
  private driftX = 0
  private driftY = 0
  private driftVX = 0
  private driftVY = 0
  private envBass = 0
  private envMid = 0
  private envHigh = 0
  private flash = 0

  private renderSource = RENDER_FS

  init(gpu: Gpu, seed: number): void {
    this.gpu = gpu
    for (const p of this.params) this.values.set(p.name, p.default)

    const rng = mulberry32(seed)
    for (let i = 0; i < MODES; i++) {
      let n = 1 + Math.floor(rng() * 5) // 1..5
      let m = 1 + Math.floor(rng() * 5)
      if (n === m) m = 1 + (m % 5) // asymmetric modes read as classic Chladni figures
      this.modeN[i] = n
      this.modeM[i] = m
      this.baseAmp[i] = 1 / (1 + i * 0.35) // higher modes contribute less
      this.lfoRate[i] = 0.15 + rng() * 0.5 // slow breathing, Hz-ish
      this.lfoPhase[i] = rng() * Math.PI * 2
      this.morphRate[i] = 0.12 + rng() * 0.3 // wavenumber-wobble rate (the Morph clock)
      this.morphPhase[i] = rng() * Math.PI * 2
    }
    const ang = rng() * Math.PI * 2
    this.driftVX = Math.cos(ang)
    this.driftVY = Math.sin(ang)
    this.spinPhase = 0
    this.driftX = 0
    this.driftY = 0
    this.envBass = 0
    this.envMid = 0
    this.envHigh = 0
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
    // Read-only introspection (never enumerated in `params`): lets the
    // frame-rate-independence spec assert the LFO phase advances the same amount
    // per wall-second at any fps — a direct probe of the dt-paced state.
    if (name === '#phase0') return this.lfoPhase[0]
    return this.values.get(name) ?? 0
  }

  update(ctx: FrameContext): void {
    const { frame, signals } = ctx
    const dt = frame.dt
    const a = 1 - Math.exp(-BAND_SMOOTH_RATE * dt)
    this.envBass += (signals.get('bass') - this.envBass) * a
    this.envMid += (signals.get('mid') - this.envMid) * a
    this.envHigh += (signals.get('high') - this.envHigh) * a
    this.flash = this.flash * Math.exp(-FLASH_DECAY * dt) + FLASH_GAIN * signals.get('onset')
    if (this.flash > FLASH_MAX) this.flash = FLASH_MAX

    const react = this.getParam('react')
    const evolve = this.getParam('evolve')
    const morph = this.getParam('morph')
    const edt = evolve * dt // master tempo scales every internal clock
    for (let i = 0; i < MODES; i++) {
      this.lfoPhase[i] += this.lfoRate[i] * edt
      this.morphPhase[i] += this.morphRate[i] * edt
      const breath = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(this.lfoPhase[i]))
      // Split the audio bands across the mode set: low modes ride the bass, the
      // middle ones the mids, the top the highs.
      const band = i < 2 ? this.envBass : i < 4 ? this.envMid : this.envHigh
      this.amp[i] = this.baseAmp[i] * breath + react * band * 0.8
      // Morph: wobble the wavenumbers off their integer values so the nodal
      // figure continuously reshapes (the two axes out of phase for asymmetry).
      this.effN[i] = this.modeN[i] + morph * Math.sin(this.morphPhase[i])
      this.effM[i] = this.modeM[i] + morph * Math.cos(this.morphPhase[i] * 1.3 + 0.7)
    }

    this.spinPhase += this.getParam('spin') * edt
    const flow = this.getParam('flow')
    this.driftX += this.driftVX * flow * edt
    this.driftY += this.driftVY * flow * edt
  }

  render(_ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)

    gl.useProgram(this.renderProgram)
    gl.uniform2f(this.renderLoc.uResolution, surface.width, surface.height)
    gl.uniform1f(this.renderLoc.uAspect, surface.width / surface.height)
    gl.uniform1f(this.renderLoc.uScale, this.getParam('scale'))
    gl.uniform1f(this.renderLoc.uSharpness, this.getParam('sharpness'))
    gl.uniform1f(this.renderLoc.uHue, this.getParam('hue'))
    gl.uniform1f(this.renderLoc.uBrightness, this.getParam('brightness'))
    gl.uniform1f(this.renderLoc.uFlash, this.flash)
    gl.uniform1f(this.renderLoc.uRot, this.spinPhase)
    gl.uniform2f(this.renderLoc.uDrift, this.driftX, this.driftY)
    gl.uniform1fv(this.renderLoc.uN, this.effN)
    gl.uniform1fv(this.renderLoc.uM, this.effM)
    gl.uniform1fv(this.renderLoc.uAmp, this.amp)
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
      uScale: gl.getUniformLocation(program, 'uScale'),
      uSharpness: gl.getUniformLocation(program, 'uSharpness'),
      uHue: gl.getUniformLocation(program, 'uHue'),
      uBrightness: gl.getUniformLocation(program, 'uBrightness'),
      uFlash: gl.getUniformLocation(program, 'uFlash'),
      uRot: gl.getUniformLocation(program, 'uRot'),
      uDrift: gl.getUniformLocation(program, 'uDrift'),
      uN: gl.getUniformLocation(program, 'uN'),
      uM: gl.getUniformLocation(program, 'uM'),
      uAmp: gl.getUniformLocation(program, 'uAmp'),
    }
  }

  getShaderSources(): ShaderStage[] {
    return [{ key: 'render-fs', label: 'Plate field (render-fs)', source: this.renderSource }]
  }

  setShaderSource(key: string, source: string): void {
    if (key !== 'render-fs') throw new Error(`Unknown shader stage "${key}" for scene "${this.meta.id}"`)
    const gl = this.gpu.gl
    const program = this.gpu.compileProgram(FULLSCREEN_VS, source) // throws on GLSL error; old program untouched
    gl.deleteProgram(this.renderProgram)
    this.renderProgram = program
    this.renderLoc = this.lookupRenderLocs(program)
    this.renderSource = source
  }
}
