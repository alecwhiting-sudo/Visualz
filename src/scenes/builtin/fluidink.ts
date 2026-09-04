import { mulberry32 } from '../../core/prng'
import type { Gpu } from '../../gpu/context'
import { checkFloatRenderable, FloatTarget, FullscreenPass, type FloatTargetFormat, type RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'

/**
 * Particles & physics family: GPU stable-fluids ink (Stam semi-Lagrangian),
 * audio-driven. Glowing dye billows through a divergence-free velocity field;
 * bass hits inject dye + radial velocity impulses ("splats"), vorticity
 * confinement keeps the flow curling instead of smoothing out, and an
 * ambient curl-noise wind field churns the whole tank harder when the music
 * is loud. All simulation state (velocity, dye, pressure) lives in `update()`
 * (Scene Contract R2/R4): fixed FIXED_DT sub-steps, a clamped accumulator so
 * a stalled live frame can't fast-forward. `render()` only samples the dye
 * texture through a tone-map — it is a pure function of scene state (R1).
 *
 * Sim resolution is keyed off the render surface's aspect at `init()` (a
 * construction-time constant per docs/SCENE_CONTRACT.md's Framing section):
 * the dye grid's width/height are sized so the grid itself is aspect-correct
 * (F1) — the display pass then maps `gl_FragCoord/uRes` straight onto dye UV
 * with no cropping/letterboxing. Sizing the grid to the aspect keeps each
 * *texel* physically square, but distances in UV *fraction* space are NOT
 * isotropic (a fixed UV radius covers `dyeW` texels of physical width vs
 * `dyeH` texels of physical height) — every UV-space distance-to-point below
 * (splats, the ambient emitter, curl-noise cells) therefore aspect-corrects
 * by scaling the x-component by `uAspect` before the Gaussian/domain lookup,
 * so splats render as circles and wind cells as squares at every format.
 * `quality` rescales this grid (like physarum's particle-count knob): it is
 * a "different simulation," not a resize-in-place, so changing it clears and
 * rebuilds every field — the golden test pins the 1.0 default.
 *
 * Per-substep pass order (standard stable-fluids): advect velocity (dissipate
 * ~0.2/s) -> add forces (vorticity confinement + ambient curl-noise wind +
 * bass-hit splats) -> divergence -> 20 Jacobi pressure iterations (warm-
 * started from the previous frame's solution) -> subtract pressure gradient
 * -> advect dye (dissipate by the `fade` knob) with the same splats injected
 * as colour. Splats only apply on the FIRST sub-step of the `update()` call
 * that detected the hit (grayscott.ts's `uInject`-substep-0 idiom) — never
 * repeated across a frame's multiple sub-steps.
 *
 * Bass-hit detection is the neuralweb3d.ts `bassEnv`/keep-alive pattern
 * verbatim (rate 5.0, rise = 0.2 - 0.16*sensitivity, power = clamp((jump -
 * rise)/(2*rise), 0, 1), a dim keep-alive hit after 2.0s of silence so the
 * tank never goes fully still). Splat positions/colours/edges are a pure
 * hash of an injection counter (`hash32`, CPU-mirrored copy of the shaders'
 * function) — no `Math.random` anywhere; the one PRNG draw at `init()` folds
 * the seed into that hash stream so different seeds produce different splat
 * layouts without reseeding per-hit.
 */

const FIXED_DT = 1 / 60
const MAX_STEPS_PER_FRAME = 4
const PRESSURE_ITERS = 20
const MAX_SPLATS = 8
const DYE_SHORT_CAP = 720
const DYE_SHORT_MIN = 32

const VEL_DISSIPATION = 0.2 // 1/s, fixed (spec: "dissipation ~0.2/s")
const FADE_SCALE = 2.0 // fade knob (0..1) -> dye dissipation rate (1/s); default 0.25 -> ~0.5/s
const SWIRL_SCALE = 55.0 // safe to push harder than the original 22 now that FORCE_FS CFL-clamps |v| per substep
const WIND_SCALE = 8.0

const BASS_ENV_RATE = 5.0 // neuralweb3d.ts verbatim
const KEEPALIVE_SEC = 2.0
const RMS_ATTACK_RATE = 1 / 0.3
const RMS_RELEASE_RATE = 1 / 2.5
const CENTROID_RATE = 1 / 1.0

const BASE_RADIUS = 0.11 // ~2.4x the original bloom radius (coordinator's "presence" pass)
const BASE_IMPULSE = 3.2
const HUE_RANGE = 0.6 // how far centroidEnv*hueDrive can push hue

// Continuous ambient emitter (coordinator's "presence" pass, item 3): a small
// amount of dye + velocity is injected every sub-step along a slowly
// wandering point — a pure function of `simTime` (model time) via sin/cos,
// never wall-clock or Math.random — so the tank is never fully empty even in
// silence. Both its dye rate and velocity kick scale with `rmsEnv`.
const AMBIENT_RADIUS = 0.11
const AMBIENT_RATE_BASE = 0.4 // dye units/s at the emitter core
const AMBIENT_VEL_BASE = 1.4 // velocity impulse magnitude base
const AMBIENT_SCALE_FLOOR = 0.3
const AMBIENT_SCALE_RMS = 0.7

// Attribute-less fullscreen triangle: standard gl_VertexID trick, no VBO needed.
const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`

// Pass 1: semi-Lagrangian velocity advection, LINEAR-filtered `texture()`
// sampling (the FloatTarget pair is built with filter:'linear' precisely for
// this — no manual bilinear needed, unlike the NEAREST GPGPU-state textures
// elsewhere in the codebase).
const VEL_ADVECT_FS = `#version 300 es
precision highp float;
uniform sampler2D uVel;
uniform vec2 uTexel;
uniform float uDt, uDissipation;
out vec4 outVel;
void main(){
  vec2 uv = gl_FragCoord.xy * uTexel;
  vec2 v = texture(uVel, uv).rg;
  vec2 back = uv - v * uDt;
  vec2 adv = texture(uVel, back).rg;
  adv *= exp(-uDissipation * uDt);
  outVel = vec4(adv, 0.0, 1.0);
}`

// Pass 2: vorticity confinement (curl -> force toward the vortex core) +
// ambient curl-noise wind + bass-hit splat impulses. Vorticity needs curl at
// four neighbour texels (each itself needing ITS neighbours), so `curlAt`
// samples a small stencil via `texelFetch` — deterministic, no derivatives.
const FORCE_FS = `#version 300 es
precision highp float;
uniform sampler2D uVel;
uniform ivec2 uSize;
uniform float uDt, uSwirl, uWind, uSimTime, uAspect;
uniform int uInjectActive, uSplatCount;
uniform vec2 uSplatPos[${MAX_SPLATS}];
uniform vec2 uSplatVel[${MAX_SPLATS}];
uniform float uSplatRadius[${MAX_SPLATS}];
uniform float uAmbPhaseA, uAmbPhaseB, uAmbientRadius, uAmbientVelMag;
uniform vec2 uMaxSpeed;
out vec4 outVel;

uint hash32(uint x){ x=x+0x9e3779b9u; x^=x>>16u; x*=0x7feb352du; x^=x>>15u; x*=0x846ca68bu; x^=x>>16u; return x; }
// Continuous ambient emitter's wandering point: a pure function of t
// (model time) via sin/cos -- never wall-clock, never Math.random -- plus its
// analytic tangent direction, so the emitted flow follows the point's own
// motion instead of a decoupled random push.
vec2 ambientPos(float t){
  return vec2(0.5 + 0.35 * sin(t * 0.11 + uAmbPhaseA), 0.5 + 0.35 * cos(t * 0.13 + uAmbPhaseB));
}
vec2 ambientDir(float t){
  vec2 d = vec2(0.35 * 0.11 * cos(t * 0.11 + uAmbPhaseA), -0.35 * 0.13 * sin(t * 0.13 + uAmbPhaseB));
  return normalize(d + 1e-6);
}
float hashf(ivec2 p){ uint h = hash32(uint(p.x)*1973u ^ uint(p.y)*9277u ^ 26699u); return float(h) / 4294967296.0; }
float valueNoise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p);
  ivec2 ii = ivec2(i);
  float a = hashf(ii), b = hashf(ii+ivec2(1,0)), c = hashf(ii+ivec2(0,1)), d = hashf(ii+ivec2(1,1));
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}
// Curl of a scalar potential field: divergence-free by construction, drifted
// over uSimTime (accumulated model time — R3, never wall-clock) for a slow
// ambient churn rather than a static pattern.
vec2 curlNoise(vec2 uv){
  float eps = 0.05;
  // Aspect-correct the domain (x scaled by uAspect) so wind cells are square
  // in physical space instead of stretched by the render aspect.
  vec2 p = vec2(uv.x * uAspect, uv.y) * 3.0 + vec2(uSimTime * 0.05, -uSimTime * 0.035);
  float n1 = valueNoise(p + vec2(0.0, eps));
  float n2 = valueNoise(p - vec2(0.0, eps));
  float n3 = valueNoise(p + vec2(eps, 0.0));
  float n4 = valueNoise(p - vec2(eps, 0.0));
  float dx = (n1 - n2) / (2.0 * eps);
  float dy = (n3 - n4) / (2.0 * eps);
  return vec2(dx, -dy);
}
vec2 velAt(ivec2 c){ return texelFetch(uVel, clamp(c, ivec2(0), uSize-1), 0).rg; }
float curlAt(ivec2 tc){
  vec2 l = velAt(tc+ivec2(-1,0)), r = velAt(tc+ivec2(1,0));
  vec2 b = velAt(tc+ivec2(0,-1)), t = velAt(tc+ivec2(0,1));
  return (r.y - l.y - (t.x - b.x)) * 0.5;
}
void main(){
  ivec2 tc = ivec2(gl_FragCoord.xy);
  vec2 uv = gl_FragCoord.xy / vec2(uSize);
  vec2 v = texelFetch(uVel, tc, 0).rg;

  float wC = curlAt(tc);
  float wL = curlAt(tc+ivec2(-1,0)), wR = curlAt(tc+ivec2(1,0));
  float wB = curlAt(tc+ivec2(0,-1)), wT = curlAt(tc+ivec2(0,1));
  vec2 gradAbsW = vec2(abs(wR)-abs(wL), abs(wT)-abs(wB)) * 0.5;
  vec2 N = gradAbsW / (length(gradAbsW) + 1e-5);
  vec2 vort = vec2(N.y * wC, -N.x * wC) * uSwirl;

  vec2 force = vort + curlNoise(uv) * uWind;

  if (uInjectActive > 0) {
    for (int i = 0; i < ${MAX_SPLATS}; i++) {
      if (i >= uSplatCount) break;
      vec2 d = uv - uSplatPos[i];
      d.x *= uAspect;
      float r2 = dot(d, d);
      float fall = exp(-r2 / (uSplatRadius[i]*uSplatRadius[i]));
      force += uSplatVel[i] * fall;
    }
  }

  vec2 ad = uv - ambientPos(uSimTime);
  ad.x *= uAspect;
  float afall = exp(-dot(ad, ad) / (uAmbientRadius * uAmbientRadius));
  force += ambientDir(uSimTime) * uAmbientVelMag * afall;

  v += force * uDt;
  // CFL-safe clamp (coordinator's item 5): bounds advection displacement to
  // <=2 texels per sub-step so SWIRL/WIND can run hot without blowing up.
  v.x = clamp(v.x, -uMaxSpeed.x, uMaxSpeed.x);
  v.y = clamp(v.y, -uMaxSpeed.y, uMaxSpeed.y);
  outVel = vec4(v, 0.0, 1.0);
}`

const DIVERGENCE_FS = `#version 300 es
precision highp float;
uniform sampler2D uVel;
uniform ivec2 uSize;
out vec4 outDiv;
void main(){
  ivec2 tc = ivec2(gl_FragCoord.xy);
  ivec2 l = clamp(tc+ivec2(-1,0), ivec2(0), uSize-1);
  ivec2 r = clamp(tc+ivec2(1,0), ivec2(0), uSize-1);
  ivec2 b = clamp(tc+ivec2(0,-1), ivec2(0), uSize-1);
  ivec2 t = clamp(tc+ivec2(0,1), ivec2(0), uSize-1);
  float du = texelFetch(uVel, r, 0).x - texelFetch(uVel, l, 0).x;
  float dv = texelFetch(uVel, t, 0).y - texelFetch(uVel, b, 0).y;
  outDiv = vec4(0.5 * (du + dv), 0.0, 0.0, 1.0);
}`

// Jacobi pressure relaxation, warm-started every substep from the previous
// solution (not cleared) for faster convergence — standard stable-fluids
// practice, and harmless for determinism since the whole chain is fixed-step.
const PRESSURE_FS = `#version 300 es
precision highp float;
uniform sampler2D uPressure;
uniform sampler2D uDiv;
uniform ivec2 uSize;
out vec4 outP;
void main(){
  ivec2 tc = ivec2(gl_FragCoord.xy);
  ivec2 l = clamp(tc+ivec2(-1,0), ivec2(0), uSize-1);
  ivec2 r = clamp(tc+ivec2(1,0), ivec2(0), uSize-1);
  ivec2 b = clamp(tc+ivec2(0,-1), ivec2(0), uSize-1);
  ivec2 t = clamp(tc+ivec2(0,1), ivec2(0), uSize-1);
  float pl = texelFetch(uPressure, l, 0).x;
  float pr = texelFetch(uPressure, r, 0).x;
  float pb = texelFetch(uPressure, b, 0).x;
  float pt = texelFetch(uPressure, t, 0).x;
  float div = texelFetch(uDiv, tc, 0).x;
  outP = vec4((pl + pr + pb + pt - div) * 0.25, 0.0, 0.0, 1.0);
}`

const GRADIENT_SUBTRACT_FS = `#version 300 es
precision highp float;
uniform sampler2D uVel;
uniform sampler2D uPressure;
uniform ivec2 uSize;
out vec4 outVel;
void main(){
  ivec2 tc = ivec2(gl_FragCoord.xy);
  ivec2 l = clamp(tc+ivec2(-1,0), ivec2(0), uSize-1);
  ivec2 r = clamp(tc+ivec2(1,0), ivec2(0), uSize-1);
  ivec2 b = clamp(tc+ivec2(0,-1), ivec2(0), uSize-1);
  ivec2 t = clamp(tc+ivec2(0,1), ivec2(0), uSize-1);
  float pl = texelFetch(uPressure, l, 0).x;
  float pr = texelFetch(uPressure, r, 0).x;
  float pb = texelFetch(uPressure, b, 0).x;
  float pt = texelFetch(uPressure, t, 0).x;
  vec2 v = texelFetch(uVel, tc, 0).rg;
  v -= 0.5 * vec2(pr - pl, pt - pb);
  outVel = vec4(v, 0.0, 1.0);
}`

// Dye advection (LINEAR `texture()`, same discipline as VEL_ADVECT_FS) plus
// this frame's splat colour injection — same UV-space splats as FORCE_FS,
// applied here to dye instead of velocity.
const DYE_ADVECT_FS = `#version 300 es
precision highp float;
uniform sampler2D uDye;
uniform sampler2D uVel;
uniform vec2 uTexel;
uniform float uDt, uDissipation, uAspect;
uniform int uInjectActive, uSplatCount;
uniform vec2 uSplatPos[${MAX_SPLATS}];
uniform vec3 uSplatColor[${MAX_SPLATS}];
uniform float uSplatRadius[${MAX_SPLATS}];
uniform float uSplatBright[${MAX_SPLATS}];
uniform float uSimTime, uAmbPhaseA, uAmbPhaseB, uAmbientRadius, uAmbientRate;
uniform vec3 uAmbientColor;
out vec4 outDye;
vec2 ambientPos(float t){
  return vec2(0.5 + 0.35 * sin(t * 0.11 + uAmbPhaseA), 0.5 + 0.35 * cos(t * 0.13 + uAmbPhaseB));
}
void main(){
  vec2 uv = gl_FragCoord.xy * uTexel;
  vec2 v = texture(uVel, uv).rg;
  vec2 back = uv - v * uDt;
  vec3 c = texture(uDye, back).rgb;
  c *= exp(-uDissipation * uDt);
  if (uInjectActive > 0) {
    for (int i = 0; i < ${MAX_SPLATS}; i++) {
      if (i >= uSplatCount) break;
      vec2 d = uv - uSplatPos[i];
      d.x *= uAspect;
      float r2 = dot(d, d);
      float fall = exp(-r2 / (uSplatRadius[i]*uSplatRadius[i]));
      c += uSplatColor[i] * uSplatBright[i] * fall;
    }
  }

  vec2 ad = uv - ambientPos(uSimTime);
  ad.x *= uAspect;
  float afall = exp(-dot(ad, ad) / (uAmbientRadius * uAmbientRadius));
  c += uAmbientColor * uAmbientRate * afall * uDt;

  outDye = vec4(c, 1.0);
}`

// Final display pass (pure, R1): soft tone-map over black, `glow` knob as
// exposure. `uRes` maps straight onto dye UV with no cropping — the dye grid
// is already sized aspect-correct at init() (F1), so there is no letterbox
// branch to write.
const RENDER_FS = `#version 300 es
precision highp float;
uniform sampler2D uDye;
uniform vec2 uRes;
uniform float uExposure;
out vec4 outColor;
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 dye = texture(uDye, uv).rgb;
  vec3 col = 1.0 - exp(-dye * uExposure);
  // Saturation lift (mid-density ink reads as glowing colour, not grey mud)
  // + a soft knee that gently compresses the top end instead of hard-clipping.
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(luma), col, 1.35);
  col = col / (1.0 + 0.15 * col);
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

