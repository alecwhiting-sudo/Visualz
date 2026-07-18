import { mulberry32, type Prng } from '../../core/prng'
import type { Gpu } from '../../gpu/context'
import { checkFloatRenderable, FullscreenPass, PingPong, type RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'

/**
 * Simulation family: Wave Chamber — a 2D wave-equation field with visible
 * propagation, reflection off rotating polygon obstacles, and beat-driven
 * droplets. Architecture copied from grayscott.ts (docs/GRAYSCOTT.md): a
 * square ping-pong float texture, a fixed number of frame-clocked substeps
 * per `update()`, a sim resolution independent of screen resolution, and a
 * code layer with two editable stages (update-fs, render-fs).
 *
 * State scheme: each RGBA32F ping-pong texel packs the current height in
 * `.r` and the *previous* height in `.g` (`.ba` reserved, same convention as
 * grayscott's U/V packing). One substep of the standard 2D leapfrog wave
 * scheme is:
 *   u_next = (2*u - u_prev + c^2 * laplacian(u)) * damping
 * then the pair becomes (u_next, u) for the next substep — the classic
 * "three texture, two ping-pong slots" trick: u_next/u/u_prev are three
 * logical fields but only two need to persist at once.
 *
 * Geometry: at init, a fixed pool of MAX_WALLS regular-polygon obstacles and
 * MAX_EMITTERS ripple sources is drawn once from `mulberry32(seed)` — pool
 * layout is a pure function of seed, never of the `walls`/`emitters` params,
 * which only select how many pool entries are active (mirrors grayscott's
 * fixed 18-spot seed pool). Obstacle rotation is CPU-tracked and advanced by
 * `frame.dt * wallSpin` every update() (continuous, unconditionally stable —
 * contrast the leapfrog stepping below, which must NOT be dt-scaled).
 *
 * Onset pulses follow resonance.ts's PRNG discipline: the scene's PRNG
 * stream is advanced only at init (drawing the two pools) and once per frame
 * the onset signal reads > 0.5 (one draw pair per event, never per frame
 * otherwise) — never inside the substep loop, so replay reproduces the exact
 * same pulse-position sequence regardless of anything but the onset signal's
 * frame-indexed on/off sequence.
 */

const DEFAULT_GRID = 384
const SUBSTEPS = 3
// Fixed per-substep sim-time increment (docs pattern from grayscott.ts:
// frame-clocked, NOT dt-clocked, so a 30fps render and a 60fps live session
// step through identical wave/oscillator phases frame-for-frame).
const DT_SUB = 1 / 90

const MAX_WALLS = 5
const MAX_EMITTERS = 4

// CFL safety (2D 5-point leapfrog stability bound is Courant^2 <= 0.5): the
// base coefficient scales with `speed` but is hard-clamped well under that
// bound so no param combination (including speed=2) can destabilize the
// scheme (task-verified: speed=2, damping=0.999, walls=5, 300 frames).
const C2_BASE = 0.16
const C2_MAX = 0.22

const EMITTER_BASE_AMP = 0.032
const PULSE_BASE_AMP = 0.9
const BASS_ENV_RATE = 6 // 1/s, CPU low-pass on the bass signal (not raw)

// Attribute-less fullscreen triangle: standard gl_VertexID trick, no VBO needed.
const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`

// One leapfrog substep, run SUBSTEPS x/frame ping-ponging (see class doc).
const UPDATE_FS = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform int   uSize;
uniform float uC2, uDamping;
uniform int   uWallCount;
uniform vec2  uWallPos[5];
uniform float uWallRadius[5];
uniform float uWallSides[5];
uniform float uWallAngle[5];
uniform int   uEmitterCount;
uniform vec2  uEmitterPos[4];
uniform float uEmitterFreq[4];
uniform float uEmitterPhase[4];
uniform float uEmitterAmp;
uniform float uSimTime;
uniform float uPulseAmp;
uniform vec2  uPulsePos;
out vec4 outState;

const float PI = 3.14159265359;
const float TWO_PI = 6.28318530718;

vec2 fetchRG(ivec2 c, ivec2 hi) {           // clamped fetch (used only for the interior stencil)
  c = clamp(c, ivec2(0), hi);
  return texelFetch(uState, c, 0).rg;
}

// Regular-polygon inside test: fold the angle around the obstacle center
// into one wedge and compare against the apothem. Not an exact metric SDF
// away from the boundary, but the sign (inside/outside) is exact, which is
// all the Dirichlet mask below needs.
float wallSDF(vec2 p, float r, float sides, float rot) {
  float a = atan(p.y, p.x) - rot;
  float seg = TWO_PI / sides;
  float ang = mod(a, seg) - 0.5 * seg;
  float apothem = r * cos(PI / sides);
  return length(p) * cos(ang) - apothem;
}

bool insideWalls(vec2 st) {
  for (int i = 0; i < 5; i++) {
    if (i >= uWallCount) break;
    vec2 p = st - uWallPos[i];
    if (wallSDF(p, uWallRadius[i], uWallSides[i], uWallAngle[i]) < 0.0) return true;
  }
  return false;
}

void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  ivec2 hi = ivec2(uSize - 1);
  vec2  st = (vec2(tc) + 0.5) / float(uSize);

  // Chamber walls = the domain border (a 1-texel Dirichlet ring) plus any
  // active polygon obstacle — both clamp u to 0, giving clean reflections.
  bool border = tc.x == 0 || tc.y == 0 || tc.x == hi.x || tc.y == hi.y;
  bool wall = border || insideWalls(st);

  vec2 s = texelFetch(uState, tc, 0).rg;
  float u = s.r;
  float uPrev = s.g;

  float lap =
      fetchRG(tc + ivec2(1, 0), hi).r + fetchRG(tc + ivec2(-1, 0), hi).r
    + fetchRG(tc + ivec2(0, 1), hi).r + fetchRG(tc + ivec2(0, -1), hi).r
    - 4.0 * u;

  float uNext = (2.0 * u - uPrev + uC2 * lap) * uDamping;

  // Continuous emitters: smooth sinusoidal ripple sources, amplitude scaled
  // by a CPU-smoothed bass envelope (uEmitterAmp), each with its own PRNG-
  // drawn frequency/phase/position.
  for (int i = 0; i < 4; i++) {
    if (i >= uEmitterCount) break;
    float d = distance(st, uEmitterPos[i]);
    float falloff = exp(-d * d * 600.0);
    float osc = sin(TWO_PI * uEmitterFreq[i] * uSimTime + uEmitterPhase[i]);
    uNext += uEmitterAmp * osc * falloff;
  }

  // One-shot onset droplet (substep 0 only — see class doc / update()).
  if (uPulseAmp > 0.0) {
    float d = distance(st, uPulsePos);
    float falloff = exp(-d * d * 900.0);
    uNext += uPulseAmp * falloff;
  }

  float uOut = u;
  if (wall) { uNext = 0.0; uOut = 0.0; }

  // Defense-in-depth (task requirement: a NaN-poisoned field must be
  // impossible): the CFL clamp on uC2 already keeps this scheme bounded for
  // any finite input, but a hard numeric clamp costs nothing and forecloses
  // any possibility of unbounded growth reaching Inf/NaN downstream.
  outState = vec4(clamp(uNext, -6.0, 6.0), clamp(uOut, -6.0, 6.0), 0.0, 1.0);
}`

// Height field -> color. Slope-based lighting (manual neighbor texelFetch
// gradient, never fwidth/dFdx/dFdy — SwiftShader derivative results are not
// bit-deterministic, which would break golden/replay hashing) plus a
// deep-to-crest palette and a faint obstacle silhouette.
const RENDER_FS = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform int   uSize;
uniform vec2  uRes;
uniform float uAspect;
uniform float uHue, uExposure;
uniform int   uWallCount;
uniform vec2  uWallPos[5];
uniform float uWallRadius[5];
uniform float uWallSides[5];
uniform float uWallAngle[5];
out vec4 outColor;

const float PI = 3.14159265359;
const float TWO_PI = 6.28318530718;

vec3 hsv2rgb(vec3 c){ vec4 K=vec4(1.,2./3.,1./3.,3.); vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www); return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y); }

