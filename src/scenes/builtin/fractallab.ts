import type { Gpu } from '../../gpu/context'
import { FullscreenPass, type RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'

/**
 * Geometry family: "the fractal whose EQUATION is on knobs" — a generalized
 * Julia/Mandelbrot hybrid where the iteration itself (complex power, the
 * Burning-Ship-style abs-fold, and the Julia<->Mandelbrot blend) is exposed as
 * macro knobs rather than baked in. GPU-stateless like julia.ts/mandeldive.ts:
 * one fullscreen fragment pass, pure function of uniforms every frame; all
 * persistent state (bass follower, onset nudge) lives on the CPU in update().
 *
 * Iteration: z' = P(mix(z, abs(z), absMix)) + c, where P(w) = w^power via
 * polar form (r^p, theta*p) and c = mix(pixelPlanePoint, cRadius*(cos
 * cAngle, sin cAngle), juliaMix). juliaMix=1 (default) is a plain Julia set
 * (c fixed, z0 = pixel); juliaMix=0 makes c track the pixel itself, a
 * Mandelbrot-flavored limit (z0 is still the pixel here, not 0 — matching
 * julia.ts's z0=p convention rather than mandeldive.ts's z0=0, since the task
 * only specifies the c-blend, not a z0 override; documented as a deliberate
 * choice). absMix=0 is the standard iteration; absMix=1 folds z into its
 * component-wise abs before the power, the Burning-Ship family of forms.
 */

const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`

// ITER=100 per spec ("~100 iterations with early escape"); dropped to 80 only
// if a golden-frame SwiftShader readback exceeds ~5s (see fractallab.spec.ts's
// perf note — measured comfortably under that budget at ITER=100, so this
// stays at the spec's default).
const RENDER_FS = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uAspect, uZoom;
uniform float uPower, uAbsMix, uJuliaMix, uCRadius, uCAngle, uHueShift;
out vec4 outColor;

vec3 hsv2rgb(vec3 c){ vec4 K=vec4(1.,2./3.,1./3.,3.); vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www); return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y); }

const int ITER = 100;
const float ESCAPE_R = 100.0;
const float ESCAPE_R2 = ESCAPE_R * ESCAPE_R;
const float HUE_SPREAD = 0.85;

// Complex power via polar form: w^p = r^p * (cos(p*theta), sin(p*theta)).
// max(r, 1e-8) guards pow()'s undefined behavior at base 0 with a non-integer
// exponent ("handle r=0" per spec) without perturbing any visible pixel.
vec2 cpow(vec2 w, float p) {
  float r = length(w);
  float theta = atan(w.y, w.x);
  float rp = pow(max(r, 1e-8), p);
  float tp = theta * p;
  return rp * vec2(cos(tp), sin(tp));
}

void main(){
  // Min-axis-fit complex plane, same convention as julia.ts/mandeldive.ts:
  // the shorter screen axis spans [-1.5, 1.5] * uZoom.
  vec2 uv = (gl_FragCoord.xy / uResolution) * 2.0 - 1.0;
  uv.x *= max(uAspect, 1.0);
  uv.y /= min(uAspect, 1.0);
  vec2 p = uv * 1.5 * uZoom;

  vec2 cFixed = uCRadius * vec2(cos(uCAngle), sin(uCAngle));
  vec2 c = mix(p, cFixed, uJuliaMix);

  vec2 z = p;
  float smoothN = float(ITER);
  bool escaped = false;
  for (int i = 0; i < ITER; i++) {
    vec2 w = mix(z, abs(z), uAbsMix);
    z = cpow(w, uPower) + c;
    float m2 = dot(z, z);
    if (m2 > ESCAPE_R2) {
      // Generalized (log-log) smooth escape count: the p=2-specific
      // "log2(log(|z|))" trick used elsewhere in this codebase (julia.ts,
      // mandeldive.ts) generalizes to arbitrary power p via
      // nu = log(log|z|/log(bailout)) / log(p) (Douady-Hubbard potential).
      float logZn = log(m2) * 0.5; // = log|z|
      float nu = log(logZn / log(ESCAPE_R)) / log(uPower);
      smoothN = float(i) + 1.0 - nu;
      escaped = true;
      break;
    }
  }

  // Escape-gradient shading: interior (never escaped) stays dark; hueShift
  // rotates the palette along the escape gradient, same shape as julia.ts.
  float t = clamp(smoothN / float(ITER), 0.0, 1.0);
  float hue = fract(uHueShift + pow(t, 0.6) * HUE_SPREAD);
  float glow = 0.06 + pow(t, 0.85) * 1.6;
  vec3 col = escaped ? hsv2rgb(vec3(hue, 0.78, clamp(glow, 0.0, 1.0))) : vec3(0.0);
  outColor = vec4(col, 1.0);
}`

// Envelope tuning: bass smoothing rate (matches julia.ts's), and the onset
// cAngle nudge decay/gain/max — a small, decaying kick to the effective angle
// on each onset (spec: "CPU envelope like flowfield's pulse", scaled down
// from flowfield's raw pulse magnitude since a full-radian swing would read
// as a scene-switch rather than a "nudge").
const BASS_SMOOTH_RATE = 3.0
const NUDGE_DECAY = 6.0
const NUDGE_GAIN = 0.12
const NUDGE_MAX = 0.35

interface RenderLocs {
  uResolution: WebGLUniformLocation | null
  uAspect: WebGLUniformLocation | null
  uZoom: WebGLUniformLocation | null
  uPower: WebGLUniformLocation | null
  uAbsMix: WebGLUniformLocation | null
  uJuliaMix: WebGLUniformLocation | null
  uCRadius: WebGLUniformLocation | null
  uCAngle: WebGLUniformLocation | null
  uHueShift: WebGLUniformLocation | null
}

export class FractalLabScene implements SceneRuntime {
  meta = { id: 'fractallab', name: 'Fractal Lab', family: 'geometry' as const }

  // Schema order matters (spec: "first 8 drive macro knobs positionally") —
  // this is the full param set, in the order given by the task.
  params: ParamSchema[] = [
    { name: 'power', label: 'Power', min: 1.5, max: 8, default: 2, step: 0.1 },
    { name: 'absMix', label: 'Abs mix', min: 0, max: 1, default: 0 },
    { name: 'juliaMix', label: 'Julia mix', min: 0, max: 1, default: 1 },
    { name: 'cRadius', label: 'C radius', min: 0, max: 1.5, default: 0.78 },
    { name: 'cAngle', label: 'C angle', min: 0, max: 6.283, default: 2.2 },
    { name: 'zoom', label: 'Zoom', min: 0.5, max: 3, default: 1 },
    // hueShift's default isn't specified by the task; 0.6 chosen (like
    // julia.ts's 0.7) so the default palette isn't a flat red (hue 0).
    { name: 'hueShift', label: 'Hue shift', min: 0, max: 1, default: 0.6 },
    { name: 'reactivity', label: 'Reactivity', min: 0, max: 2, default: 1 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu
  private fsPass!: FullscreenPass
  private renderProgram!: WebGLProgram
  private renderLoc!: RenderLocs

  // CPU-only state (ARCHITECTURE.md §1): exp-smoothed bass follower and the
  // onset-driven cAngle nudge, both advanced by frame.dt only.
  private smoothedBass = 0
  private angleNudge = 0

  private renderSource = RENDER_FS

  // seed is unused: nothing here needs seeded randomness (the fractal is a
  // pure function of params/audio), but kept for interface conformance —
  // same `_seed`-prefix convention as tunnel.ts/kaleido.ts's init().
  init(gpu: Gpu, _seed: number): void {
    this.gpu = gpu
    for (const p of this.params) this.values.set(p.name, p.default)

    this.smoothedBass = 0
    this.angleNudge = 0

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

    const a = 1 - Math.exp(-BASS_SMOOTH_RATE * frame.dt)
    this.smoothedBass += (bass - this.smoothedBass) * a

    this.angleNudge = this.angleNudge * Math.exp(-NUDGE_DECAY * frame.dt) + NUDGE_GAIN * onset
    if (this.angleNudge > NUDGE_MAX) this.angleNudge = NUDGE_MAX
  }

  render(_ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)

    const reactivity = this.getParam('reactivity')
    const cRadiusEff = this.getParam('cRadius') * (1 + reactivity * 0.25 * (this.smoothedBass - 0.3))
    const cAngleEff = this.getParam('cAngle') + this.angleNudge

    gl.useProgram(this.renderProgram)
    gl.uniform2f(this.renderLoc.uResolution, surface.width, surface.height)
    gl.uniform1f(this.renderLoc.uAspect, surface.width / surface.height)
    gl.uniform1f(this.renderLoc.uZoom, this.getParam('zoom'))
    gl.uniform1f(this.renderLoc.uPower, this.getParam('power'))
    gl.uniform1f(this.renderLoc.uAbsMix, this.getParam('absMix'))
    gl.uniform1f(this.renderLoc.uJuliaMix, this.getParam('juliaMix'))
    gl.uniform1f(this.renderLoc.uCRadius, cRadiusEff)
    gl.uniform1f(this.renderLoc.uCAngle, cAngleEff)
    gl.uniform1f(this.renderLoc.uHueShift, this.getParam('hueShift'))
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
      uZoom: gl.getUniformLocation(program, 'uZoom'),
      uPower: gl.getUniformLocation(program, 'uPower'),
      uAbsMix: gl.getUniformLocation(program, 'uAbsMix'),
      uJuliaMix: gl.getUniformLocation(program, 'uJuliaMix'),
      uCRadius: gl.getUniformLocation(program, 'uCRadius'),
      uCAngle: gl.getUniformLocation(program, 'uCAngle'),
      uHueShift: gl.getUniformLocation(program, 'uHueShift'),
    }
  }

  getShaderSources(): ShaderStage[] {
    return [{ key: 'render-fs', label: 'Fractal (render-fs)', source: this.renderSource }]
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