// CPU mirror of the shaders' hash32, for deterministic (seeded, not
// Math.random) splat placement/colour on the CPU side.
function hash32(x: number): number {
  x = (x + 0x9e3779b9) >>> 0
  x = x ^ (x >>> 16)
  x = Math.imul(x, 0x7feb352d) >>> 0
  x = x ^ (x >>> 15)
  x = Math.imul(x, 0x846ca68b) >>> 0
  x = x ^ (x >>> 16)
  return x >>> 0
}
function hash01(x: number): number {
  return hash32(x) / 4294967296
}

function hsv2rgb(h: number, s: number, v: number): [number, number, number] {
  const hp = (((h % 1) + 1) % 1) * 6
  const c = v * s
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hp < 1) { r = c; g = x } else if (hp < 2) { r = x; g = c } else if (hp < 3) { g = c; b = x } else if (hp < 4) { g = x; b = c } else if (hp < 5) { r = x; b = c } else { r = c; b = x }
  const m = v - c
  return [r + m, g + m, b + m]
}

interface GridSizes {
  dyeW: number
  dyeH: number
  velW: number
  velH: number
}

function computeGridSizes(surfaceW: number, surfaceH: number, quality: number): GridSizes {
  const aspect = surfaceW / surfaceH
  const shortAxis = Math.min(surfaceW, surfaceH)
  const dyeShort = Math.round(clamp(Math.min(shortAxis, DYE_SHORT_CAP) * quality, DYE_SHORT_MIN, DYE_SHORT_CAP))
  let dyeW: number
  let dyeH: number
  if (aspect >= 1) {
    dyeH = dyeShort
    dyeW = Math.max(2, Math.round(dyeShort * aspect))
  } else {
    dyeW = dyeShort
    dyeH = Math.max(2, Math.round(dyeShort / aspect))
  }
  const velW = Math.max(2, Math.round(dyeW / 2))
  const velH = Math.max(2, Math.round(dyeH / 2))
  return { dyeW, dyeH, velW, velH }
}

