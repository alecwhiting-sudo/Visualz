import { mulberry32, type Prng } from '../../core/prng'
import type { Gpu } from '../../gpu/context'
import { checkFloatRenderable, FloatTarget, FullscreenPass, PingPong, type RenderSurface } from '../../gpu/targets'
import { snapCountToSide, DEFAULT_COUNT, DEFAULT_SIDE } from '../families/particles/gpgpu'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'

/**
 * Simulation family wildcard: Physarum (Jones 2010) slime-mold transport
 * networks. A square grid of `side*side` agents (RGBA32F ping-pong: xy =
 * position in toroidal [0,1) UV space, z = heading radians, w = a fixed
 * per-agent speed-jitter drawn once at seed time) senses a chemoattractant
 * trail field at three points ahead-left/ahead/ahead-right, turns toward the
 * strongest, steps forward, and deposits. The trail (a second RGBA32F
 * ping-pong, same `side`, `.r` = density) diffuses (3x3 blur) and decays each
 * frame. Three fixed GPU passes run every `update()` regardless of `dt`
 * (docs pattern: grayscott.ts's fixed-substep discipline) so live and
 * render-mode playback take identical simulation steps:
 *
 *   1. agent step  — reads trail (bilinear, toroidal-wrapped `texelFetch`,
 *      never `texture()`/derivatives — SwiftShader determinism, see
 *      ARCHITECTURE.md §5) at the three sensor points, turns, moves, wraps.
 *   2. deposit      — agents drawn as 1-texel points, additively blended
 *      into an RGBA8 "deposit mask" (float-target blending needs
 *      EXT_float_blend, which isn't guaranteed; RGBA8 blending is core
 *      WebGL2, so the mask is 8-bit and the float trail pass below reads it
 *      with a plain `texelFetch`, not blend).
 *   3. diffuse+decay — normalized 3x3 blur of the previous trail, scaled by
 *      `decay`, plus the deposit mask scaled by `deposit`, written to the
 *      trail ping-pong's `dst`.
 *
 * Agent count / trail resolution share one square grid `side` (both quality
 * and trail detail scale together), controlled by the same `?count=`
 * test-hook convention flowfield.ts uses (docs/PARTICLES.md's ladder,
 * `snapCountToSide` — 256*256 = 65536 agents desktop default). `count` is
 * deliberately NOT one of the 8 declared `params` (task spec: exactly 8, in
 * order) — it's a `setParam` special case, same asymmetry as flowfield's.
 */

const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`

// Pass 1 (docs class comment): sense-turn-move. MOVE_STEP/TURN_STEP are fixed
// per-frame scales (NOT `dt`-multiplied — sim steps are frame-clocked, same
// invariant as grayscott's Euler substeps) that turn the knob ranges into
// gentle, curving motion instead of instant teleports/spins; without them the
// default turnSpeed=3 (radians) would let an agent snap almost all the way
// around in a single frame and the network would read as noise, not veins.
const AGENT_FS = `#version 300 es
precision highp float;
uniform sampler2D uAgentState;
uniform sampler2D uTrail;
uniform int   uSide;
uniform float uSensorAngle, uSensorDist, uTurnSpeed, uMoveSpeed, uScatterActive;
uniform uint  uOnsetSeed;
out vec4 outState;

const float TAU = 6.28318530718;
const float MOVE_STEP = 0.0035;
const float TURN_STEP = 0.03;
const float SCATTER_FRACTION = 0.15;

uint hash32(uint x){ x=x+0x9e3779b9u; x^=x>>16u; x*=0x7feb352du; x^=x>>15u; x*=0x846ca68bu; x^=x>>16u; return x; }

