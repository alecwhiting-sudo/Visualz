import { FloatTarget, FullscreenPass, type RenderSurface } from '../../gpu/targets'
import type { Gpu } from '../../gpu/context'
import { resampleToRGBA8 } from '../families/particles/imageSample'
import type { FrameContext, ParamSchema, SceneRuntime, SceneSnapshot, ShaderStage } from '../types'

/**
 * Geometry family: a kaleidoscope frame-feedback scene. State is two RGBA8
 * (not RGBA32F — a fixed-point color buffer suffices for a feedback loop, and
 * RGBA8 is cheaper) square targets ping-ponged every frame: each frame folds
 * the previous frame's image into `uSegments` mirrored wedges, spins/zooms it,
 * fades it, and injects a small seed pattern so the loop never fully decays to
 * black. A separate blit pass composes the (square) sim onto the actual
 * (possibly non-square) output surface.
 */

const SIM_SIZE = 512

// Attribute-less fullscreen triangle: standard gl_VertexID trick, no VBO needed.
const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`

// Feedback pass: sample the previous frame through a mirrored angular fold +
// spin + zoom, fade it, and additively inject a ring of deterministic
// hash-placed blobs (the "seed pattern" that keeps the loop alive). Combined
// into one pass/shader per the spec (fold+sample, then inject, in one draw).
const FEEDBACK_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform int uSegments;
uniform float uSpin, uZoomRate, uDecay, uInjectRadius, uInjectGain, uFlash, uHueShift;
out vec4 outColor;

uint hash32(uint x){ x=x+0x9e3779b9u; x^=x>>16u; x*=0x7feb352du; x^=x>>15u; x*=0x846ca68bu; x^=x>>16u; return x; }
vec3 hsv2rgb(vec3 c){ vec4 K=vec4(1.,2./3.,1./3.,3.); vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www); return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y); }

const int MAX_SEGMENTS = 16;
const float PI = 3.14159265359;
const float SIM_SIZE = ${SIM_SIZE.toFixed(1)};

void main(){
  vec2 p = (gl_FragCoord.xy / vec2(SIM_SIZE)) * 2.0 - 1.0;

  float rad = length(p);
  float ang = atan(p.y, p.x);
  float seg = (2.0 * PI) / float(uSegments);

  // Mirror-fold the angle into a single wedge [0, seg/2], then spin.
  float af = mod(ang, seg);
  if (af > seg * 0.5) af = seg - af;
  af += uSpin;

  // Zoom toward center: sample further out than the current pixel.
  vec2 folded = rad * vec2(cos(af), sin(af));
  vec2 sampleUv = (folded * uZoomRate) * 0.5 + 0.5;
  vec3 prev = texture(uSrc, sampleUv).rgb * uDecay;

  // Inject a deterministic ring of blobs, one per segment, that rotates with uSpin.
  vec3 inject = vec3(0.0);
  for (int i = 0; i < MAX_SEGMENTS; i++) {
    if (i >= uSegments) break;
    float h = float(hash32(uint(i) + 1013u)) / 4294967296.0;
    float blobAngle = (float(i) + 0.15 + h * 0.5) * seg + uSpin;
    vec2 blobPos = uInjectRadius * vec2(cos(blobAngle), sin(blobAngle));
    float d = length(p - blobPos);
    float glow = exp(-d * d * 40.0);
    vec3 hue = hsv2rgb(vec3(fract(uHueShift + float(i) / float(uSegments)), 0.85, 1.0));
    inject += hue * glow;
  }
  inject *= (uInjectGain + uFlash);

  outColor = vec4(prev + inject, 1.0);
}`