/** Two `FloatTarget`s at a rectangular (non-square) size — `PingPong`
 *  (src/gpu/targets.ts) is square-only (particle/agent grids), so the fluid
 *  fields (sized to the render surface's aspect, F1) need their own pair. */
class RectPingPong {
  private a: FloatTarget
  private b: FloatTarget
  private flip = false

  constructor(gpu: Gpu, width: number, height: number, format: FloatTargetFormat = 'rgba32f', filter: 'nearest' | 'linear' = 'linear') {
    this.a = new FloatTarget(gpu, { width, height }, undefined, format, filter)
    this.b = new FloatTarget(gpu, { width, height }, undefined, format, filter)
  }

  get src(): FloatTarget {
    return this.flip ? this.b : this.a
  }

  get dst(): FloatTarget {
    return this.flip ? this.a : this.b
  }

  swap(): void {
    this.flip = !this.flip
  }

  dispose(): void {
    this.a.dispose()
    this.b.dispose()
  }
}

interface Splat {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  g: number
  b: number
  radius: number
  bright: number
}

interface ForceLocs {
  uVel: WebGLUniformLocation | null
  uSize: WebGLUniformLocation | null
  uDt: WebGLUniformLocation | null
  uSwirl: WebGLUniformLocation | null
  uWind: WebGLUniformLocation | null
  uSimTime: WebGLUniformLocation | null
  uAspect: WebGLUniformLocation | null
  uInjectActive: WebGLUniformLocation | null
  uSplatCount: WebGLUniformLocation | null
  uSplatPos: WebGLUniformLocation | null
  uSplatVel: WebGLUniformLocation | null
  uSplatRadius: WebGLUniformLocation | null
  uAmbPhaseA: WebGLUniformLocation | null
  uAmbPhaseB: WebGLUniformLocation | null
  uAmbientRadius: WebGLUniformLocation | null
  uAmbientVelMag: WebGLUniformLocation | null
  uMaxSpeed: WebGLUniformLocation | null
}