// Bilinear sample of the trail field, toroidally wrapped (agents wrap via
// fract() below, so the field they sense must wrap the same way). Manual
// texelFetch bilinear like grayscott.ts's Vat function — never texture(), which
// implicitly reaches for derivative-based LOD selection even on a
// single-level texture (ARCHITECTURE.md §5's SwiftShader determinism note).
float trailAt(vec2 uv){
  vec2 p = fract(uv) * float(uSide) - 0.5;
  ivec2 i0 = ivec2(floor(p));
  vec2 f = p - vec2(i0);
  ivec2 n = ivec2(uSide);
  ivec2 i00 = ((i0            ) % n + n) % n;
  ivec2 i10 = ((i0+ivec2(1,0)) % n + n) % n;
  ivec2 i01 = ((i0+ivec2(0,1)) % n + n) % n;
  ivec2 i11 = ((i0+ivec2(1,1)) % n + n) % n;
  float v00 = texelFetch(uTrail, i00, 0).r;
  float v10 = texelFetch(uTrail, i10, 0).r;
  float v01 = texelFetch(uTrail, i01, 0).r;
  float v11 = texelFetch(uTrail, i11, 0).r;
  return mix(mix(v00, v10, f.x), mix(v01, v11, f.x), f.y);
}

float sense(vec2 pos, float angle){
  return trailAt(pos + vec2(cos(angle), sin(angle)) * uSensorDist);
}

void main(){
  ivec2 tc = ivec2(gl_FragCoord.xy);
  int idx = tc.y * uSide + tc.x;
  vec4 s = texelFetch(uAgentState, tc, 0);
  vec2 pos = s.xy;
  float heading = s.z;
  float jitter = s.w;

  float cA = sense(pos, heading);
  float cL = sense(pos, heading + uSensorAngle);
  float cR = sense(pos, heading - uSensorAngle);

  // Deterministic tie-break (task spec): prefer straight, then left.
  if (cA >= cL && cA >= cR) {
    // straight: heading unchanged
  } else if (cL >= cR) {
    heading += uTurnSpeed * TURN_STEP;
  } else {
    heading -= uTurnSpeed * TURN_STEP;
  }

  // Onset scatter: a hash of (agent id, onset counter uniform) decides which
  // fraction of agents re-roll to a fresh heading this frame — NOT per-agent
  // CPU randomness re-issued each event (task spec) — uOnsetSeed is drawn
  // once per onset frame on the CPU (resonance.ts's PRNG-advances-on-onset
  // discipline) and every agent hashes against the same counter deterministically.
  if (uScatterActive > 0.5) {
    uint h = hash32(uint(idx) * 2654435761u ^ uOnsetSeed);
    float r = float(hash32(h)) / 4294967296.0;
    if (r < SCATTER_FRACTION) {
      heading = (float(hash32(h + 1u)) / 4294967296.0) * TAU;
    }
  }

  pos += vec2(cos(heading), sin(heading)) * (uMoveSpeed * MOVE_STEP * jitter);
  pos = fract(pos); // toroidal wrap

  outState = vec4(pos, heading, jitter);
}`

// Pass 2: agents rendered as 1-texel points, additively blended (core WebGL2
// RGBA8 blending — no EXT_float_blend dependency, see class doc) into a
// per-frame deposit mask cleared before this pass runs.
const DEPOSIT_VS = `#version 300 es
precision highp float;
uniform sampler2D uAgentState;
uniform int uSide;
void main(){
  int i = gl_VertexID;
  vec4 s = texelFetch(uAgentState, ivec2(i % uSide, i / uSide), 0);
  gl_Position = vec4(s.xy * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}`

// Each hit adds a SMALL fraction (PER_HIT), not a saturating 1.0: the mask is
// an RGBA8 target (core WebGL2 blending, see class doc), so a naive 1.0-per-
// hit write saturates the very first agent that touches a texel and every
// texel with >=1 visitor reads back identical to one with 50 — with agent
// count roughly matching texel count (this scene's shared `side`), nearly
// every texel gets >=1 visitor most frames, so that binary mask floods the
// whole trail field to a uniform wash with no contrast (the "static noise or
// uniform mush" failure mode the task spec warns about). PER_HIT keeps up to
// ~1/PER_HIT overlapping agents distinguishable before the channel clips, so
// TRAIL_FS can recover an approximate visit *count* per texel instead of a
// yes/no flag — busy converging corridors read visibly denser than lightly-
// grazed background, which is what lets sensing's positive feedback loop
// carve out filaments instead of an even film.
const DEPOSIT_FS = `#version 300 es
precision highp float;
out vec4 outColor;
const float PER_HIT = 0.06;
void main(){ outColor = vec4(PER_HIT, 0.0, 0.0, 0.0); }`

// Pass 3: normalized 3x3 blur (weights sum to 1: 0.25 center + 4*0.125 edges
// + 4*0.0625 corners) times decay, plus this frame's deposit mask (undoing
// DEPOSIT_FS's PER_HIT compression, then BASE_DEPOSIT converts a ~1-visit/
// texel/frame background rate into a low steady-state trail level so the
// deposit param's usable range sits well below the render pass's tone-map
// saturation point — headroom the positive-feedback ridges climb into that a
// uniformly-saturated background could never show contrast against).
// Toroidal wrap on the blur taps matches the agents' own wraparound topology.
const TRAIL_FS = `#version 300 es
precision highp float;
uniform sampler2D uPrevTrail;
uniform sampler2D uMask;
uniform int   uSide;
uniform float uDecay, uDeposit;
out vec4 outState;

const float PER_HIT = 0.06;
const float BASE_DEPOSIT = 0.05;

float rd(ivec2 c){
  ivec2 n = ivec2(uSide);
  c = ((c % n) + n) % n;
  return texelFetch(uPrevTrail, c, 0).r;
}

void main(){
  ivec2 tc = ivec2(gl_FragCoord.xy);
  float blur =
      0.25   * rd(tc)
    + 0.125  * (rd(tc+ivec2(1,0)) + rd(tc+ivec2(-1,0)) + rd(tc+ivec2(0,1)) + rd(tc+ivec2(0,-1)))
    + 0.0625 * (rd(tc+ivec2(1,1)) + rd(tc+ivec2(-1,1)) + rd(tc+ivec2(1,-1)) + rd(tc+ivec2(-1,-1)));
  float hits = texelFetch(uMask, tc, 0).r / PER_HIT;
  outState = vec4(blur * uDecay + hits * BASE_DEPOSIT * uDeposit, 0.0, 0.0, 1.0);
}`

// Final display pass (editable, task spec §2): tone-mapped glow + two-tone
// palette (deep body / hot core) driven by `hue`, subtle exposure gamma.
// Aspect-fit like grayscott.ts's Vat/RENDER_FS (min-axis spans [-1,1],
// background shown outside the unit square).
const RENDER_FS = `#version 300 es
precision highp float;
uniform sampler2D uTrail;
uniform int   uSide;
uniform vec2  uRes;
uniform float uAspect, uHue, uExposure;
out vec4 outColor;

vec3 hsv2rgb(vec3 c){ vec4 K=vec4(1.,2./3.,1./3.,3.); vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www); return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y); }