// Blit pass: min-axis-fit the square sim onto the (possibly non-square)
// output surface — same aspect convention as julia.ts's complex-plane fit.
// CLAMP_TO_EDGE on the sim texture handles the overflow on the longer axis.
const BLIT_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uResolution;
uniform float uAspect;
out vec4 outColor;
void main(){
  vec2 uv = (gl_FragCoord.xy / uResolution) * 2.0 - 1.0;
  uv.x *= max(uAspect, 1.0);
  uv.y /= min(uAspect, 1.0);
  vec2 suv = uv * 0.5 + 0.5;
  vec3 col = texture(uSrc, suv).rgb;
  col = pow(clamp(col, 0.0, 1.0), vec3(0.85)); // slight brightness curve
  outColor = vec4(col, 1.0);
}`

const FLASH_DECAY = 8.0
const FLASH_GAIN = 1.0
const FLASH_MAX = 3.0
const TAU = Math.PI * 2

interface FeedbackLocs {
  uSrc: WebGLUniformLocation | null
  uSegments: WebGLUniformLocation | null
  uSpin: WebGLUniformLocation | null
  uZoomRate: WebGLUniformLocation | null
  uDecay: WebGLUniformLocation | null
  uInjectRadius: WebGLUniformLocation | null
  uInjectGain: WebGLUniformLocation | null
  uFlash: WebGLUniformLocation | null
  uHueShift: WebGLUniformLocation | null
}

interface BlitLocs {
  uSrc: WebGLUniformLocation | null
  uResolution: WebGLUniformLocation | null
  uAspect: WebGLUniformLocation | null
}

export class KaleidoScene implements SceneRuntime {
  meta = { id: 'kaleido', name: 'Kaleidoscope', family: 'geometry' as const }

  params: ParamSchema[] = [
    { name: 'segments', label: 'Segments', min: 3, max: 16, default: 6, step: 1 },
    { name: 'spin', label: 'Spin', min: 0, max: 1, default: 0.12 },
    { name: 'zoomRate', label: 'Zoom rate', min: 0.95, max: 1.05, default: 1.008 },
    { name: 'decay', label: 'Decay', min: 0.9, max: 0.995, default: 0.93 },
    { name: 'injectRadius', label: 'Inject radius', min: 0.2, max: 0.9, default: 0.55 },
    { name: 'injectGain', label: 'Inject gain', min: 0, max: 2, default: 0.4 },
    { name: 'hueShift', label: 'Hue shift', min: 0, max: 1, default: 0.0 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu
  private fsPass!: FullscreenPass
  private feedbackProgram!: WebGLProgram
  private blitProgram!: WebGLProgram
  private feedbackLoc!: FeedbackLocs
  private blitLoc!: BlitLocs

  // Two rgba8 FloatTargets, manually ping-ponged (PingPong is rgba32f-only).
  private targets!: [FloatTarget, FloatTarget]
  private flip = false

  // CPU-only state: accumulated spin phase (pure dt accumulation, no wobble —
  // deterministic) and the onset flash envelope (same decay shape used
  // elsewhere in the particles/geometry families).
  private spinPhase = 0
  private flash = 0

  // Code layer (ARCHITECTURE.md §3.3): current source per editable stage,
  // reset to stock every init(). Uniform locations are cached, so a program
  // swap in setShaderSource must refresh them.
  private feedbackSource = FEEDBACK_FS
  private blitSource = BLIT_FS

  private get src(): FloatTarget {
    return this.flip ? this.targets[1] : this.targets[0]
  }

  private get dst(): FloatTarget {
    return this.flip ? this.targets[0] : this.targets[1]
  }

  init(gpu: Gpu, _seed: number): void {
    this.gpu = gpu
    for (const p of this.params) this.values.set(p.name, p.default)

    this.spinPhase = 0
    this.flash = 0
    this.flip = false

    this.feedbackSource = FEEDBACK_FS
    this.blitSource = BLIT_FS

    const gl = gpu.gl
    const a = new FloatTarget(gpu, SIM_SIZE, undefined, 'rgba8')
    const b = new FloatTarget(gpu, SIM_SIZE, undefined, 'rgba8')
    // texStorage2D leaves rgba8 storage uninitialized (no `initial` upload
    // path for that format) — clear both explicitly so the feedback loop
    // starts from a deterministic black frame, not driver-dependent garbage.
    for (const t of [a, b]) {
      t.bindTarget()
      gl.clearColor(0, 0, 0, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
    this.targets = [a, b]

    this.fsPass = new FullscreenPass(gpu)
    this.feedbackProgram = gpu.compileProgram(FULLSCREEN_VS, this.feedbackSource)
    this.blitProgram = gpu.compileProgram(FULLSCREEN_VS, this.blitSource)
    this.feedbackLoc = this.lookupFeedbackLocs(this.feedbackProgram)
    this.blitLoc = this.lookupBlitLocs(this.blitProgram)

    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  /**
   * Scene handoff (docs/HANDOFF.md §2): primes the feedback loop — A's frame
   * is literally what the kaleidoscope starts folding. Resamples the snapshot
   * to the sim's square resolution and uploads it into BOTH ping-pong
   * targets (so the very first feedback pass reads *something* meaningful
   * regardless of which one `src`/`dst` resolve to), resetting `flip`.
   */
  ingest(snap: SceneSnapshot): void {
    const rgba = resampleToRGBA8(snap, SIM_SIZE, SIM_SIZE)
    this.targets[0].upload(rgba)
    this.targets[1].upload(rgba)
    this.flip = false
  }

  setParam(name: string, value: number): void {
    this.values.set(name, value)
  }

  getParam(name: string): number {
    return this.values.get(name) ?? 0
  }

  update(ctx: FrameContext): void {
    const { frame, signals } = ctx
    const gl = this.gpu.gl

    const bass = signals.get('bass')
    const onset = signals.get('onset')

    this.flash = this.flash * Math.exp(-FLASH_DECAY * frame.dt) + FLASH_GAIN * onset
    if (this.flash > FLASH_MAX) this.flash = FLASH_MAX

    this.spinPhase = (this.spinPhase + this.getParam('spin') * frame.dt) % TAU

    const segments = Math.max(3, Math.round(this.getParam('segments')))
    const injectGain = this.getParam('injectGain') * (0.5 + bass)

    this.dst.bindTarget()
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)
    gl.useProgram(this.feedbackProgram)
    this.src.bindTexture(0)
    gl.uniform1i(this.feedbackLoc.uSrc, 0)
    gl.uniform1i(this.feedbackLoc.uSegments, segments)
    gl.uniform1f(this.feedbackLoc.uSpin, this.spinPhase)
    gl.uniform1f(this.feedbackLoc.uZoomRate, this.getParam('zoomRate'))
    gl.uniform1f(this.feedbackLoc.uDecay, this.getParam('decay'))
    gl.uniform1f(this.feedbackLoc.uInjectRadius, this.getParam('injectRadius'))
    gl.uniform1f(this.feedbackLoc.uInjectGain, injectGain)
    gl.uniform1f(this.feedbackLoc.uFlash, this.flash)
    gl.uniform1f(this.feedbackLoc.uHueShift, this.getParam('hueShift'))
    this.fsPass.draw()

    this.flip = !this.flip
  }

  render(_ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)

    gl.useProgram(this.blitProgram)
    this.src.bindTexture(0)
    gl.uniform1i(this.blitLoc.uSrc, 0)
    gl.uniform2f(this.blitLoc.uResolution, surface.width, surface.height)
    gl.uniform1f(this.blitLoc.uAspect, surface.width / surface.height)
    this.fsPass.draw()
  }

  resize(width: number, height: number): void {
    this.gpu.resize(width, height)
    this.gpu.gl.clearColor(0, 0, 0, 1)
    this.gpu.gl.clear(this.gpu.gl.COLOR_BUFFER_BIT)
  }

  dispose(): void {
    const gl = this.gpu.gl
    gl.deleteProgram(this.feedbackProgram)
    gl.deleteProgram(this.blitProgram)
    this.fsPass.dispose()
    this.targets[0].dispose()
    this.targets[1].dispose()
  }

  private lookupFeedbackLocs(program: WebGLProgram): FeedbackLocs {
    const gl = this.gpu.gl
    return {
      uSrc: gl.getUniformLocation(program, 'uSrc'),
      uSegments: gl.getUniformLocation(program, 'uSegments'),
      uSpin: gl.getUniformLocation(program, 'uSpin'),
      uZoomRate: gl.getUniformLocation(program, 'uZoomRate'),
      uDecay: gl.getUniformLocation(program, 'uDecay'),
      uInjectRadius: gl.getUniformLocation(program, 'uInjectRadius'),
      uInjectGain: gl.getUniformLocation(program, 'uInjectGain'),
      uFlash: gl.getUniformLocation(program, 'uFlash'),
      uHueShift: gl.getUniformLocation(program, 'uHueShift'),
    }
  }

  private lookupBlitLocs(program: WebGLProgram): BlitLocs {
    const gl = this.gpu.gl
    return {
      uSrc: gl.getUniformLocation(program, 'uSrc'),
      uResolution: gl.getUniformLocation(program, 'uResolution'),
      uAspect: gl.getUniformLocation(program, 'uAspect'),
    }
  }

  getShaderSources(): ShaderStage[] {
    return [
      { key: 'feedback-fs', label: 'Feedback fold (feedback-fs)', source: this.feedbackSource },
      { key: 'blit-fs', label: 'Screen blit (blit-fs)', source: this.blitSource },
    ]
  }

  setShaderSource(key: string, source: string): void {
    const gl = this.gpu.gl
    switch (key) {
      case 'feedback-fs': {
        const program = this.gpu.compileProgram(FULLSCREEN_VS, source) // throws on GLSL error; old program untouched
        gl.deleteProgram(this.feedbackProgram)
        this.feedbackProgram = program
        this.feedbackLoc = this.lookupFeedbackLocs(program)
        this.feedbackSource = source
        return
      }
      case 'blit-fs': {
        const program = this.gpu.compileProgram(FULLSCREEN_VS, source)
        gl.deleteProgram(this.blitProgram)
        this.blitProgram = program
        this.blitLoc = this.lookupBlitLocs(program)
        this.blitSource = source
        return
      }
      default:
        throw new Error(`Unknown shader stage "${key}" for scene "${this.meta.id}"`)
    }
  }
}