interface DyeAdvectLocs {
  uDye: WebGLUniformLocation | null
  uVel: WebGLUniformLocation | null
  uTexel: WebGLUniformLocation | null
  uDt: WebGLUniformLocation | null
  uDissipation: WebGLUniformLocation | null
  uAspect: WebGLUniformLocation | null
  uInjectActive: WebGLUniformLocation | null
  uSplatCount: WebGLUniformLocation | null
  uSplatPos: WebGLUniformLocation | null
  uSplatColor: WebGLUniformLocation | null
  uSplatRadius: WebGLUniformLocation | null
  uSplatBright: WebGLUniformLocation | null
  uSimTime: WebGLUniformLocation | null
  uAmbPhaseA: WebGLUniformLocation | null
  uAmbPhaseB: WebGLUniformLocation | null
  uAmbientRadius: WebGLUniformLocation | null
  uAmbientRate: WebGLUniformLocation | null
  uAmbientColor: WebGLUniformLocation | null
}

export class FluidInkScene implements SceneRuntime {
  meta = { id: 'fluidink', name: 'Fluid Ink', family: 'particles' as const, framing: 'field' as const }

  params: ParamSchema[] = [
    { name: 'splat', label: 'Splat size', min: 0, max: 1, default: 0.6 },
    { name: 'pump', label: 'Pump (impulse)', min: 0, max: 1, default: 0.6 },
    { name: 'swirl', label: 'Swirl (vorticity)', min: 0, max: 1, default: 0.5 },
    { name: 'wind', label: 'Ambient wind', min: 0, max: 1, default: 0.4 },
    { name: 'colour', label: 'Colour', min: 0, max: 1, default: 0.8 },
    { name: 'hueDrive', label: 'Hue drive', min: 0, max: 1, default: 0.3 },
    { name: 'fade', label: 'Fade', min: 0, max: 1, default: 0.25 },
    { name: 'glow', label: 'Glow (exposure)', min: 0.3, max: 2, default: 1 },
    { name: 'sensitivity', label: 'Sensitivity', min: 0, max: 1, default: 0.5 },
    { name: 'hue', label: 'Hue', min: 0, max: 1, default: 0.6 },
    { name: 'quality', label: 'Quality', min: 0.5, max: 1, default: 1 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu

  private grid!: GridSizes
  private quality = 1
  private pendingQuality: number | null = null

  private velPP!: RectPingPong
  private dyePP!: RectPingPong
  private pressPP!: RectPingPong
  private divTarget!: FloatTarget
  private fsPass!: FullscreenPass

  private velAdvectProgram!: WebGLProgram
  private forceProgram!: WebGLProgram
  private divProgram!: WebGLProgram
  private pressureProgram!: WebGLProgram
  private gradProgram!: WebGLProgram
  private dyeAdvectProgram!: WebGLProgram
  private renderProgram!: WebGLProgram

  private forceLoc!: ForceLocs
  private dyeAdvectLoc!: DyeAdvectLocs
  private renderLoc!: { uDye: WebGLUniformLocation | null; uRes: WebGLUniformLocation | null; uExposure: WebGLUniformLocation | null }
  private velAdvectLoc!: { uVel: WebGLUniformLocation | null; uTexel: WebGLUniformLocation | null; uDt: WebGLUniformLocation | null; uDissipation: WebGLUniformLocation | null }
  private divLoc!: { uVel: WebGLUniformLocation | null; uSize: WebGLUniformLocation | null }
  private pressureLoc!: { uPressure: WebGLUniformLocation | null; uDiv: WebGLUniformLocation | null; uSize: WebGLUniformLocation | null }
  private gradLoc!: { uVel: WebGLUniformLocation | null; uPressure: WebGLUniformLocation | null; uSize: WebGLUniformLocation | null }

  // Code layer sources (ARCHITECTURE.md §3.3).
  private forceSource = FORCE_FS
  private dyeAdvectSource = DYE_ADVECT_FS
  private renderSource = RENDER_FS

  // Fixed sub-step accumulator (R4).
  private simAccum = 0
  private simTime = 0 // model time, dt-paced — never wall-clock (R3)

  // Bass-hit envelope follower state (neuralweb3d.ts pattern, verbatim rates).
  private bassEnv = 0
  private bassArmed = true
  private sinceInject = KEEPALIVE_SEC // fire once shortly after boot
  private rmsEnv = 0
  private centroidEnv = 0

  // Deterministic hash stream: `hashMix` folds `seed` in once at init() (the
  // one PRNG draw), every subsequent splat is a pure hash of a counter.
  private injectCounter = 0
  private hitCount = 0
  private hashMix = 0

  // Continuous ambient emitter (coordinator's "presence" pass): phases are a
  // pure function of `seed` (drawn once at init, like `hashMix`), so the
  // wandering path differs per seed but is otherwise driven purely by
  // `simTime` inside the shaders.
  private ambPhaseA = 0
  private ambPhaseB = 0

  // CFL-safe per-axis velocity clamp (item 5), recomputed whenever the grid
  // is (re)built since it depends on `velW`/`velH`.
  private maxSpeedX = 0
  private maxSpeedY = 0

  // Aspect-correction factor (item 1: fix UV-space anisotropy) — dyeW/dyeH,
  // recomputed whenever the grid is (re)built. Multiplying a UV-space delta's
  // x-component by this before a distance-to-point Gaussian normalizes it to
  // physical-square units (see the class doc comment).
  private aspect = 1

  private pendingSplats: Splat[] = []

  init(gpu: Gpu, seed: number): void {
    const caps = checkFloatRenderable(gpu)
    if (!caps.ok) throw new Error(caps.reason)
    // LINEAR sampling of RGBA32F (advection reads, via `texture()`) requires
    // this extension to be explicitly enabled — merely being available is
    // not enough; without this call the float targets silently render as
    // texture-incomplete (reads as zero) under a spec-conformant driver.
    if (!gpu.gl.getExtension('OES_texture_float_linear')) {
      throw new Error('OES_texture_float_linear unavailable — Fluid Ink requires linear-filtered float advection reads')
    }

    this.gpu = gpu
    for (const p of this.params) this.values.set(p.name, p.default)
    this.quality = this.getParam('quality')
    this.pendingQuality = null

    this.simAccum = 0
    this.simTime = 0
    this.bassEnv = 0
    this.bassArmed = true
    this.sinceInject = KEEPALIVE_SEC
    this.rmsEnv = 0
    this.centroidEnv = 0
    this.injectCounter = 0
    this.hitCount = 0
    this.pendingSplats = []

    const rng = mulberry32(seed >>> 0)
    this.hashMix = Math.floor(rng() * 4294967296) >>> 0
    this.ambPhaseA = hash01(this.hashMix + 101) * Math.PI * 2
    this.ambPhaseB = hash01(this.hashMix + 202) * Math.PI * 2

    this.forceSource = FORCE_FS
    this.dyeAdvectSource = DYE_ADVECT_FS
    this.renderSource = RENDER_FS

    this.grid = computeGridSizes(gpu.width, gpu.height, this.quality)
    this.buildFields()

    this.fsPass = new FullscreenPass(gpu)
    this.velAdvectProgram = gpu.compileProgram(FULLSCREEN_VS, VEL_ADVECT_FS)
    this.forceProgram = gpu.compileProgram(FULLSCREEN_VS, this.forceSource)
    this.divProgram = gpu.compileProgram(FULLSCREEN_VS, DIVERGENCE_FS)
    this.pressureProgram = gpu.compileProgram(FULLSCREEN_VS, PRESSURE_FS)
    this.gradProgram = gpu.compileProgram(FULLSCREEN_VS, GRADIENT_SUBTRACT_FS)
    this.dyeAdvectProgram = gpu.compileProgram(FULLSCREEN_VS, this.dyeAdvectSource)
    this.renderProgram = gpu.compileProgram(FULLSCREEN_VS, this.renderSource)

    this.velAdvectLoc = this.lookupVelAdvectLocs(this.velAdvectProgram)
    this.forceLoc = this.lookupForceLocs(this.forceProgram)
    this.divLoc = this.lookupDivLocs(this.divProgram)
    this.pressureLoc = this.lookupPressureLocs(this.pressureProgram)
    this.gradLoc = this.lookupGradLocs(this.gradProgram)
    this.dyeAdvectLoc = this.lookupDyeAdvectLocs(this.dyeAdvectProgram)
    this.renderLoc = this.lookupRenderLocs(this.renderProgram)

    const gl = gpu.gl
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  /** (Re)builds every field at the current `this.grid` size, dye+velocity
   *  cleared to zero (init/seek/quality-change contract). */
  private buildFields(): void {
    this.velPP?.dispose()
    this.dyePP?.dispose()
    this.pressPP?.dispose()
    this.divTarget?.dispose()
    const { dyeW, dyeH, velW, velH } = this.grid
    this.velPP = new RectPingPong(this.gpu, velW, velH, 'rgba32f', 'linear')
    this.dyePP = new RectPingPong(this.gpu, dyeW, dyeH, 'rgba32f', 'linear')
    this.pressPP = new RectPingPong(this.gpu, velW, velH, 'rgba32f', 'nearest')
    this.divTarget = new FloatTarget(this.gpu, { width: velW, height: velH }, undefined, 'rgba32f', 'nearest')
    // CFL-safe clamp (item 5): displacement per sub-step <= 2 texels along
    // each axis, so raised SWIRL/WIND constants can't blow the sim up.
    this.maxSpeedX = 2 / velW / FIXED_DT
    this.maxSpeedY = 2 / velH / FIXED_DT
    this.aspect = dyeW / dyeH
  }

  setParam(name: string, value: number): void {
    if (name === 'quality') {
      const q = clamp(value, 0.5, 1)
      this.pendingQuality = q !== this.quality ? q : null
      this.values.set('quality', q)
      return
    }
    this.values.set(name, value)
  }

  getParam(name: string): number {
    if (name === '#hits') return this.hitCount
    if (name === '#simTime') return this.simTime
    return this.values.get(name) ?? 0
  }

  /** Stages up to `MAX_SPLATS` deterministic splats for a bass hit of the
   *  given `power` (0 at threshold, saturating at 1) and current
   *  `centroidEnv` (hue steering) — neuralweb3d.ts's injectBass idiom: a
   *  pure hash of `injectCounter`, no per-hit PRNG draw. */
  private stageSplats(power: number, centroidEnv: number): void {
    const splatKnob = clamp(this.getParam('splat'), 0, 1)
    const pumpKnob = clamp(this.getParam('pump'), 0, 1)
    const colourKnob = clamp(this.getParam('colour'), 0, 1)
    const hueDriveKnob = clamp(this.getParam('hueDrive'), 0, 1)
    const hueBase = clamp(this.getParam('hue'), 0, 1)

    const count = 2 + (hash32(this.injectCounter * 7 + 13 + this.hashMix) % 3) // 2..4
    const hueMixed = hueBase + hueDriveKnob * centroidEnv * HUE_RANGE
    const saturation = clamp(0.55 + colourKnob * 0.45, 0, 1)

    const splats: Splat[] = []
    for (let k = 0; k < count; k++) {
      const base = this.injectCounter * 4099 + k * 131 + this.hashMix
      // Full-frame spread with a mild center bias (coordinator's item 1) —
      // no more lower-half bias.
      const x = 0.15 + 0.7 * hash01(base + 1)
      const y = 0.15 + 0.7 * hash01(base + 2)
      const angle = hash01(base + 3) * Math.PI * 2
      const hueJitter = hash01(base + 4) - 0.5

      const mag = BASE_IMPULSE * (0.3 + 1.4 * pumpKnob) * (0.3 + 1.2 * power)
      const radius = BASE_RADIUS * (0.4 + 1.2 * splatKnob) * (0.6 + 0.6 * power)
      // Bright enough at default knobs that a fresh splat's core tone-maps to
      // ~0.8+ (coordinator's item 2), scaling further with hit power.
      const bright = (0.6 + 1.4 * splatKnob) * (0.5 + 1.0 * power)

      const hue = hueMixed + hueJitter * colourKnob * 0.5
      const [r, g, b] = hsv2rgb(hue, saturation, 1)

      splats.push({
        x,
        y,
        vx: Math.cos(angle) * mag,
        vy: Math.sin(angle) * mag,
        r,
        g,
        b,
        radius,
        bright,
      })
    }
    this.injectCounter++
    // Cap total pending splats at MAX_SPLATS (only relevant in the rare case
    // two hit sources land in the same update() call — never happens today
    // since detection is if/else-if, but keep the array bounded regardless).
    this.pendingSplats = splats.slice(0, MAX_SPLATS)
  }

  update(ctx: FrameContext): void {
    const { frame, signals } = ctx
    const dt = frame.dt

    if (this.pendingQuality !== null) {
      this.quality = this.pendingQuality
      this.pendingQuality = null
      this.grid = computeGridSizes(this.gpu.width, this.gpu.height, this.quality)
      this.buildFields()
    }

    const sensitivity = clamp(this.getParam('sensitivity'), 0, 1)
    const rise = 0.2 - sensitivity * 0.16
    const bass = signals.get('bass')
    const rms = clamp(signals.get('rms'), 0, 1)
    const centroid = clamp(signals.get('centroid'), 0, 1)

    this.bassEnv += (bass - this.bassEnv) * (1 - Math.exp(-BASS_ENV_RATE * dt))
    const jump = bass - this.bassEnv
    const rmsRate = rms > this.rmsEnv ? RMS_ATTACK_RATE : RMS_RELEASE_RATE
    this.rmsEnv += (rms - this.rmsEnv) * (1 - Math.exp(-rmsRate * dt))
    this.centroidEnv += (centroid - this.centroidEnv) * (1 - Math.exp(-CENTROID_RATE * dt))

    this.sinceInject += dt
    let hitPower = -1
    if (this.bassArmed && jump > rise) {
      hitPower = clamp((jump - rise) / (rise * 2), 0, 1)
      this.bassArmed = false
      this.sinceInject = 0
    } else if (!this.bassArmed && jump < rise * 0.4) {
      this.bassArmed = true
    }
    if (hitPower < 0 && this.sinceInject >= KEEPALIVE_SEC) {
      hitPower = 0
      this.sinceInject = 0
    }
    if (hitPower >= 0) {
      this.stageSplats(hitPower, this.centroidEnv)
      this.hitCount++
    }

    const swirlKnob = clamp(this.getParam('swirl'), 0, 1)
    const windKnob = clamp(this.getParam('wind'), 0, 1) * (0.2 + 0.8 * this.rmsEnv)
    const fadeDissipation = clamp(this.getParam('fade'), 0, 1) * FADE_SCALE

    // Continuous ambient emitter (item 3): both its dye rate and velocity
    // kick scale with the same rmsEnv-driven factor, so the tank visibly
    // churns harder when the music is loud but never goes fully still.
    const ambientScale = AMBIENT_SCALE_FLOOR + AMBIENT_SCALE_RMS * this.rmsEnv
    const ambientRate = AMBIENT_RATE_BASE * ambientScale
    const ambientVelMag = AMBIENT_VEL_BASE * ambientScale
    const hueBase = clamp(this.getParam('hue'), 0, 1)
    const colourKnob = clamp(this.getParam('colour'), 0, 1)
    const ambientHue = hueBase + 0.15 * Math.sin(this.simTime * 0.037)
    const ambientSat = clamp(0.5 + colourKnob * 0.4, 0, 1)
    const ambientColor = hsv2rgb(ambientHue, ambientSat, 1)

    this.simAccum = Math.min(this.simAccum + dt, MAX_STEPS_PER_FRAME * FIXED_DT)
    let steps = 0
    while (this.simAccum >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      this.simulateStep(FIXED_DT, swirlKnob, windKnob, fadeDissipation, ambientRate, ambientVelMag, ambientColor, steps === 0)
      this.simAccum -= FIXED_DT
      steps++
    }
  }

  private simulateStep(
    dt: number,
    swirl: number,
    wind: number,
    fadeDissipation: number,
    ambientRate: number,
    ambientVelMag: number,
    ambientColor: [number, number, number],
    applyFirst: boolean,
  ): void {
    const gl = this.gpu.gl
    const { dyeW, dyeH, velW, velH } = this.grid
    const inject = applyFirst && this.pendingSplats.length > 0
    const splats = inject ? this.pendingSplats : []

    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)

    // 1. Velocity advection.
    this.velPP.dst.bindTarget()
    gl.useProgram(this.velAdvectProgram)
    this.velPP.src.bindTexture(0)
    gl.uniform1i(this.velAdvectLoc.uVel, 0)
    gl.uniform2f(this.velAdvectLoc.uTexel, 1 / velW, 1 / velH)
    gl.uniform1f(this.velAdvectLoc.uDt, dt)
    gl.uniform1f(this.velAdvectLoc.uDissipation, VEL_DISSIPATION)
    this.fsPass.draw()
    this.velPP.swap()

    // 2. Forces: vorticity confinement + ambient wind + splat impulses.
    this.velPP.dst.bindTarget()
    gl.useProgram(this.forceProgram)
    this.velPP.src.bindTexture(0)
    gl.uniform1i(this.forceLoc.uVel, 0)
    gl.uniform2i(this.forceLoc.uSize, velW, velH)
    gl.uniform1f(this.forceLoc.uDt, dt)
    gl.uniform1f(this.forceLoc.uSwirl, swirl * SWIRL_SCALE)
    gl.uniform1f(this.forceLoc.uWind, wind * WIND_SCALE)
    gl.uniform1f(this.forceLoc.uSimTime, this.simTime)
    gl.uniform1f(this.forceLoc.uAspect, this.aspect)
    gl.uniform1f(this.forceLoc.uAmbPhaseA, this.ambPhaseA)
    gl.uniform1f(this.forceLoc.uAmbPhaseB, this.ambPhaseB)
    gl.uniform1f(this.forceLoc.uAmbientRadius, AMBIENT_RADIUS)
    gl.uniform1f(this.forceLoc.uAmbientVelMag, ambientVelMag)
    gl.uniform2f(this.forceLoc.uMaxSpeed, this.maxSpeedX, this.maxSpeedY)
    gl.uniform1i(this.forceLoc.uInjectActive, inject ? 1 : 0)
    gl.uniform1i(this.forceLoc.uSplatCount, splats.length)
    if (splats.length > 0) {
      const pos = new Float32Array(MAX_SPLATS * 2)
      const vel = new Float32Array(MAX_SPLATS * 2)
      const rad = new Float32Array(MAX_SPLATS)
      splats.forEach((s, i) => {
        pos[i * 2] = s.x
        pos[i * 2 + 1] = s.y
        vel[i * 2] = s.vx
        vel[i * 2 + 1] = s.vy
        rad[i] = s.radius
      })
      gl.uniform2fv(this.forceLoc.uSplatPos, pos)
      gl.uniform2fv(this.forceLoc.uSplatVel, vel)
      gl.uniform1fv(this.forceLoc.uSplatRadius, rad)
    }
    this.fsPass.draw()
    this.velPP.swap()

    // 3. Divergence.
    this.divTarget.bindTarget()
    gl.useProgram(this.divProgram)
    this.velPP.src.bindTexture(0)
    gl.uniform1i(this.divLoc.uVel, 0)
    gl.uniform2i(this.divLoc.uSize, velW, velH)
    this.fsPass.draw()

    // 4. Pressure solve (warm-started from the previous substep's solution).
    gl.useProgram(this.pressureProgram)
    for (let i = 0; i < PRESSURE_ITERS; i++) {
      this.pressPP.dst.bindTarget()
      this.pressPP.src.bindTexture(0)
      this.divTarget.bindTexture(1)
      gl.uniform1i(this.pressureLoc.uPressure, 0)
      gl.uniform1i(this.pressureLoc.uDiv, 1)
      gl.uniform2i(this.pressureLoc.uSize, velW, velH)
      this.fsPass.draw()
      this.pressPP.swap()
    }

    // 5. Subtract pressure gradient.
    this.velPP.dst.bindTarget()
    gl.useProgram(this.gradProgram)
    this.velPP.src.bindTexture(0)
    this.pressPP.src.bindTexture(1)
    gl.uniform1i(this.gradLoc.uVel, 0)
    gl.uniform1i(this.gradLoc.uPressure, 1)
    gl.uniform2i(this.gradLoc.uSize, velW, velH)
    this.fsPass.draw()
    this.velPP.swap()

    // 6. Dye advection + colour injection.
    this.dyePP.dst.bindTarget()
    gl.useProgram(this.dyeAdvectProgram)
    this.dyePP.src.bindTexture(0)
    this.velPP.src.bindTexture(1)
    gl.uniform1i(this.dyeAdvectLoc.uDye, 0)
    gl.uniform1i(this.dyeAdvectLoc.uVel, 1)
    gl.uniform2f(this.dyeAdvectLoc.uTexel, 1 / dyeW, 1 / dyeH)
    gl.uniform1f(this.dyeAdvectLoc.uDt, dt)
    gl.uniform1f(this.dyeAdvectLoc.uDissipation, fadeDissipation)
    gl.uniform1f(this.dyeAdvectLoc.uAspect, this.aspect)
    gl.uniform1f(this.dyeAdvectLoc.uSimTime, this.simTime)
    gl.uniform1f(this.dyeAdvectLoc.uAmbPhaseA, this.ambPhaseA)
    gl.uniform1f(this.dyeAdvectLoc.uAmbPhaseB, this.ambPhaseB)
    gl.uniform1f(this.dyeAdvectLoc.uAmbientRadius, AMBIENT_RADIUS)
    gl.uniform1f(this.dyeAdvectLoc.uAmbientRate, ambientRate)
    gl.uniform3f(this.dyeAdvectLoc.uAmbientColor, ambientColor[0], ambientColor[1], ambientColor[2])
    gl.uniform1i(this.dyeAdvectLoc.uInjectActive, inject ? 1 : 0)
    gl.uniform1i(this.dyeAdvectLoc.uSplatCount, splats.length)
    if (splats.length > 0) {
      const pos = new Float32Array(MAX_SPLATS * 2)
      const color = new Float32Array(MAX_SPLATS * 3)
      const rad = new Float32Array(MAX_SPLATS)
      const bright = new Float32Array(MAX_SPLATS)
      splats.forEach((s, i) => {
        pos[i * 2] = s.x
        pos[i * 2 + 1] = s.y
        color[i * 3] = s.r
        color[i * 3 + 1] = s.g
        color[i * 3 + 2] = s.b
        rad[i] = s.radius
        bright[i] = s.bright
      })
      gl.uniform2fv(this.dyeAdvectLoc.uSplatPos, pos)
      gl.uniform3fv(this.dyeAdvectLoc.uSplatColor, color)
      gl.uniform1fv(this.dyeAdvectLoc.uSplatRadius, rad)
      gl.uniform1fv(this.dyeAdvectLoc.uSplatBright, bright)
    }
    this.fsPass.draw()
    this.dyePP.swap()

    if (applyFirst) this.pendingSplats = []
    this.simTime += dt
  }

  render(_ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)

    gl.useProgram(this.renderProgram)
    this.dyePP.src.bindTexture(0)
    gl.uniform1i(this.renderLoc.uDye, 0)
    gl.uniform2f(this.renderLoc.uRes, surface.width, surface.height)
    gl.uniform1f(this.renderLoc.uExposure, clamp(this.getParam('glow'), 0.3, 2))
    this.fsPass.draw()
  }

  resize(width: number, height: number): void {
    this.gpu.resize(width, height)
    this.gpu.gl.clearColor(0, 0, 0, 1)
    this.gpu.gl.clear(this.gpu.gl.COLOR_BUFFER_BIT)
  }

  dispose(): void {
    const gl = this.gpu.gl
    gl.deleteProgram(this.velAdvectProgram)
    gl.deleteProgram(this.forceProgram)
    gl.deleteProgram(this.divProgram)
    gl.deleteProgram(this.pressureProgram)
    gl.deleteProgram(this.gradProgram)
    gl.deleteProgram(this.dyeAdvectProgram)
    gl.deleteProgram(this.renderProgram)
    this.fsPass.dispose()
    this.velPP.dispose()
    this.dyePP.dispose()
    this.pressPP.dispose()
    this.divTarget.dispose()
  }

  private lookupVelAdvectLocs(program: WebGLProgram) {
    const gl = this.gpu.gl
    return {
      uVel: gl.getUniformLocation(program, 'uVel'),
      uTexel: gl.getUniformLocation(program, 'uTexel'),
      uDt: gl.getUniformLocation(program, 'uDt'),
      uDissipation: gl.getUniformLocation(program, 'uDissipation'),
    }
  }

  private lookupForceLocs(program: WebGLProgram): ForceLocs {
    const gl = this.gpu.gl
    return {
      uVel: gl.getUniformLocation(program, 'uVel'),
      uSize: gl.getUniformLocation(program, 'uSize'),
      uDt: gl.getUniformLocation(program, 'uDt'),
      uSwirl: gl.getUniformLocation(program, 'uSwirl'),
      uWind: gl.getUniformLocation(program, 'uWind'),
      uSimTime: gl.getUniformLocation(program, 'uSimTime'),
      uAspect: gl.getUniformLocation(program, 'uAspect'),
      uInjectActive: gl.getUniformLocation(program, 'uInjectActive'),
      uSplatCount: gl.getUniformLocation(program, 'uSplatCount'),
      uSplatPos: gl.getUniformLocation(program, 'uSplatPos'),
      uSplatVel: gl.getUniformLocation(program, 'uSplatVel'),
      uSplatRadius: gl.getUniformLocation(program, 'uSplatRadius'),
      uAmbPhaseA: gl.getUniformLocation(program, 'uAmbPhaseA'),
      uAmbPhaseB: gl.getUniformLocation(program, 'uAmbPhaseB'),
      uAmbientRadius: gl.getUniformLocation(program, 'uAmbientRadius'),
      uAmbientVelMag: gl.getUniformLocation(program, 'uAmbientVelMag'),
      uMaxSpeed: gl.getUniformLocation(program, 'uMaxSpeed'),
    }
  }

  private lookupDivLocs(program: WebGLProgram) {
    const gl = this.gpu.gl
    return {
      uVel: gl.getUniformLocation(program, 'uVel'),
      uSize: gl.getUniformLocation(program, 'uSize'),
    }
  }

  private lookupPressureLocs(program: WebGLProgram) {
    const gl = this.gpu.gl
    return {
      uPressure: gl.getUniformLocation(program, 'uPressure'),
      uDiv: gl.getUniformLocation(program, 'uDiv'),
      uSize: gl.getUniformLocation(program, 'uSize'),
    }
  }

  private lookupGradLocs(program: WebGLProgram) {
    const gl = this.gpu.gl
    return {
      uVel: gl.getUniformLocation(program, 'uVel'),
      uPressure: gl.getUniformLocation(program, 'uPressure'),
      uSize: gl.getUniformLocation(program, 'uSize'),
    }
  }

  private lookupDyeAdvectLocs(program: WebGLProgram): DyeAdvectLocs {
    const gl = this.gpu.gl
    return {
      uDye: gl.getUniformLocation(program, 'uDye'),
      uVel: gl.getUniformLocation(program, 'uVel'),
      uTexel: gl.getUniformLocation(program, 'uTexel'),
      uDt: gl.getUniformLocation(program, 'uDt'),
      uDissipation: gl.getUniformLocation(program, 'uDissipation'),
      uAspect: gl.getUniformLocation(program, 'uAspect'),
      uInjectActive: gl.getUniformLocation(program, 'uInjectActive'),
      uSplatCount: gl.getUniformLocation(program, 'uSplatCount'),
      uSplatPos: gl.getUniformLocation(program, 'uSplatPos'),
      uSplatColor: gl.getUniformLocation(program, 'uSplatColor'),
      uSplatRadius: gl.getUniformLocation(program, 'uSplatRadius'),
      uSplatBright: gl.getUniformLocation(program, 'uSplatBright'),
      uSimTime: gl.getUniformLocation(program, 'uSimTime'),
      uAmbPhaseA: gl.getUniformLocation(program, 'uAmbPhaseA'),
      uAmbPhaseB: gl.getUniformLocation(program, 'uAmbPhaseB'),
      uAmbientRadius: gl.getUniformLocation(program, 'uAmbientRadius'),
      uAmbientRate: gl.getUniformLocation(program, 'uAmbientRate'),
      uAmbientColor: gl.getUniformLocation(program, 'uAmbientColor'),
    }
  }

  private lookupRenderLocs(program: WebGLProgram) {
    const gl = this.gpu.gl
    return {
      uDye: gl.getUniformLocation(program, 'uDye'),
      uRes: gl.getUniformLocation(program, 'uRes'),
      uExposure: gl.getUniformLocation(program, 'uExposure'),
    }
  }

  getShaderSources(): ShaderStage[] {
    return [
      { key: 'force-fs', label: 'Vorticity + wind force (force-fs)', source: this.forceSource },
      { key: 'dye-advect-fs', label: 'Dye advect + inject (dye-advect-fs)', source: this.dyeAdvectSource },
      { key: 'render-fs', label: 'Display (render-fs)', source: this.renderSource },
    ]
  }

  setShaderSource(key: string, source: string): void {
    const gl = this.gpu.gl
    switch (key) {
      case 'force-fs': {
        const program = this.gpu.compileProgram(FULLSCREEN_VS, source) // throws on GLSL error; old program untouched
        gl.deleteProgram(this.forceProgram)
        this.forceProgram = program
        this.forceLoc = this.lookupForceLocs(program)
        this.forceSource = source
        return
      }
      case 'dye-advect-fs': {
        const program = this.gpu.compileProgram(FULLSCREEN_VS, source)
        gl.deleteProgram(this.dyeAdvectProgram)
        this.dyeAdvectProgram = program
        this.dyeAdvectLoc = this.lookupDyeAdvectLocs(program)
        this.dyeAdvectSource = source
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
