import type { Gpu } from '../../gpu/context'
import { FullscreenPass, type RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'

/**
 * Geometry family wildcard: a Poincare-disk hyperbolic {p,q} tiling — regular
 * p-gons, q meeting at every vertex, repeating infinitely as they shrink
 * toward the disk rim. GPU-stateless like fractallab.ts/resonance.ts: one
 * fullscreen fragment pass, pure function of uniforms every frame; all
 * persistent state (rotation phase, drift phase, bass-breath envelope, onset
 * flash envelope) lives on the CPU in update().
 *
 * Maths: the classic (2,p,q) triangle-group fold. A regular {p,q} tiling's
 * fundamental domain is the right triangle O-M-V, where O is the tiling
 * center, M is an edge midpoint (angle pi/p at O), and V is a polygon vertex
 * (right angle at M, angle pi/q at V). Hyperbolic right-triangle identities
 * give the two hyperbolic side lengths in closed form:
 *   cosh(OV) = cot(pi/p) * cot(pi/q)              (circumradius, unused here)
 *   cosh(OM) = cos(pi/q) / sin(pi/p)               (apothem)
 * Converting the apothem to a Euclidean Poincare-disk distance via
 * tanh(d/2) = sqrt((cosh(d)-1)/(cosh(d)+1)) gives `ae`, the Euclidean
 * distance from the origin to M along the positive x-axis. M is the closest
 * point of the tiling-edge geodesic to the origin; that geodesic is
 * represented in the disk by a circular arc orthogonal to the unit circle,
 * i.e. a circle centered at (c, 0) with radius r satisfying c - r = ae (M is
 * its closest point to O) and c^2 = r^2 + 1 (orthogonality) — solved in
 * `mirrorCircle()` below and handed to the shader as uMirrorC/uMirrorR.
 *
 * The fragment shader then repeatedly (a) mirror-folds the angle into the
 * p-line wedge [0, pi/p] (same trick as kaleido.ts's angular fold, generalized
 * from "uSegments" to "p") and (b) inverts across that one mirror circle
 * whenever the point falls inside it — exactly the group action of the
 * (2,p,q) triangle group. The flip parity gives a two-tone checkerboard "for
 * free"; the minimum distance-to-any-mirror seen along the way, combined with
 * a deterministic (non-fwidth) pixel-width estimate, gives anti-aliased tile
 * borders without sacrificing frame-exact replay determinism.
 *
 * Hyperbolic tiling requires 1/p + 1/q < 1/2 (otherwise the {p,q} symbol is
 * Euclidean, spherical, or degenerate). `clampPQ()` guards this: an invalid
 * knob combo (e.g. p=4,q=4, the Euclidean square tiling) is walked to the
 * nearest LARGER valid q internally for the maths (increasing q is always the
 * fix-able direction — decreasing it only makes 1/p+1/q bigger) without ever
 * mutating the stored param value, so no crash/NaN and the knob still reads
 * back exactly what the user set.
 */

const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`

const RENDER_FS = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uAspect;
uniform float uZoom, uP, uMirrorC, uMirrorR, uRotation;
uniform vec2 uDriftA;
uniform float uHue, uGlowAmt, uFlash, uContrast;
out vec4 outColor;

const float TAU = 6.28318530718;
const int FOLD_ITER = 28;

vec3 hsv2rgb(vec3 c){ vec4 K=vec4(1.,2./3.,1./3.,3.); vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www); return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y); }

vec2 cMul(vec2 a, vec2 b) { return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
vec2 cDiv(vec2 a, vec2 b) { float d = max(dot(b,b), 1e-8); return vec2(a.x*b.x + a.y*b.y, a.y*b.x - a.x*b.y) / d; }

// Poincare-disk translation by "a" (a hyperbolic isometry, disk-to-disk):
// drags the origin to "a". Used to slowly translate the whole tiling so
// geometry appears to flow/regress toward the rim, instead of literally
// zooming the camera in.
vec2 mobiusTranslate(vec2 z, vec2 a) {
  vec2 num = z - a;
  vec2 den = vec2(1.0, 0.0) - cMul(vec2(a.x, -a.y), z);
  return cDiv(num, den);
}

// Fold a disk point into the {p,q} tiling's fundamental (2,p,q) triangle:
// alternately mirror the angle into the p-line wedge [0, pi/p] and invert
// across the tiling-edge circle (uMirrorC, uMirrorR) whenever the point falls
// inside it. "parity" (mod 2) is the total flip count — the (2,p,q) triangle
// group's checkerboard coloring "for free". "edgeDist" is the smallest
// distance to any mirror crossed along the way, an orbit-trap-style proxy for
// "distance to the nearest tile edge" used for antialiasing.
void foldTile(vec2 z0, out int parity, out float edgeDist) {
  vec2 z = z0;
  int par = 0;
  float minEdge = 1e9;
  float seg = TAU / uP;
  float segHalf = seg * 0.5;
  for (int i = 0; i < FOLD_ITER; i++) {
    float rad = length(z);
    float ang = atan(z.y, z.x);

    float m = mod(ang, segHalf);
    minEdge = min(minEdge, rad * min(m, segHalf - m));

    float a2 = mod(ang, seg);
    if (a2 > segHalf) { a2 = seg - a2; par += 1; }
    z = rad * vec2(cos(a2), sin(a2));

    vec2 d = z - vec2(uMirrorC, 0.0);
    float d2 = max(dot(d, d), 1e-8);
    float distC = sqrt(d2);
    minEdge = min(minEdge, abs(distC - uMirrorR));

    if (distC < uMirrorR) {
      z = vec2(uMirrorC, 0.0) + (uMirrorR * uMirrorR / d2) * d;
      par += 1;
    }
  }
  parity = par;
  edgeDist = minEdge;
}

void main(){
  // Min-axis-fit unit disk, same convention as fractallab.ts/resonance.ts.
  vec2 uv = (gl_FragCoord.xy / uResolution) * 2.0 - 1.0;
  uv.x *= max(uAspect, 1.0);
  uv.y /= min(uAspect, 1.0);

  float cr = cos(uRotation), sr = sin(uRotation);
  vec2 p = uv / max(uZoom, 1e-3);
  p = vec2(p.x * cr - p.y * sr, p.x * sr + p.y * cr);

  float rimDist = length(p) - 1.0;
  if (rimDist > 0.0) {
    // Outside the disk: a soft dark halo rather than hard black.
    float halo = exp(-rimDist * 5.0) * (0.05 + 0.12 * uGlowAmt);
    vec3 haloCol = hsv2rgb(vec3(fract(uHue + 0.58), 0.55, halo));
    outColor = vec4(haloCol, 1.0);
    return;
  }

  vec2 z = mobiusTranslate(p, uDriftA);
  // The translate is a proper disk automorphism, but float error can nudge a
  // point already right at the rim just past |z|=1; the fold assumes a
  // closed disk, so clamp defensively.
  float zr = length(z);
  if (zr > 0.999999) z *= 0.999999 / zr;

  int parity;
  float edgeDist;
  foldTile(z, parity, edgeDist);

  // Anti-alias width for the tile borders. Deliberately NOT fwidth(edgeDist):
  // screen-space derivatives through a 28-iteration branchy fold are not
  // guaranteed bit-stable run-to-run on a software rasterizer (confirmed by
  // hand — fwidth() here broke the byte-identical-replay determinism this
  // whole app depends on), so this is a fully deterministic, uniform/
  // fragCoord-only estimate of one screen pixel's width in fold-space
  // instead: the shorter-axis pixel size divided by zoom (the same practical
  // "fixed epsilon in iterated space" AA used by orbit-trap-style fractal
  // shaders, rather than physically exact per-tile AA).
  float aa = (1.6 / min(uResolution.x, uResolution.y)) / max(uZoom, 1e-3) + 1e-4;
  float edgeGlow = 1.0 - smoothstep(0.0, aa, edgeDist);

  // Hyperbolic distance from the tiling center (Poincare-disk to hyperbolic
  // conversion): grows without bound toward the rim, giving a slow color
  // drift that visually reinforces the infinite regression.
  float distHyp = atanh(clamp(length(z), 0.0, 0.9995)) * 2.0;
  float tone = mod(float(parity), 2.0);
  float hue = fract(uHue + tone * 0.5 + distHyp * 0.015);
  float sat = 0.75;
  float val = mix(0.12, 0.32, tone);
  val += edgeGlow * (0.5 + uGlowAmt * 1.2 + uFlash * 1.5);

  vec3 col = hsv2rgb(vec3(hue, sat, clamp(val, 0.0, 1.0)));
  col = clamp((col - 0.5) * uContrast + 0.5, 0.0, 1.0);
  outColor = vec4(col, 1.0);
}`

// Envelope/motion tuning, same idiom as fractallab.ts/kaleido.ts's tuning
// blocks: exp-smoothed bass -> zoom "breath", decaying onset -> edge flash,
// dt-accumulated rotation/drift phases.
const BASS_SMOOTH_RATE = 3.0
const BREATH_GAIN = 0.35
const FLASH_DECAY = 6.0
const FLASH_GAIN = 1.0
const FLASH_MAX = 2.0
const SPIN_RATE = 0.6
const BEAT_NUDGE = 0.15
const DRIFT_RATE = 0.25
const DRIFT_RADIUS = 0.5 // < 1: keeps the Mobius drift center strictly inside the disk

interface RenderLocs {
  uResolution: WebGLUniformLocation | null
  uAspect: WebGLUniformLocation | null
  uZoom: WebGLUniformLocation | null
  uP: WebGLUniformLocation | null
  uMirrorC: WebGLUniformLocation | null
  uMirrorR: WebGLUniformLocation | null
  uRotation: WebGLUniformLocation | null
  uDriftA: WebGLUniformLocation | null
  uHue: WebGLUniformLocation | null
  uGlowAmt: WebGLUniformLocation | null
  uFlash: WebGLUniformLocation | null
  uContrast: WebGLUniformLocation | null
}

export class HyperbolicScene implements SceneRuntime {
  meta = { id: 'hyperbolic', name: 'Hyperbolic', family: 'geometry' as const }

  // Schema order matters (spec: "first 8 drive macro knobs positionally").
  params: ParamSchema[] = [
    { name: 'p', label: 'P (sides)', min: 3, max: 9, default: 7, step: 1 },
    { name: 'q', label: 'Q (meeting)', min: 3, max: 9, default: 3, step: 1 },
    { name: 'zoom', label: 'Zoom', min: 0.5, max: 3, default: 1 },
    { name: 'spin', label: 'Spin', min: -1, max: 1, default: 0.1 },
    { name: 'drift', label: 'Drift', min: 0, max: 1, default: 0.3 },
    { name: 'glow', label: 'Glow', min: 0, max: 1, default: 0.5 },
    { name: 'contrast', label: 'Contrast', min: 0.2, max: 2, default: 1 },
    { name: 'hue', label: 'Hue', min: 0, max: 1, default: 0.6 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu
  private fsPass!: FullscreenPass
  private renderProgram!: WebGLProgram
  private renderLoc!: RenderLocs

  // CPU-only state (ARCHITECTURE.md §1): exp-smoothed bass follower (drives
  // the zoom "breath"), the onset-driven edge-flash envelope, and the
  // dt-accumulated rotation/drift phases. All advanced by frame.dt only, and
  // only inside update() — render() just reads whatever these currently hold,
  // so a frozen control tick (render without a preceding update this frame)
  // still renders correctly.
  private smoothedBass = 0
  private flashEnv = 0
  private rotationPhase = 0
  private driftPhase = 0

  private renderSource = RENDER_FS

  // seed is unused: the tiling is a pure function of params/audio state, no
  // PRNG-driven randomness is needed anywhere in this scene (same convention
  // as fractallab.ts's init()).
  init(gpu: Gpu, _seed: number): void {
    this.gpu = gpu
    for (const p of this.params) this.values.set(p.name, p.default)

    this.smoothedBass = 0
    this.flashEnv = 0
    this.rotationPhase = 0
    this.driftPhase = 0

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

    this.flashEnv = this.flashEnv * Math.exp(-FLASH_DECAY * frame.dt) + FLASH_GAIN * onset
    if (this.flashEnv > FLASH_MAX) this.flashEnv = FLASH_MAX

    this.rotationPhase += frame.dt * this.getParam('spin') * SPIN_RATE
    this.driftPhase += frame.dt * this.getParam('drift') * DRIFT_RATE
  }

  render(ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)

    const { p, q } = this.clampPQ(this.getParam('p'), this.getParam('q'))
    const { c: mirrorC, r: mirrorR } = this.mirrorCircle(p, q)

    // beatPhase nudges rotation directly off the live signal bus (like
    // resonance.ts's render()-time rms read) rather than accumulated state —
    // it's a per-frame sample, not something that needs to survive a missed
    // update() tick.
    const beatPhase = ctx.signals.get('beatPhase')
    const rotationEff = this.rotationPhase + beatPhase * BEAT_NUDGE

    const zoomEff = this.getParam('zoom') * (1 + BREATH_GAIN * this.smoothedBass)
    const ax = DRIFT_RADIUS * Math.cos(this.driftPhase)
    const ay = DRIFT_RADIUS * Math.sin(this.driftPhase * 0.61)

    gl.useProgram(this.renderProgram)
    gl.uniform2f(this.renderLoc.uResolution, surface.width, surface.height)
    gl.uniform1f(this.renderLoc.uAspect, surface.width / surface.height)
    gl.uniform1f(this.renderLoc.uZoom, zoomEff)
    gl.uniform1f(this.renderLoc.uP, p)
    gl.uniform1f(this.renderLoc.uMirrorC, mirrorC)
    gl.uniform1f(this.renderLoc.uMirrorR, mirrorR)
    gl.uniform1f(this.renderLoc.uRotation, rotationEff)
    gl.uniform2f(this.renderLoc.uDriftA, ax, ay)
    gl.uniform1f(this.renderLoc.uHue, this.getParam('hue'))
    gl.uniform1f(this.renderLoc.uGlowAmt, this.getParam('glow'))
    gl.uniform1f(this.renderLoc.uFlash, this.flashEnv)
    gl.uniform1f(this.renderLoc.uContrast, this.getParam('contrast'))
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

  // Hyperbolic {p,q} tiling requires 1/p + 1/q < 1/2; below that line the
  // symbol is Euclidean ({4,4},{6,3},{3,6},...) or spherical/degenerate
  // ({3,3},{3,4},{3,5},{4,3},{5,3}) and the triangle-fold maths below breaks
  // down (mirrorCircle's cosh would be <= 1). Only increasing q can fix this
  // (decreasing it only makes 1/p+1/q bigger), so walk q up to the nearest
  // valid integer purely for the maths — params.get('q') / getParam('q')
  // still return exactly what the knob is set to.
  private clampPQ(pRaw: number, qRaw: number): { p: number; q: number } {
    const p = Math.round(Math.min(9, Math.max(3, pRaw)))
    let q = Math.round(Math.min(9, Math.max(3, qRaw)))
    while (1 / p + 1 / q >= 0.5 && q < 24) q++
    return { p, q }
  }

  // Solves the (2,p,q) fundamental-triangle apothem for the Euclidean
  // Poincare-disk mirror circle (center `c` on the x-axis, radius `r`,
  // orthogonal to the unit circle) representing one edge of the central
  // p-gon — see the class doc for the derivation.
  private mirrorCircle(p: number, q: number): { c: number; r: number } {
    const coshApothem = Math.max(1 + 1e-6, Math.cos(Math.PI / q) / Math.sin(Math.PI / p))
    const ae = Math.max(1e-6, Math.sqrt((coshApothem - 1) / (coshApothem + 1)))
    const c = 0.5 * (ae + 1 / ae)
    const r = 0.5 * (1 / ae - ae)
    return { c, r }
  }

  private lookupRenderLocs(program: WebGLProgram): RenderLocs {
    const gl = this.gpu.gl
    return {
      uResolution: gl.getUniformLocation(program, 'uResolution'),
      uAspect: gl.getUniformLocation(program, 'uAspect'),
      uZoom: gl.getUniformLocation(program, 'uZoom'),
      uP: gl.getUniformLocation(program, 'uP'),
      uMirrorC: gl.getUniformLocation(program, 'uMirrorC'),
      uMirrorR: gl.getUniformLocation(program, 'uMirrorR'),
      uRotation: gl.getUniformLocation(program, 'uRotation'),
      uDriftA: gl.getUniformLocation(program, 'uDriftA'),
      uHue: gl.getUniformLocation(program, 'uHue'),
      uGlowAmt: gl.getUniformLocation(program, 'uGlowAmt'),
      uFlash: gl.getUniformLocation(program, 'uFlash'),
      uContrast: gl.getUniformLocation(program, 'uContrast'),
    }
  }

  getShaderSources(): ShaderStage[] {
    return [{ key: 'render-fs', label: 'Hyperbolic tiling (render-fs)', source: this.renderSource }]
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
