import { mulberry32, type Prng } from '../../core/prng'
import type { Gpu } from '../../gpu/context'
import type { RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'

/**
 * Particles family: "Swarmalators" — O'Keeffe/Hong/Strogatz 2017 swarmalators,
 * 3D, all-to-all (1/N mean-field), softened, direct O(N^2) (no octree; the
 * crossover to a Barnes-Hut approximation is ~N=2000, well above the N=800
 * cap here). Each agent carries a position AND a phase; the two couple both
 * ways — spatial proximity pulls phases together (or apart), and phase
 * similarity attracts (or repels) position — so the swarm reads as clusters
 * of synchronized colour that assemble, chase, and scatter.
 *
 * Built to the SCENE CONTRACT (docs/SCENE_CONTRACT.md) from the ground up,
 * following neuralweb3d.ts's idiom: CPU orbit-camera projection, additive
 * point sprites, and the screen-space edge-quad technique reused here for
 * per-agent trails instead of graph edges.
 *
 * DYNAMICS (see the task spec for the validated constants — none re-tuned):
 *   Δ = x_j - x_i; d2 = |Δ|^2 + eps^2; ds = sqrt(d2)
 *   c = cos(θ_j-θ_i); s = sin(θ_j-θ_i)
 *   ẋ_i += Δ*((A + J*c)/ds - B/d2);  θ̇_i += K*s/ds
 * summed over a symmetric i<j half-loop (j's contribution is the exact
 * negation), then normalized by N and θ̇_i gets its own natural frequency
 * ω_i = σ_ω * ω̂_i (ω̂_i fixed at init from the seeded PRNG). Explicit Euler at
 * a FIXED virtual model sub-step (DT_MODEL = 0.1s of model time), paced
 * against wall-clock via a clamped accumulator (R4) — never a fixed amount
 * per update() call, so 30/60/120fps land on the same simulated state at the
 * same wall-clock time.
 *
 * MUSIC MAPPINGS: a bass-transient detector (envelope + rise threshold, same
 * shape as neuralweb3d's) fires phase "kicks" — a hash-chosen fraction of
 * agents get their phase nudged by a hash-chosen sign — and drives K (the
 * phase-coupling strength, storm<->lock regime via `drive`) and J (the
 * spatial "ring-breath" via `pump`) each frame from the rms energy envelope
 * and a jPulse decay. `shimmer` widens the natural-frequency spread from the
 * spectral centroid. A KEEP-ALIVE timer fires a power=0 kick through the
 * same hash-counter machinery if no real bass hit lands for 2s, so a silent
 * or sustained bus never freezes the swarm into a static frame (the lesson
 * carried over from neuralweb3d's own keep-alive).
 *
 * `agents` (200..800 step 50) does NOT scale quality — it gates a fixed-order
 * PREFIX of the 800 agents allocated at init from the seeded PRNG. Raising it
 * is "a different piece, not a quality slider": never resampled, never
 * auto-scaled (auto-scaling would break preview=export).
 *
 * SCENE CONTRACT compliance:
 *  - render() is PURE: full opaque clear + redraw from state every call, no
 *    trail/fade quad, no framebuffer feedback. Trails are STATE — a
 *    deterministic per-agent ring buffer sampled every 2nd sub-step (model-
 *    time-keyed, so fps-invariant) inside update()/simulateStep(), and
 *    render() only reads it, drawing screen-space quad strips (neuralweb3d's
 *    edge-quad technique) with width/alpha tapering by age.
 *  - R3: the PRNG only advances at init() (positions, phases, ω̂). Kick
 *    membership/sign are a pure hash of a monotonic counter, independent of
 *    the PRNG stream and of real time.
 *  - meta.framing = 'bounded': the swarm is a composed object (like
 *    neuralweb3d's web), not a full-bleed field — portrait composition uses
 *    the short-axis "fit" convention (ax/ay below), matching neuralweb3d.
 */

// --- Shaders (same idiom as neuralweb3d: CPU-projected verts, no per-pixel maths) ---

const LINE_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec4 aColor;
out vec4 vColor;
void main() {
  vColor = aColor;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const LINE_FS = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() { outColor = vColor; }`

const POINT_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec4 aColor;
layout(location = 2) in float aSize;
out vec4 vColor;
void main() {
  vColor = aColor;
  gl_PointSize = aSize;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const POINT_FS = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() {
  // Soft round dot, premultiplied for the additive (ONE,ONE) blend so
  // overlapping light brightens.
  float d = length(gl_PointCoord - vec2(0.5));
  float a = smoothstep(0.5, 0.0, d);
  outColor = vec4(vColor.rgb * a * vColor.a, 1.0);
}`

// --- Model constants (validated by prototype — do not re-tune) --------------

const MAX_AGENTS = 800
const A = 1
const B = 1
const EPS = 0.05
const EPS2 = EPS * EPS
const DT_MODEL = 0.1
const MAX_STEPS = 12

const BASS_ENV_RATE = 5.0 // 1/s
const CENTROID_ENV_RATE = 1.0 // 1/s (tau = 1.0)
const JPULSE_DECAY_TAU = 0.6
const KEEPALIVE_SEC = 2.0
const SAFE_RADIUS = 6
const SAFE_PULL_K = 2.0

const TRAIL_LEN = 10
const TRAIL_SAMPLE_EVERY = 2 // sub-steps

// Camera (neuralweb3d idiom, swarmalators-specific constants from spec).
const ORBIT_RATE = 0.12 // rad/s
const CAM_ELEV = 0.35
const FOCAL = 1.6
const BASE_VIEW = 1.8
const CAM_DIST_K = 2.6
const NEAR_EPS = 0.15

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function smoothstep01(x: number): number {
  const t = clamp(x, 0, 1)
  return t * t * (3 - 2 * t)
}

function wrapTau(theta: number): number {
  const twoPi = Math.PI * 2
  let t = theta % twoPi
  if (t < 0) t += twoPi
  return t
}

function frac(x: number): number {
  return x - Math.floor(x)
}

/** Pure hash (kick membership/sign — see class doc). Same algorithm as neuralweb3d.ts. */
function hash32(x: number): number {
  x = (x + 0x9e3779b9) >>> 0
  x = x ^ (x >>> 16)
  x = Math.imul(x, 0x7feb352d) >>> 0
  x = x ^ (x >>> 15)
  x = Math.imul(x, 0x846ca68b) >>> 0
  x = x ^ (x >>> 16)
  return x >>> 0
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

export class SwarmalatorsScene implements SceneRuntime {
  meta = { id: 'swarmalators', name: 'Swarmalators', family: 'particles' as const, framing: 'bounded' as const }

  params: ParamSchema[] = [
    { name: 'drive', label: 'Drive', min: -1, max: 1, default: 0.7 },
    { name: 'kick', label: 'Kick', min: 0, max: 1, default: 0.7 },
    { name: 'pump', label: 'Pump', min: 0, max: 1, default: 0.5 },
    { name: 'shimmer', label: 'Shimmer', min: 0, max: 1, default: 0.35 },
    { name: 'colour', label: 'Colour', min: 0, max: 1, default: 0.85 },
    { name: 'speed', label: 'Speed', min: 2, max: 14, default: 10 },
    { name: 'agents', label: 'Agents', min: 200, max: 800, default: 500, step: 50 },
    { name: 'trail', label: 'Trail', min: 0, max: 1, default: 0.4 },
    { name: 'glow', label: 'Glow', min: 0, max: 2, default: 1 },
    { name: 'zoom', label: 'Zoom', min: 0.4, max: 3, default: 1 },
    { name: 'hueSpin', label: 'Hue spin', min: 0, max: 2, default: 0 },
    { name: 'sensitivity', label: 'Sensitivity', min: 0, max: 1, default: 0.5 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu
  private random: Prng = mulberry32(1)

  // Agent state — allocated once at MAX_AGENTS; `agents` knob gates a
  // fixed-order participating prefix (see class doc).
  private x = new Float64Array(MAX_AGENTS)
  private y = new Float64Array(MAX_AGENTS)
  private z = new Float64Array(MAX_AGENTS)
  private theta = new Float64Array(MAX_AGENTS)
  private omegaHat = new Float64Array(MAX_AGENTS)
  private rLocal = new Float32Array(MAX_AGENTS)

  // Scratch (reused across sub-steps — no per-substep allocation).
  private cTheta = new Float64Array(MAX_AGENTS)
  private sTheta = new Float64Array(MAX_AGENTS)
  private fx = new Float64Array(MAX_AGENTS)
  private fy = new Float64Array(MAX_AGENTS)
  private fz = new Float64Array(MAX_AGENTS)
  private dtheta = new Float64Array(MAX_AGENTS)
  private scAcc = new Float64Array(MAX_AGENTS)
  private ssAcc = new Float64Array(MAX_AGENTS)
  private wAcc = new Float64Array(MAX_AGENTS)

  // Deterministic per-agent trail ring buffers (state — read-only in render()).
  private trailX = new Float32Array(MAX_AGENTS * TRAIL_LEN)
  private trailY = new Float32Array(MAX_AGENTS * TRAIL_LEN)
  private trailZ = new Float32Array(MAX_AGENTS * TRAIL_LEN)
  private trailHead = new Uint8Array(MAX_AGENTS)
  private trailCount = new Uint8Array(MAX_AGENTS)
  private substepCounter = 0

  // Audio-reactive envelopes / detector state.
  private bassEnv = 0
  private armed = true
  private sinceHit = 0
  private energy = 0
  private centroidEnv = 0
  private jPulse = 0
  private kickCounter = 0
  private prevBeatPhase = 0
  private hueOffset = 0

  // Debug-probe state (getParam('#...')).
  private lastK = 0
  private modelTime = 0
  private globalOrder = 0

  // Fixed virtual sub-step accumulator (R4).
  private modelAccum = 0
  // Camera orbit angle — state, advanced only in update() (R2/R3).
  private orbitAngle = 0

  private lineProgram!: WebGLProgram
  private pointProgram!: WebGLProgram
  private lineVao!: WebGLVertexArrayObject
  private lineVbo!: WebGLBuffer
  private pointVao!: WebGLVertexArrayObject
  private pointVbo!: WebGLBuffer

  private lineVerts = new Float32Array(MAX_AGENTS * (TRAIL_LEN - 1) * 6 * 6)
  private pointVerts = new Float32Array(MAX_AGENTS * 7)

  private lineSource = LINE_FS
  private pointSource = POINT_FS

  init(gpu: Gpu, seed: number): void {
    this.gpu = gpu
    this.random = mulberry32(seed >>> 0)
    for (const p of this.params) this.values.set(p.name, p.default)

    for (let i = 0; i < MAX_AGENTS; i++) {
      // Uniform in the unit ball.
      const cosT = 2 * this.random() - 1
      const phi = this.random() * Math.PI * 2
      const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT))
      const rad = Math.cbrt(this.random())
      this.x[i] = sinT * Math.cos(phi) * rad
      this.y[i] = cosT * rad
      this.z[i] = sinT * Math.sin(phi) * rad
      this.theta[i] = this.random() * Math.PI * 2
      this.omegaHat[i] = 2 * this.random() - 1
      this.rLocal[i] = 0
      this.trailHead[i] = 0
      this.trailCount[i] = 0
    }

    this.bassEnv = 0
    this.armed = true
    this.sinceHit = 0
    this.energy = 0
    this.centroidEnv = 0
    this.jPulse = 0
    this.kickCounter = 0
    this.prevBeatPhase = 0
    this.hueOffset = 0
    this.lastK = 0
    this.modelTime = 0
    this.globalOrder = 0
    this.modelAccum = 0
    this.orbitAngle = 0
    this.substepCounter = 0

    this.lineSource = LINE_FS
    this.pointSource = POINT_FS

    const gl = gpu.gl
    this.lineProgram = gpu.compileProgram(LINE_VS, this.lineSource)
    this.pointProgram = gpu.compileProgram(POINT_VS, this.pointSource)

    this.lineVao = gl.createVertexArray()!
    this.lineVbo = gl.createBuffer()!
    gl.bindVertexArray(this.lineVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo)
    gl.bufferData(gl.ARRAY_BUFFER, this.lineVerts.byteLength, gl.DYNAMIC_DRAW)
    {
      const stride = 6 * 4
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0)
      gl.enableVertexAttribArray(1)
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 2 * 4)
    }

    this.pointVao = gl.createVertexArray()!
    this.pointVbo = gl.createBuffer()!
    gl.bindVertexArray(this.pointVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointVbo)
    gl.bufferData(gl.ARRAY_BUFFER, this.pointVerts.byteLength, gl.DYNAMIC_DRAW)
    {
      const stride = 7 * 4
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0)
      gl.enableVertexAttribArray(1)
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 2 * 4)
      gl.enableVertexAttribArray(2)
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 6 * 4)
    }
    gl.bindVertexArray(null)

    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  setParam(name: string, value: number): void {
    this.values.set(name, value)
  }

  getParam(name: string): number {
    // Debug probes (terrain.ts / neuralweb3d.ts convention): '#'-prefixed
    // names bypass the params map for the fps-equivalence test's
    // state-invariant assertions (not part of the public param schema).
    if (name === '#modelTime') return this.modelTime
    if (name === '#K') return this.lastK
    if (name === '#energy') return this.energy
    if (name === '#kicks') return this.kickCounter
    if (name === '#globalOrder') return this.globalOrder
    return this.values.get(name) ?? 0
  }

  private participantCount(): number {
    const raw = Math.round(clamp(this.getParam('agents'), 200, MAX_AGENTS) / 50) * 50
    return clamp(raw, 200, MAX_AGENTS)
  }

  // --- Kicks -----------------------------------------------------------------

  /** A hash-chosen fraction of the first `N` agents get their phase nudged by
   *  a hash-chosen sign. `power` is 0 for the keep-alive path. Deterministic:
   *  a pure hash of `kickCounter`, independent of the PRNG and of real time. */
  private applyKick(power: number, kickAmount: number, N: number): void {
    const frac_ = 0.25 + 0.25 * power
    const amp = Math.PI * (0.35 + 0.4 * power) * kickAmount
    for (let i = 0; i < N; i++) {
      const member = hash32(this.kickCounter * 92821 + i) / 4294967296
      if (member < frac_) {
        const sign = hash32(this.kickCounter * 31 + i * 7) & 1 ? 1 : -1
        this.theta[i] = wrapTau(this.theta[i] + sign * amp)
      }
    }
    this.kickCounter++
  }

  // --- Simulation --------------------------------------------------------------

  private simulateStep(dt: number, K: number, J: number, sigmaOmega: number, N: number): void {
    const { x, y, z, theta, omegaHat, cTheta, sTheta, fx, fy, fz, dtheta } = this
    for (let i = 0; i < N; i++) {
      cTheta[i] = Math.cos(theta[i])
      sTheta[i] = Math.sin(theta[i])
      fx[i] = 0
      fy[i] = 0
      fz[i] = 0
      dtheta[i] = 0
    }
    for (let i = 0; i < N; i++) {
      const xi = x[i]
      const yi = y[i]
      const zi = z[i]
      const ci = cTheta[i]
      const si = sTheta[i]
      for (let j = i + 1; j < N; j++) {
        const dx = x[j] - xi
        const dy = y[j] - yi
        const dz = z[j] - zi
        const d2 = dx * dx + dy * dy + dz * dz + EPS2
        const ds = Math.sqrt(d2)
        const cj = cTheta[j]
        const sj = sTheta[j]
        const c = cj * ci + sj * si
        const s = sj * ci - cj * si
        const coef = (A + J * c) / ds - B / d2
        const fxp = dx * coef
        const fyp = dy * coef
        const fzp = dz * coef
        fx[i] += fxp
        fy[i] += fyp
        fz[i] += fzp
        fx[j] -= fxp
        fy[j] -= fyp
        fz[j] -= fzp
        const dth = (K * s) / ds
        dtheta[i] += dth
        dtheta[j] -= dth
      }
    }
    const invN = N > 0 ? 1 / N : 0
    for (let i = 0; i < N; i++) {
      let fxi = fx[i] * invN
      let fyi = fy[i] * invN
      let fzi = fz[i] * invN
      const r = Math.sqrt(x[i] * x[i] + y[i] * y[i] + z[i] * z[i])
      // Safety: soft radial pull if |x| > SAFE_RADIUS — should never fire (the
      // A-term confines the swarm to radius ~1.1-1.5).
      if (r > SAFE_RADIUS) {
        const over = (r - SAFE_RADIUS) * SAFE_PULL_K
        fxi -= (x[i] / r) * over
        fyi -= (y[i] / r) * over
        fzi -= (z[i] / r) * over
      }
      x[i] += fxi * dt
      y[i] += fyi * dt
      z[i] += fzi * dt
      theta[i] = wrapTau(theta[i] + (dtheta[i] * invN + sigmaOmega * omegaHat[i]) * dt)
    }

    this.substepCounter++
    if (this.substepCounter % TRAIL_SAMPLE_EVERY === 0) {
      const head0 = this.trailHead
      const count0 = this.trailCount
      for (let i = 0; i < N; i++) {
        const h = head0[i]
        const base = i * TRAIL_LEN + h
        this.trailX[base] = x[i]
        this.trailY[base] = y[i]
        this.trailZ[base] = z[i]
        head0[i] = (h + 1) % TRAIL_LEN
        if (count0[i] < TRAIL_LEN) count0[i]++
      }
    }
  }

  /** Local order parameter r_i (cosmetic): computed once, after the last
   *  executed sub-step of the frame — never accumulated across sub-steps. */
  private computeLocalOrder(N: number): void {
    const { x, y, z, theta, cTheta, sTheta, scAcc, ssAcc, wAcc, rLocal } = this
    for (let i = 0; i < N; i++) {
      cTheta[i] = Math.cos(theta[i])
      sTheta[i] = Math.sin(theta[i])
      scAcc[i] = 0
      ssAcc[i] = 0
      wAcc[i] = 0
    }
    for (let i = 0; i < N; i++) {
      const xi = x[i]
      const yi = y[i]
      const zi = z[i]
      for (let j = i + 1; j < N; j++) {
        const dx = x[j] - xi
        const dy = y[j] - yi
        const dz = z[j] - zi
        const ds = Math.sqrt(dx * dx + dy * dy + dz * dz + EPS2)
        const invDs = 1 / ds
        scAcc[i] += cTheta[j] * invDs
        ssAcc[i] += sTheta[j] * invDs
        wAcc[i] += invDs
        scAcc[j] += cTheta[i] * invDs
        ssAcc[j] += sTheta[i] * invDs
        wAcc[j] += invDs
      }
    }
    for (let i = 0; i < N; i++) {
      rLocal[i] = wAcc[i] > 1e-9 ? Math.sqrt(scAcc[i] * scAcc[i] + ssAcc[i] * ssAcc[i]) / wAcc[i] : 0
    }
  }

  private computeGlobalOrder(N: number): void {
    let sumC = 0
    let sumS = 0
    for (let i = 0; i < N; i++) {
      sumC += Math.cos(this.theta[i])
      sumS += Math.sin(this.theta[i])
    }
    this.globalOrder = N > 0 ? Math.sqrt(sumC * sumC + sumS * sumS) / N : 0
  }

  update(ctx: FrameContext): void {
    const { frame, signals } = ctx
    const dt = frame.dt
    const N = this.participantCount()

    // --- Bass-transient detector (neuralweb3d idiom) ---
    const sens = clamp(this.getParam('sensitivity'), 0, 1)
    const rise = 0.2 - 0.16 * sens
    const bass = signals.get('bass')
    this.bassEnv += (bass - this.bassEnv) * (1 - Math.exp(-BASS_ENV_RATE * dt))
    const jump = bass - this.bassEnv
    this.sinceHit += dt
    const kickAmount = clamp(this.getParam('kick'), 0, 1)
    if (this.armed && jump > rise) {
      const power = clamp((jump - rise) / (2 * rise), 0, 1)
      this.applyKick(power, kickAmount, N)
      this.jPulse = Math.max(this.jPulse, 0.4 + 0.6 * power)
      this.armed = false
      this.sinceHit = 0
    } else if (!this.armed && jump < 0.4 * rise) {
      this.armed = true
    }
    if (this.sinceHit >= KEEPALIVE_SEC) {
      // power=0 keep-alive, through the same hash-counter machinery, so a
      // silent/sustained bus never freezes the swarm into a static frame.
      this.applyKick(0, kickAmount, N)
      this.sinceHit = 0
    }

    // --- Envelopes ---
    const rms = signals.get('rms')
    const tau = rms > this.energy ? 0.3 : 2.5
    this.energy += (rms - this.energy) * (1 - Math.exp(-dt / tau))
    const centroid = clamp(signals.get('centroid'), 0, 1)
    this.centroidEnv += (centroid - this.centroidEnv) * (1 - Math.exp(-dt / CENTROID_ENV_RATE))
    this.jPulse *= Math.exp(-dt / JPULSE_DECAY_TAU)

    // --- Model params for this frame's sub-steps ---
    const drive = clamp(this.getParam('drive'), -1, 1)
    const pump = clamp(this.getParam('pump'), 0, 1)
    const shimmer = clamp(this.getParam('shimmer'), 0, 1)
    const eNorm = smoothstep01((this.energy - 0.25) / (0.65 - 0.25))
    const K = drive >= 0 ? drive * -1.05 * eNorm : -drive * 0.95 * eNorm
    const J = clamp(1.0 + 0.5 * pump * this.jPulse * 2, 0, 1.6)
    const sigmaOmega = shimmer * (0.1 + 0.9 * this.centroidEnv)
    this.lastK = K

    // --- beatPhase -> hue spin (render-side common mode, not dynamics) ---
    const hueSpin = clamp(this.getParam('hueSpin'), 0, 2)
    const beatPhase = signals.get('beatPhase')
    let deltaPhase = beatPhase - this.prevBeatPhase
    if (deltaPhase > 0.5) deltaPhase -= 1
    if (deltaPhase < -0.5) deltaPhase += 1
    this.hueOffset = frac(this.hueOffset + hueSpin * deltaPhase)
    this.prevBeatPhase = beatPhase

    this.orbitAngle += ORBIT_RATE * dt

    // --- Fixed virtual sub-step accumulator (R4) ---
    const speed = clamp(this.getParam('speed'), 2, 14)
    this.modelAccum = Math.min(this.modelAccum + dt * speed, MAX_STEPS * DT_MODEL)
    let steps = 0
    while (this.modelAccum >= DT_MODEL && steps < MAX_STEPS) {
      this.simulateStep(DT_MODEL, K, J, sigmaOmega, N)
      this.modelAccum -= DT_MODEL
      this.modelTime += DT_MODEL
      steps++
    }
    if (steps > 0) this.computeLocalOrder(N)
    this.computeGlobalOrder(N)
  }

  // --- Camera / projection (neuralweb3d idiom) --------------------------------

  private camera(): { eye: [number, number, number]; right: [number, number, number]; up: [number, number, number]; fwd: [number, number, number]; dist: number } {
    const zoom = clamp(this.getParam('zoom'), 0.4, 3)
    const dist = (BASE_VIEW * CAM_DIST_K) / zoom
    const az = this.orbitAngle
    const cosE = Math.cos(CAM_ELEV)
    const sinE = Math.sin(CAM_ELEV)
    const eye: [number, number, number] = [dist * cosE * Math.cos(az), dist * sinE, dist * cosE * Math.sin(az)]
    const fl = Math.sqrt(eye[0] * eye[0] + eye[1] * eye[1] + eye[2] * eye[2]) || 1
    const fwd: [number, number, number] = [-eye[0] / fl, -eye[1] / fl, -eye[2] / fl]
    const worldUp: [number, number, number] = [0, 1, 0]
    let rx = fwd[1] * worldUp[2] - fwd[2] * worldUp[1]
    let ry = fwd[2] * worldUp[0] - fwd[0] * worldUp[2]
    let rz = fwd[0] * worldUp[1] - fwd[1] * worldUp[0]
    const rl = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1
    rx /= rl
    ry /= rl
    rz /= rl
    const ux = ry * fwd[2] - rz * fwd[1]
    const uy = rz * fwd[0] - rx * fwd[2]
    const uz = rx * fwd[1] - ry * fwd[0]
    return { eye, right: [rx, ry, rz], up: [ux, uy, uz], fwd, dist }
  }

  // --- Render (pure — see class doc) -------------------------------------------

  render(_ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    const N = this.participantCount()
    const colourSat = clamp(this.getParam('colour'), 0, 1)
    const glow = clamp(this.getParam('glow'), 0, 2)
    const trailKnob = clamp(this.getParam('trail'), 0, 1)
    // 'bounded' framing (F4): short-axis "fit" convention, matching
    // neuralweb3d.ts — the swarm is a composed object, not a full-bleed field.
    const aspect = surface.width / surface.height
    const ax = 1 / Math.max(aspect, 1)
    const ay = Math.min(aspect, 1)
    const resScale = Math.max(Math.min(surface.width, surface.height) / 720, 0.5)
    const lift = 1 + 0.25 * this.globalOrder

    const cam = this.camera()
    const { eye, right, up, fwd, dist } = cam

    const proj = (x: number, y: number, z: number) => {
      const rx = x - eye[0]
      const ry = y - eye[1]
      const rz = z - eye[2]
      const vx = rx * right[0] + ry * right[1] + rz * right[2]
      const vy = rx * up[0] + ry * up[1] + rz * up[2]
      const vz = rx * fwd[0] + ry * fwd[1] + rz * fwd[2]
      if (vz < NEAR_EPS) return null
      const ndcX = ((FOCAL * vx) / vz) * ax
      const ndcY = ((FOCAL * vy) / vz) * ay
      const depthNorm = clamp((vz - dist * 0.4) / (dist * 1.8), 0, 1)
      return { ndcX, ndcY, vz, depthNorm }
    }

    // --- Trails (screen-space quad strips, neuralweb3d edge-quad technique) ---
    const halfW = surface.width / 2
    const halfH = surface.height / 2
    let ln = 0
    const pushVert = (px: number, py: number, r: number, g: number, b: number) => {
      this.lineVerts[ln++] = px
      this.lineVerts[ln++] = py
      this.lineVerts[ln++] = r
      this.lineVerts[ln++] = g
      this.lineVerts[ln++] = b
      this.lineVerts[ln++] = 1
    }
    const baseWidthPx = 2.2 * resScale
    if (trailKnob > 0) {
      for (let i = 0; i < N; i++) {
        const count = this.trailCount[i]
        if (count < 2) continue
        const head = this.trailHead[i]
        const hue = frac(this.theta[i] / (Math.PI * 2) + this.hueOffset)
        const core = 0.35 + 0.65 * Math.pow(this.rLocal[i], 0.7)
        const [cr, cg, cb] = hsv2rgb(hue, colourSat, 1)
        // Oldest-first chronological order: index 0 = oldest surviving sample.
        let prevProj: { ndcX: number; ndcY: number; depthNorm: number } | null = null
        for (let k = 0; k < count; k++) {
          const slot = (head - count + k + TRAIL_LEN * 2) % TRAIL_LEN
          const base = i * TRAIL_LEN + slot
          const p = proj(this.trailX[base], this.trailY[base], this.trailZ[base])
          if (p) {
            if (prevProj) {
              // age: 0 = newest segment (k = count-1), 1 = oldest.
              const age = 1 - k / (count - 1)
              const depthDim = 1 - 0.65 * Math.max(prevProj.depthNorm, p.depthNorm)
              const segAlpha = (1 - age) * trailKnob * glow * core * depthDim * lift
              const halfThickPx = (baseWidthPx * (1 - age)) / 2
              const dxPix = (p.ndcX - prevProj.ndcX) * halfW
              const dyPix = (p.ndcY - prevProj.ndcY) * halfH
              const segLen = Math.sqrt(dxPix * dxPix + dyPix * dyPix) || 1
              const nx = (-dyPix / segLen) * halfThickPx
              const ny = (dxPix / segLen) * halfThickPx
              const offX = nx / halfW
              const offY = ny / halfH
              const r = cr * segAlpha
              const g = cg * segAlpha
              const b = cb * segAlpha
              const ax0 = prevProj.ndcX + offX
              const ay0 = prevProj.ndcY + offY
              const ax1 = prevProj.ndcX - offX
              const ay1 = prevProj.ndcY - offY
              const bx0 = p.ndcX + offX
              const by0 = p.ndcY + offY
              const bx1 = p.ndcX - offX
              const by1 = p.ndcY - offY
              pushVert(ax0, ay0, r, g, b)
              pushVert(ax1, ay1, r, g, b)
              pushVert(bx0, by0, r, g, b)
              pushVert(ax1, ay1, r, g, b)
              pushVert(bx1, by1, r, g, b)
              pushVert(bx0, by0, r, g, b)
            }
            prevProj = p
          } else {
            prevProj = null
          }
        }
      }
    }
    const lineVertCount = ln / 6

    // --- Agents (point sprites) ---
    let pn = 0
    const pushPoint = (px: number, py: number, r: number, g: number, b: number, sz: number) => {
      this.pointVerts[pn++] = px
      this.pointVerts[pn++] = py
      this.pointVerts[pn++] = r
      this.pointVerts[pn++] = g
      this.pointVerts[pn++] = b
      this.pointVerts[pn++] = 1
      this.pointVerts[pn++] = sz
    }
    for (let i = 0; i < N; i++) {
      const p = proj(this.x[i], this.y[i], this.z[i])
      if (!p) continue
      const depthDim = 1 - 0.65 * p.depthNorm
      const core = 0.35 + 0.65 * Math.pow(this.rLocal[i], 0.7)
      const brightness = glow * depthDim * core * lift
      const hue = frac(this.theta[i] / (Math.PI * 2) + this.hueOffset)
      const [cr, cg, cb] = hsv2rgb(hue, colourSat, 1)
      const size = clamp((6 / p.vz + 2) * resScale, 2 * resScale, 18 * resScale)
      pushPoint(p.ndcX, p.ndcY, cr * brightness, cg * brightness, cb * brightness, size)
    }
    const pointCount = pn / 7

    gl.enable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)
    gl.blendFunc(gl.ONE, gl.ONE) // additive: overlapping light brightens

    if (lineVertCount > 0) {
      gl.useProgram(this.lineProgram)
      gl.bindVertexArray(this.lineVao)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.lineVerts, 0, ln)
      gl.drawArrays(gl.TRIANGLES, 0, lineVertCount)
    }
    if (pointCount > 0) {
      gl.useProgram(this.pointProgram)
      gl.bindVertexArray(this.pointVao)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pointVbo)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.pointVerts, 0, pn)
      gl.drawArrays(gl.POINTS, 0, pointCount)
    }
    gl.bindVertexArray(null)
  }

  resize(width: number, height: number): void {
    this.gpu.resize(width, height)
    this.gpu.gl.clearColor(0, 0, 0, 1)
    this.gpu.gl.clear(this.gpu.gl.COLOR_BUFFER_BIT)
  }

  dispose(): void {
    const gl = this.gpu.gl
    gl.deleteProgram(this.lineProgram)
    gl.deleteProgram(this.pointProgram)
    gl.deleteVertexArray(this.lineVao)
    gl.deleteBuffer(this.lineVbo)
    gl.deleteVertexArray(this.pointVao)
    gl.deleteBuffer(this.pointVbo)
  }

  getShaderSources(): ShaderStage[] {
    return [
      { key: 'line-fs', label: 'Trail color (line-fs)', source: this.lineSource },
      { key: 'point-fs', label: 'Agent dot (point-fs)', source: this.pointSource },
    ]
  }

  setShaderSource(key: string, source: string): void {
    const gl = this.gpu.gl
    switch (key) {
      case 'line-fs': {
        const program = this.gpu.compileProgram(LINE_VS, source)
        gl.deleteProgram(this.lineProgram)
        this.lineProgram = program
        this.lineSource = source
        return
      }
      case 'point-fs': {
        const program = this.gpu.compileProgram(POINT_VS, source)
        gl.deleteProgram(this.pointProgram)
        this.pointProgram = program
        this.pointSource = source
        return
      }
      default:
        throw new Error(`Unknown shader stage "${key}" for scene "${this.meta.id}"`)
    }
  }
}