// Clamped-edge bilinear (grayscott.ts's Vat function): the render pass only ever
// samples inside [0,1], so edge clamping (vs. the agent pass's toroidal
// wrap) is visually indistinguishable and keeps this stage's code simple.
float trailAt(vec2 st){
  vec2 t = st*float(uSide) - 0.5;
  ivec2 i = ivec2(floor(t)); vec2 f = t - vec2(i); ivec2 mx = ivec2(uSide-1);
  float v00=texelFetch(uTrail,clamp(i,           ivec2(0),mx),0).r;
  float v10=texelFetch(uTrail,clamp(i+ivec2(1,0),ivec2(0),mx),0).r;
  float v01=texelFetch(uTrail,clamp(i+ivec2(0,1),ivec2(0),mx),0).r;
  float v11=texelFetch(uTrail,clamp(i+ivec2(1,1),ivec2(0),mx),0).r;
  return mix(mix(v00,v10,f.x), mix(v01,v11,f.x), f.y);
}

void main(){
  vec2 ndc = (gl_FragCoord.xy/uRes)*2.0 - 1.0;
  ndc.x *= max(uAspect,1.0);
  ndc.y /= min(uAspect,1.0);
  vec2 st = ndc*0.5 + 0.5;
  vec3 bg = vec3(0.01, 0.012, 0.02);
  if (any(lessThan(st, vec2(0.0))) || any(greaterThan(st, vec2(1.0)))) { outColor = vec4(bg, 1.0); return; }

  float d = trailAt(st);
  float glow = 1.0 - exp(-0.7 * d); // tone-map: unbounded density -> [0,1)

  float hueBody = fract(uHue);
  float hueCore = fract(uHue + 0.08);
  vec3 bodyColor = hsv2rgb(vec3(hueBody, 0.85, 0.55));
  vec3 coreColor = hsv2rgb(vec3(hueCore, 0.25, 1.0));
  vec3 col = mix(bodyColor, coreColor, smoothstep(0.2, 0.9, glow)) * glow;

  col = pow(clamp(col * uExposure, 0.0, 4.0), vec3(0.85)); // subtle exposure + gamma
  outColor = vec4(clamp(bg + col, 0.0, 1.0), 1.0);
}`

const BASS_DEPOSIT_GAIN = 1.2 // "networks thicken on the low end" (task spec §3)
const RMS_SPEED_GAIN = 0.25 // "modulates agent speed slightly"
const SPEED_JITTER_MIN = 0.85
const SPEED_JITTER_SPREAD = 0.3

/**
 * CPU seed (mulberry32(seed), independent stream from the class's own onset
 * `rng` — same "two independent draws from the same numeric seed" pattern
 * used elsewhere, e.g. flowfield's `seedFlowState` vs. its class has none,
 * but resonance's onset stream is the direct precedent for the *other*
 * stream here): uniform position in [0,1)^2, uniform heading in [0,2*PI),
 * and a fixed per-agent speed-jitter multiplier for organic, non-uniform
 * motion.
 */
export function seedPhysarumState(seed: number, n: number): Float32Array {
  const rng = mulberry32(seed)
  const out = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) {
    out[i * 4 + 0] = rng()
    out[i * 4 + 1] = rng()
    out[i * 4 + 2] = rng() * Math.PI * 2
    out[i * 4 + 3] = SPEED_JITTER_MIN + rng() * SPEED_JITTER_SPREAD
  }
  return out
}

function drawSeed(rng: Prng): number {
  return Math.floor(rng() * 4294967296) >>> 0
}

interface AgentLocs {
  uAgentState: WebGLUniformLocation | null
  uTrail: WebGLUniformLocation | null
  uSide: WebGLUniformLocation | null
  uSensorAngle: WebGLUniformLocation | null
  uSensorDist: WebGLUniformLocation | null
  uTurnSpeed: WebGLUniformLocation | null
  uMoveSpeed: WebGLUniformLocation | null
  uScatterActive: WebGLUniformLocation | null
  uOnsetSeed: WebGLUniformLocation | null
}

interface DepositLocs {
  uAgentState: WebGLUniformLocation | null
  uSide: WebGLUniformLocation | null
}

interface TrailLocs {
  uPrevTrail: WebGLUniformLocation | null
  uMask: WebGLUniformLocation | null
  uSide: WebGLUniformLocation | null
  uDecay: WebGLUniformLocation | null
  uDeposit: WebGLUniformLocation | null
}

interface RenderLocs {
  uTrail: WebGLUniformLocation | null
  uSide: WebGLUniformLocation | null
  uRes: WebGLUniformLocation | null
  uAspect: WebGLUniformLocation | null
  uHue: WebGLUniformLocation | null
  uExposure: WebGLUniformLocation | null
}

export class PhysarumScene implements SceneRuntime {
  meta = { id: 'physarum', name: 'Physarum', family: 'simulation' as const }

  params: ParamSchema[] = [
    { name: 'sensorAngle', label: 'Sensor angle', min: 0.1, max: 1.2, default: 0.45 },
    { name: 'sensorDist', label: 'Sensor distance', min: 0.002, max: 0.06, default: 0.018 },
    { name: 'turnSpeed', label: 'Turn speed', min: 0.5, max: 8, default: 3 },
    { name: 'moveSpeed', label: 'Move speed', min: 0.2, max: 3, default: 1 },
    { name: 'deposit', label: 'Deposit', min: 0.2, max: 3, default: 1 },
    { name: 'decay', label: 'Decay', min: 0.85, max: 0.99, default: 0.94 },
    { name: 'hue', label: 'Hue', min: 0, max: 1, default: 0.45 },
    { name: 'exposure', label: 'Exposure', min: 0.3, max: 2, default: 1 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu
  private seed = 0
  private side = DEFAULT_SIDE
  private pendingSide: number | null = null

  // Onset-driven scatter (resonance.ts's PRNG discipline): `rng` is advanced
  // ONLY once at init and once per onset-active frame — never per-agent,
  // never per-frame otherwise. `onsetSeed` is the last draw, uploaded as a
  // uint uniform every frame (AGENT_FS's `uScatterActive` gates whether it's
  // actually used that frame).
  private rng!: Prng
  private onsetSeed = 0

  private agentPP!: PingPong
  private trailPP!: PingPong
  private maskTarget!: FloatTarget
  private fsPass!: FullscreenPass
  private pointsVao!: WebGLVertexArrayObject

  private agentProgram!: WebGLProgram
  private depositProgram!: WebGLProgram
  private trailProgram!: WebGLProgram
  private renderProgram!: WebGLProgram
  private agentLoc!: AgentLocs
  private depositLoc!: DepositLocs
  private trailLoc!: TrailLocs
  private renderLoc!: RenderLocs

  // Code layer (ARCHITECTURE.md §3.3): current source per editable stage,
  // reset to stock defaults every init(). The deposit pass is a fixed
  // mechanical blit (like flowfield's fade pass) and is intentionally not
  // exposed here.
  private agentSource = AGENT_FS
  private trailSource = TRAIL_FS
  private renderSource = RENDER_FS

  init(gpu: Gpu, seed: number): void {
    const caps = checkFloatRenderable(gpu)
    if (!caps.ok) throw new Error(caps.reason)

    this.gpu = gpu
    this.seed = seed
    this.side = DEFAULT_SIDE
    this.pendingSide = null
    for (const p of this.params) this.values.set(p.name, p.default)
    this.values.set('count', DEFAULT_COUNT)

    this.rng = mulberry32(seed)
    this.onsetSeed = drawSeed(this.rng)

    this.agentSource = AGENT_FS
    this.trailSource = TRAIL_FS
    this.renderSource = RENDER_FS

    const gl = gpu.gl
    this.agentPP = new PingPong(gpu, this.side, seedPhysarumState(seed, this.side * this.side))
    this.trailPP = new PingPong(gpu, this.side, new Float32Array(this.side * this.side * 4))
    this.maskTarget = new FloatTarget(gpu, this.side, undefined, 'rgba8')
    this.fsPass = new FullscreenPass(gpu)

    this.agentProgram = gpu.compileProgram(FULLSCREEN_VS, this.agentSource)
    this.depositProgram = gpu.compileProgram(DEPOSIT_VS, DEPOSIT_FS)
    this.trailProgram = gpu.compileProgram(FULLSCREEN_VS, this.trailSource)
    this.renderProgram = gpu.compileProgram(FULLSCREEN_VS, this.renderSource)

    this.agentLoc = this.lookupAgentLocs(this.agentProgram)
    this.depositLoc = this.lookupDepositLocs(this.depositProgram)
    this.trailLoc = this.lookupTrailLocs(this.trailProgram)
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
    const { signals } = ctx
    const gl = this.gpu.gl

    // Grid re-init (docs/PARTICLES.md §6 pattern via flowfield.ts): applied
    // at the top of the next update(), same "hard reset, no resize-in-place"
    // contract as the particle family.
    if (this.pendingSide !== null) {
      this.side = this.pendingSide
      this.pendingSide = null
      this.agentPP.resize(this.side, seedPhysarumState(this.seed, this.side * this.side))
      this.trailPP.resize(this.side, new Float32Array(this.side * this.side * 4))
      this.maskTarget.dispose()
      this.maskTarget = new FloatTarget(this.gpu, this.side, undefined, 'rgba8')
    }

    const bass = signals.get('bass')
    const rms = signals.get('rms')
    const onset = signals.get('onset')

    const scatterActive = onset > 0.5 ? 1 : 0
    if (scatterActive) {
      // One draw per onset-active frame — resonance.ts's discipline (see
      // class field doc). Held-high onset signals (as in test harnesses)
      // therefore draw once per frame they're held, same as resonance/grayscott.
      this.onsetSeed = drawSeed(this.rng)
    }

    const sensorAngle = this.getParam('sensorAngle')
    const sensorDist = this.getParam('sensorDist')
    const turnSpeed = this.getParam('turnSpeed')
    const moveSpeed = this.getParam('moveSpeed') * (1 + RMS_SPEED_GAIN * rms)
    const deposit = this.getParam('deposit') * (1 + BASS_DEPOSIT_GAIN * bass)
    const decay = this.getParam('decay')

    gl.disable(gl.DEPTH_TEST)

    // Pass 1: agent step.
    gl.disable(gl.BLEND)
    this.agentPP.dst.bindTarget()
    gl.useProgram(this.agentProgram)
    this.agentPP.src.bindTexture(0)
    this.trailPP.src.bindTexture(1)
    gl.uniform1i(this.agentLoc.uAgentState, 0)
    gl.uniform1i(this.agentLoc.uTrail, 1)
    gl.uniform1i(this.agentLoc.uSide, this.side)
    gl.uniform1f(this.agentLoc.uSensorAngle, sensorAngle)
    gl.uniform1f(this.agentLoc.uSensorDist, sensorDist)
    gl.uniform1f(this.agentLoc.uTurnSpeed, turnSpeed)
    gl.uniform1f(this.agentLoc.uMoveSpeed, moveSpeed)
    gl.uniform1f(this.agentLoc.uScatterActive, scatterActive)
    gl.uniform1ui(this.agentLoc.uOnsetSeed, this.onsetSeed)
    this.fsPass.draw()
    this.agentPP.swap()

    // Pass 2: deposit — clear the mask, then additively splat NEW agent
    // positions (post-swap `src`) as 1-texel points. RGBA8 blending is core
    // WebGL2 (no EXT_float_blend needed — see class doc).
    this.maskTarget.bindTarget()
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE)
    gl.useProgram(this.depositProgram)
    this.agentPP.src.bindTexture(0)
    gl.uniform1i(this.depositLoc.uAgentState, 0)
    gl.uniform1i(this.depositLoc.uSide, this.side)
    gl.bindVertexArray(this.pointsVao)
    gl.drawArrays(gl.POINTS, 0, this.side * this.side)
    gl.bindVertexArray(null)
    gl.disable(gl.BLEND)

    // Pass 3: diffuse + decay.
    this.trailPP.dst.bindTarget()
    gl.useProgram(this.trailProgram)
    this.trailPP.src.bindTexture(0)
    this.maskTarget.bindTexture(1)
    gl.uniform1i(this.trailLoc.uPrevTrail, 0)
    gl.uniform1i(this.trailLoc.uMask, 1)
    gl.uniform1i(this.trailLoc.uSide, this.side)
    gl.uniform1f(this.trailLoc.uDecay, decay)
    gl.uniform1f(this.trailLoc.uDeposit, deposit)
    this.fsPass.draw()
    this.trailPP.swap()
  }

  render(_ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)

    gl.useProgram(this.renderProgram)
    this.trailPP.src.bindTexture(0)
    gl.uniform1i(this.renderLoc.uTrail, 0)
    gl.uniform1i(this.renderLoc.uSide, this.side)
    gl.uniform2f(this.renderLoc.uRes, surface.width, surface.height)
    gl.uniform1f(this.renderLoc.uAspect, surface.width / surface.height)
    gl.uniform1f(this.renderLoc.uHue, this.getParam('hue'))
    gl.uniform1f(this.renderLoc.uExposure, this.getParam('exposure'))
    this.fsPass.draw()
  }

  resize(width: number, height: number): void {
    this.gpu.resize(width, height)
    this.gpu.gl.clearColor(0, 0, 0, 1)
    this.gpu.gl.clear(this.gpu.gl.COLOR_BUFFER_BIT)
  }

  dispose(): void {
    const gl = this.gpu.gl
    gl.deleteProgram(this.agentProgram)
    gl.deleteProgram(this.depositProgram)
    gl.deleteProgram(this.trailProgram)
    gl.deleteProgram(this.renderProgram)
    gl.deleteVertexArray(this.pointsVao)
    this.fsPass.dispose()
    this.agentPP.dispose()
    this.trailPP.dispose()
    this.maskTarget.dispose()
  }

  private lookupAgentLocs(program: WebGLProgram): AgentLocs {
    const gl = this.gpu.gl
    return {
      uAgentState: gl.getUniformLocation(program, 'uAgentState'),
      uTrail: gl.getUniformLocation(program, 'uTrail'),
      uSide: gl.getUniformLocation(program, 'uSide'),
      uSensorAngle: gl.getUniformLocation(program, 'uSensorAngle'),
      uSensorDist: gl.getUniformLocation(program, 'uSensorDist'),
      uTurnSpeed: gl.getUniformLocation(program, 'uTurnSpeed'),
      uMoveSpeed: gl.getUniformLocation(program, 'uMoveSpeed'),
      uScatterActive: gl.getUniformLocation(program, 'uScatterActive'),
      uOnsetSeed: gl.getUniformLocation(program, 'uOnsetSeed'),
    }
  }

  private lookupDepositLocs(program: WebGLProgram): DepositLocs {
    const gl = this.gpu.gl
    return {
      uAgentState: gl.getUniformLocation(program, 'uAgentState'),
      uSide: gl.getUniformLocation(program, 'uSide'),
    }
  }

  private lookupTrailLocs(program: WebGLProgram): TrailLocs {
    const gl = this.gpu.gl
    return {
      uPrevTrail: gl.getUniformLocation(program, 'uPrevTrail'),
      uMask: gl.getUniformLocation(program, 'uMask'),
      uSide: gl.getUniformLocation(program, 'uSide'),
      uDecay: gl.getUniformLocation(program, 'uDecay'),
      uDeposit: gl.getUniformLocation(program, 'uDeposit'),
    }
  }

  private lookupRenderLocs(program: WebGLProgram): RenderLocs {
    const gl = this.gpu.gl
    return {
      uTrail: gl.getUniformLocation(program, 'uTrail'),
      uSide: gl.getUniformLocation(program, 'uSide'),
      uRes: gl.getUniformLocation(program, 'uRes'),
      uAspect: gl.getUniformLocation(program, 'uAspect'),
      uHue: gl.getUniformLocation(program, 'uHue'),
      uExposure: gl.getUniformLocation(program, 'uExposure'),
    }
  }

  getShaderSources(): ShaderStage[] {
    return [
      { key: 'agent-fs', label: 'Agent sense/turn/move (agent-fs)', source: this.agentSource },
      { key: 'trail-fs', label: 'Trail diffuse+decay (trail-fs)', source: this.trailSource },
      { key: 'render-fs', label: 'Field render (render-fs)', source: this.renderSource },
    ]
  }

  setShaderSource(key: string, source: string): void {
    const gl = this.gpu.gl
    switch (key) {
      case 'agent-fs': {
        const program = this.gpu.compileProgram(FULLSCREEN_VS, source) // throws on GLSL error; old program untouched
        gl.deleteProgram(this.agentProgram)
        this.agentProgram = program
        this.agentLoc = this.lookupAgentLocs(program)
        this.agentSource = source
        return
      }
      case 'trail-fs': {
        const program = this.gpu.compileProgram(FULLSCREEN_VS, source)
        gl.deleteProgram(this.trailProgram)
        this.trailProgram = program
        this.trailLoc = this.lookupTrailLocs(program)
        this.trailSource = source
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