float wallSDF(vec2 p, float r, float sides, float rot) {
  float a = atan(p.y, p.x) - rot;
  float seg = TWO_PI / sides;
  float ang = mod(a, seg) - 0.5 * seg;
  float apothem = r * cos(PI / sides);
  return length(p) * cos(ang) - apothem;
}

// Soft silhouette band around each active obstacle's boundary. eps is a
// fixed uniform-derived pixel size (one sim texel in domain space), not a
// screen-space derivative, so this stays bit-identical across drivers.
float wallMask(vec2 st, float eps) {
  float m = 0.0;
  for (int i = 0; i < 5; i++) {
    if (i >= uWallCount) break;
    vec2 p = st - uWallPos[i];
    float d = wallSDF(p, uWallRadius[i], uWallSides[i], uWallAngle[i]);
    m = max(m, 1.0 - smoothstep(0.0, eps * 3.0, d));
  }
  return clamp(m, 0.0, 1.0);
}

// Manual bilinear from the NEAREST float state texture (texelFetch only, no
// derivative-dependent sampler filtering).
float Hat(vec2 st) {
  vec2 t = st * float(uSize) - 0.5;
  ivec2 i = ivec2(floor(t)); vec2 f = t - vec2(i); ivec2 mx = ivec2(uSize - 1);
  float h00 = texelFetch(uState, clamp(i,             ivec2(0), mx), 0).r;
  float h10 = texelFetch(uState, clamp(i+ivec2(1,0),  ivec2(0), mx), 0).r;
  float h01 = texelFetch(uState, clamp(i+ivec2(0,1),  ivec2(0), mx), 0).r;
  float h11 = texelFetch(uState, clamp(i+ivec2(1,1),  ivec2(0), mx), 0).r;
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

void main() {
  vec2 ndc = (gl_FragCoord.xy / uRes) * 2.0 - 1.0;
  ndc.x *= max(uAspect, 1.0);         // invert the min-axis fit -> square sim space
  ndc.y /= min(uAspect, 1.0);
  vec2 st = ndc * 0.5 + 0.5;

  vec3 deep = vec3(0.012, 0.02, 0.05);
  if (any(lessThan(st, vec2(0.0))) || any(greaterThan(st, vec2(1.0)))) {
    outColor = vec4(deep, 1.0);
    return;
  }

  float texel = 1.0 / float(uSize);
  float h = Hat(st);
  float gx = Hat(st + vec2(texel, 0.0)) - Hat(st - vec2(texel, 0.0));
  float gy = Hat(st + vec2(0.0, texel)) - Hat(st - vec2(0.0, texel));
  vec3 n = normalize(vec3(-gx * 5.0, -gy * 5.0, 1.0));
  float lighting = clamp(dot(n, normalize(vec3(-0.45, -0.35, 0.82))), 0.0, 1.0);

  // Sharpened crest curve (pow > 1) so near-still water reads as dark
  // background and only real wave amplitude lights up — the "luminous
  // expanding rings on a dark pool" look, not a diffuse gray wash.
  float energy = pow(clamp(abs(h) * 2.2, 0.0, 1.0), 1.5);
  vec3 crest = hsv2rgb(vec3(fract(uHue), 0.55, 1.0));
  vec3 col = mix(deep, crest, energy);
  col *= mix(0.55, 1.45, lighting);       // slope-shading: crests catch the light

  float wm = wallMask(st, texel);
  col = mix(col, vec3(0.1, 0.11, 0.14), wm * 0.85);

  outColor = vec4(clamp(col * uExposure, 0.0, 4.0), 1.0);
}`

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

interface WallSpec {
  x: number
  y: number
  radius: number
  sides: number
  angle0: number
}

interface EmitterSpec {
  x: number
  y: number
  freq: number
  phase: number
}

/**
 * Pool generation (class doc): fixed draw order, independent of the
 * `walls`/`emitters` params — walls pool (center.x, center.y, radius, sides,
 * angle0) x MAX_WALLS, then emitters pool (x, y, freq, phase) x MAX_EMITTERS.
 * The PRNG object returned continues live afterward for onset pulse draws.
 */
function makePools(seed: number): { rng: Prng; walls: WallSpec[]; emitters: EmitterSpec[] } {
  const rng = mulberry32(seed)
  const walls: WallSpec[] = []
  for (let i = 0; i < MAX_WALLS; i++) {
    const x = 0.22 + rng() * 0.56
    const y = 0.22 + rng() * 0.56
    const radius = 0.05 + rng() * 0.09
    const sides = 3 + Math.floor(rng() * 4) // 3..6 (stays visibly polygonal, not near-circular)
    const angle0 = rng() * Math.PI * 2
    walls.push({ x, y, radius, sides, angle0 })
  }
  const emitters: EmitterSpec[] = []
  for (let i = 0; i < MAX_EMITTERS; i++) {
    const x = 0.15 + rng() * 0.7
    const y = 0.15 + rng() * 0.7
    const freq = 2 + rng() * 4 // 2..6 Hz, scaled by `speed` at update time
    const phase = rng() * Math.PI * 2
    emitters.push({ x, y, freq, phase })
  }
  return { rng, walls, emitters }
}

interface UpdateLocs {
  uState: WebGLUniformLocation | null
  uSize: WebGLUniformLocation | null
  uC2: WebGLUniformLocation | null
  uDamping: WebGLUniformLocation | null
  uWallCount: WebGLUniformLocation | null
  uWallPos: WebGLUniformLocation | null
  uWallRadius: WebGLUniformLocation | null
  uWallSides: WebGLUniformLocation | null
  uWallAngle: WebGLUniformLocation | null
  uEmitterCount: WebGLUniformLocation | null
  uEmitterPos: WebGLUniformLocation | null
  uEmitterFreq: WebGLUniformLocation | null
  uEmitterPhase: WebGLUniformLocation | null
  uEmitterAmp: WebGLUniformLocation | null
  uSimTime: WebGLUniformLocation | null
  uPulseAmp: WebGLUniformLocation | null
  uPulsePos: WebGLUniformLocation | null
}

interface RenderLocs {
  uState: WebGLUniformLocation | null
  uSize: WebGLUniformLocation | null
  uRes: WebGLUniformLocation | null
  uAspect: WebGLUniformLocation | null
  uHue: WebGLUniformLocation | null
  uExposure: WebGLUniformLocation | null
  uWallCount: WebGLUniformLocation | null
  uWallPos: WebGLUniformLocation | null
  uWallRadius: WebGLUniformLocation | null
  uWallSides: WebGLUniformLocation | null
  uWallAngle: WebGLUniformLocation | null
}

export class WaveChamberScene implements SceneRuntime {
  meta = { id: 'waves', name: 'Wave Chamber', family: 'simulation' as const }

  params: ParamSchema[] = [
    { name: 'speed', label: 'Propagation speed', min: 0.2, max: 2, default: 1 },
    { name: 'damping', label: 'Damping', min: 0.9, max: 0.999, default: 0.985 },
    { name: 'emitters', label: 'Emitters', min: 0, max: 4, step: 1, default: 2 },
    { name: 'pulse', label: 'Onset pulse strength', min: 0, max: 1, default: 0.6 },
    { name: 'walls', label: 'Obstacles', min: 0, max: 5, step: 1, default: 3 },
    { name: 'wallSpin', label: 'Obstacle spin', min: -1, max: 1, default: 0.15 },
    { name: 'hue', label: 'Hue', min: 0, max: 1, default: 0.55 },
    { name: 'exposure', label: 'Exposure', min: 0.3, max: 2, default: 1 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu

  // Sim resolution (docs/GRAYSCOTT.md-pattern §0): fixed square grid,
  // independent of screen resolution/aspect. Test mode bakes a smaller grid
  // via `setGridSize()`, which MUST be called before `init()`.
  private grid = DEFAULT_GRID

  private pp!: PingPong
  private fsPass!: FullscreenPass
  private updateProgram!: WebGLProgram
  private renderProgram!: WebGLProgram
  private updateLoc!: UpdateLocs
  private renderLoc!: RenderLocs

  // Code layer (ARCHITECTURE.md §3.3).
  private updateSource = UPDATE_FS
  private renderSource = RENDER_FS

  // CPU-only state: the pools + the continuing onset-pulse PRNG stream (see
  // makePools doc), rotation angles advanced by dt, the bass envelope, and
  // the free-running sim clock (advanced by a FIXED per-substep amount every
  // update(), never by frame.dt — see class doc).
  private rng!: Prng
  private walls: WallSpec[] = []
  private emitters: EmitterSpec[] = []
  private wallAngles: number[] = []
  private bassEnv = 0
  private simClock = 0
  private pulsePos = { x: 0.5, y: 0.5 }
  private pulseAmpThisFrame = 0

  /** Test-mode-only grid override (mirrors grayscott.ts). Must run before `init()`. */
  setGridSize(n: number): void {
    this.grid = n
  }

  init(gpu: Gpu, seed: number): void {
    const caps = checkFloatRenderable(gpu)
    if (!caps.ok) throw new Error(caps.reason)

    this.gpu = gpu
    for (const p of this.params) this.values.set(p.name, p.default)

    const pools = makePools(seed)
    this.rng = pools.rng
    this.walls = pools.walls
    this.emitters = pools.emitters
    this.wallAngles = pools.walls.map((w) => w.angle0)
    this.bassEnv = 0
    this.simClock = 0
    this.pulsePos = { x: 0.5, y: 0.5 }
    this.pulseAmpThisFrame = 0

    this.updateSource = UPDATE_FS
    this.renderSource = RENDER_FS

    const gl = gpu.gl
    // Still water at t=0: both channels zero everywhere (no seeded droplets —
    // unlike grayscott's reactive nuclei, the chamber starts silent and the
    // emitters/pulses are what set it in motion).
    this.pp = new PingPong(gpu, this.grid, new Float32Array(this.grid * this.grid * 4))
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
    // Frame-clocked (see class doc): the leapfrog stepping and the emitter
    // oscillator phase both advance by a FIXED per-substep amount (DT_SUB),
    // never by frame.dt — otherwise a 30fps render and a 60fps live session
    // would diverge frame-for-frame. Obstacle rotation is the one thing here
    // that legitimately uses frame.dt: it's a plain angle integrator
    // (unconditionally stable), not part of the numerically-sensitive scheme.
    const { frame, signals } = ctx
    const gl = this.gpu.gl

    const speed = clamp(this.getParam('speed'), 0.2, 2)
    const damping = clamp(this.getParam('damping'), 0.9, 0.999)
    const emitterCount = clamp(Math.round(this.getParam('emitters')), 0, MAX_EMITTERS)
    const pulseParam = clamp(this.getParam('pulse'), 0, 1)
    const wallCount = clamp(Math.round(this.getParam('walls')), 0, MAX_WALLS)
    const wallSpin = this.getParam('wallSpin')

    for (let i = 0; i < this.wallAngles.length; i++) {
      this.wallAngles[i] += wallSpin * (0.6 + 0.15 * i) * frame.dt
    }

    const bass = signals.get('bass')
    this.bassEnv += (bass - this.bassEnv) * (1 - Math.exp(-BASS_ENV_RATE * frame.dt))
    const emitterAmp = EMITTER_BASE_AMP * (0.25 + 0.75 * this.bassEnv)

    const onset = signals.get('onset')
    this.pulseAmpThisFrame = 0
    if (onset > 0.5) {
      // PRNG discipline (resonance.ts): advance the stream only here, one
      // draw pair per onset event, never inside the substep loop.
      this.pulsePos = { x: this.rng(), y: this.rng() }
      this.pulseAmpThisFrame = PULSE_BASE_AMP * pulseParam
    }

    const c2 = clamp(C2_BASE * speed, 0, C2_MAX)

    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)
    gl.useProgram(this.updateProgram)
    gl.uniform1i(this.updateLoc.uSize, this.grid)
    gl.uniform1f(this.updateLoc.uC2, c2)
    gl.uniform1f(this.updateLoc.uDamping, damping)
    gl.uniform1i(this.updateLoc.uState, 0)

    gl.uniform1i(this.updateLoc.uWallCount, wallCount)
    gl.uniform2fv(this.updateLoc.uWallPos, this.flatWallPos())
    gl.uniform1fv(this.updateLoc.uWallRadius, this.walls.map((w) => w.radius))
    gl.uniform1fv(this.updateLoc.uWallSides, this.walls.map((w) => w.sides))
    gl.uniform1fv(this.updateLoc.uWallAngle, this.wallAngles)

    gl.uniform1i(this.updateLoc.uEmitterCount, emitterCount)
    gl.uniform2fv(this.updateLoc.uEmitterPos, this.flatEmitterPos())
    gl.uniform1fv(
      this.updateLoc.uEmitterFreq,
      this.emitters.map((e) => e.freq * speed),
    )
    gl.uniform1fv(
      this.updateLoc.uEmitterPhase,
      this.emitters.map((e) => e.phase),
    )
    gl.uniform1f(this.updateLoc.uEmitterAmp, emitterAmp)

    gl.uniform2f(this.updateLoc.uPulsePos, this.pulsePos.x, this.pulsePos.y)

    for (let i = 0; i < SUBSTEPS; i++) {
      const simTime = this.simClock + i * DT_SUB
      this.pp.dst.bindTarget()
      this.pp.src.bindTexture(0)
      gl.uniform1f(this.updateLoc.uSimTime, simTime)
      gl.uniform1f(this.updateLoc.uPulseAmp, i === 0 ? this.pulseAmpThisFrame : 0)
      this.fsPass.draw()
      this.pp.swap()
    }
    this.simClock += SUBSTEPS * DT_SUB
  }

  render(ctx: FrameContext, surface: RenderSurface): void {
    void ctx
    const gl = this.gpu.gl
    surface.bind()
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)

    const wallCount = clamp(Math.round(this.getParam('walls')), 0, MAX_WALLS)

    gl.useProgram(this.renderProgram)
    this.pp.src.bindTexture(0)
    gl.uniform1i(this.renderLoc.uState, 0)
    gl.uniform1i(this.renderLoc.uSize, this.grid)
    gl.uniform2f(this.renderLoc.uRes, surface.width, surface.height)
    gl.uniform1f(this.renderLoc.uAspect, surface.width / surface.height)
    gl.uniform1f(this.renderLoc.uHue, this.getParam('hue'))
    gl.uniform1f(this.renderLoc.uExposure, clamp(this.getParam('exposure'), 0.3, 2))

    gl.uniform1i(this.renderLoc.uWallCount, wallCount)
    gl.uniform2fv(this.renderLoc.uWallPos, this.flatWallPos())
    gl.uniform1fv(this.renderLoc.uWallRadius, this.walls.map((w) => w.radius))
    gl.uniform1fv(this.renderLoc.uWallSides, this.walls.map((w) => w.sides))
    gl.uniform1fv(this.renderLoc.uWallAngle, this.wallAngles)

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

  private flatWallPos(): Float32Array {
    const out = new Float32Array(MAX_WALLS * 2)
    for (let i = 0; i < this.walls.length; i++) {
      out[i * 2] = this.walls[i].x
      out[i * 2 + 1] = this.walls[i].y
    }
    return out
  }

  private flatEmitterPos(): Float32Array {
    const out = new Float32Array(MAX_EMITTERS * 2)
    for (let i = 0; i < this.emitters.length; i++) {
      out[i * 2] = this.emitters[i].x
      out[i * 2 + 1] = this.emitters[i].y
    }
    return out
  }

  private lookupUpdateLocs(program: WebGLProgram): UpdateLocs {
    const gl = this.gpu.gl
    return {
      uState: gl.getUniformLocation(program, 'uState'),
      uSize: gl.getUniformLocation(program, 'uSize'),
      uC2: gl.getUniformLocation(program, 'uC2'),
      uDamping: gl.getUniformLocation(program, 'uDamping'),
      uWallCount: gl.getUniformLocation(program, 'uWallCount'),
      uWallPos: gl.getUniformLocation(program, 'uWallPos[0]'),
      uWallRadius: gl.getUniformLocation(program, 'uWallRadius[0]'),
      uWallSides: gl.getUniformLocation(program, 'uWallSides[0]'),
      uWallAngle: gl.getUniformLocation(program, 'uWallAngle[0]'),
      uEmitterCount: gl.getUniformLocation(program, 'uEmitterCount'),
      uEmitterPos: gl.getUniformLocation(program, 'uEmitterPos[0]'),
      uEmitterFreq: gl.getUniformLocation(program, 'uEmitterFreq[0]'),
      uEmitterPhase: gl.getUniformLocation(program, 'uEmitterPhase[0]'),
      uEmitterAmp: gl.getUniformLocation(program, 'uEmitterAmp'),
      uSimTime: gl.getUniformLocation(program, 'uSimTime'),
      uPulseAmp: gl.getUniformLocation(program, 'uPulseAmp'),
      uPulsePos: gl.getUniformLocation(program, 'uPulsePos'),
    }
  }

  private lookupRenderLocs(program: WebGLProgram): RenderLocs {
    const gl = this.gpu.gl
    return {
      uState: gl.getUniformLocation(program, 'uState'),
      uSize: gl.getUniformLocation(program, 'uSize'),
      uRes: gl.getUniformLocation(program, 'uRes'),
      uAspect: gl.getUniformLocation(program, 'uAspect'),
      uHue: gl.getUniformLocation(program, 'uHue'),
      uExposure: gl.getUniformLocation(program, 'uExposure'),
      uWallCount: gl.getUniformLocation(program, 'uWallCount'),
      uWallPos: gl.getUniformLocation(program, 'uWallPos[0]'),
      uWallRadius: gl.getUniformLocation(program, 'uWallRadius[0]'),
      uWallSides: gl.getUniformLocation(program, 'uWallSides[0]'),
      uWallAngle: gl.getUniformLocation(program, 'uWallAngle[0]'),
    }
  }

  getShaderSources(): ShaderStage[] {
    return [
      { key: 'update-fs', label: 'Wave propagation update (update-fs)', source: this.updateSource },
      { key: 'render-fs', label: 'Height field render (render-fs)', source: this.renderSource },
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
