import type { Gpu } from '../../gpu/context'
import type { RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'
import { mulberry32 } from '../../core/prng'

/**
 * "Whip Storm" (geometry family, task #47) — a STORM of Whip Line's verlet
 * whips: several independent chains instead of one, dancing apart on bass
 * swells and re-entwining in the breakdowns, throwing sparks off the walls.
 *
 * This file deliberately does NOT import anything from `./whipline.ts` (a
 * sibling agent is concurrently reworking it) — the proven architecture below
 * (verlet chain, frame-clocked substeps, bounded rest-length rotation kick,
 * triangle-strip ribbons with taper, beat-snapshot echo ring) is COPIED and
 * adapted, not shared, so this scene's determinism never depends on whipline's
 * in-flight edits.
 *
 * Multiple whips (task spec): `whips` (2..6) independent chains, N=32
 * particles each (lighter than whipline's 48 — several chains run per frame).
 * All WHIPS_MAX=6 chains are always seeded and stepped-into-existence at
 * init() regardless of the live `whips` value (preallocated everything); only
 * the first `whipsCount` (rounded/clamped live) are simulated/rendered each
 * frame, so raising `whips` mid-take activates chains that were already
 * seeded with valid, deterministic state, and lowering it simply stops
 * updating/drawing the tail chains (no special-case reset needed).
 *
 * Per-whip variation, chosen ONCE at init() from the scene's seeded PRNG
 * (mulberry32(seed) — never `Math.random`, never re-consumed after init): a
 * length tier in [0.75, 1.25] (`tier[w]`) and a small angular jitter on its
 * seed direction, so the storm's chains read as a family of related-but-
 * distinct whips, not six identical clones fanned out symmetrically.
 *
 * Complementary palette: each whip's hue is the SAME continuously-advancing/
 * beat-stepped `huePhase` whipline uses, offset by `w / whipsCount` around
 * the wheel — i.e. hues are always evenly spaced around the color wheel for
 * however many whips are currently active (2 whips = literal complements,
 * 4 = a balanced quad), so the palette self-balances as `whips` changes live.
 *
 * MAGNETIC INTERPLAY (new): every substep, a pairwise inverse-distance force
 * (softened, hard-clamped, and perfectly antisymmetric — Newton's third law,
 * so it can never inject net momentum) acts between every pair of whip HEAD
 * particles (index N-1, the outermost tip). Its sign comes from
 * `magnet * bassSign`, where `bassSign = 1 - 2*swell` and `swell` is a
 * dt-based exponential follower of the `bass` signal clamped to [0,1] — so
 * `bassSign` is +1 when the bass is quiet and -1 during a bass swell.
 * `magnet > 0` therefore reads as "attract when quiet, repel on the swell";
 * `magnet < 0` inverts it. The force magnitude is clamped to `MAGNET_MAX_F`
 * BEFORE it ever reaches a velocity, so no combination of `magnet`,
 * `whips`, `length`, or `dispersion` can make this term unstable — proven by
 * the extremes test (whips=6, magnet=±1, 300 frames, finite + byte-identical
 * across two independent runs).
 *
 * WALL SPARKS (new): every particle (not just heads) that reflects off a
 * wall above `SPARK_VEL_THRESHOLD` spawns a short-lived radial burst from a
 * PREALLOCATED pool of `SPARK_SLOTS` slots x `SPARK_POINTS` points each,
 * oldest slot recycled round-robin. A spark's point directions/speeds come
 * from `sparkHash(impactCounter, pointIndex)` — a pure integer hash, NOT a
 * draw from the scene's PRNG stream (that stream is init()-only, per the
 * hard rules) — so replay is byte-identical regardless of how many sparks
 * fire, and the pool's behavior is independently exercised by a
 * `sparks=0` vs `sparks=1` pixel-hash test. `sparks=0` disables spawning
 * and drawing entirely (an explicit early-out, not just zero alpha).
 *
 * Echoes: same beat-snapshot ring-buffer idea as whipline, but PER WHIP and
 * smaller — `RING_CAPACITY_PER_WHIP=8` slots, `ECHO_DRAW_COUNT=3` ghost sets
 * drawn by default (not a live param — the task's exact 8-param budget has
 * no room left for an echo-count knob, unlike whipline's `echoes`/`beatDiv`).
 * A capture snapshots every active whip's full chain on the SAME per-beat
 * pulse (`signals.get('beat') === 1`), never per-frame otherwise.
 *
 * Coordinate scheme, wall bounces, differential-rotation kick, and ribbon
 * geometry are whipline's proven approach verbatim (see its class doc for
 * the full "why" — same reasoning applies unchanged per-whip here): physics
 * runs in aspect-independent "logical" space; `buildRibbon()` applies the
 * scene's aspect-fit on the CPU before computing tangents/normals so ribbons
 * are never skewed by a non-square viewport; the rotation kick's magnitude
 * uses each whip's IDEAL rest-length radius (bounded torque), never its
 * live/stretched distance (which would positive-feedback into a tangle).
 *
 * Code layer: 'line-fs' (ribbons, echoes, AND sparks all share this program —
 * sparks just draw the same VAO/VBO as `gl.POINTS` instead of
 * `TRIANGLE_STRIP`, reusing the color/alpha uniforms) and 'fade-fs' (trail).
 */

const WHIPS_MAX = 6 // preallocated chain slots regardless of the live `whips` value
const N = 32 // particles per chain — lighter than whipline's 48 (several chains/frame)
const SUBSTEPS = 4 // frame-clocked (not dt-scaled) verlet substeps per update()
const DT_SUB = 1 / 240 // fixed virtual substep, matches whipline's determinism discipline
const RELAX_ITERS = 6 // constraint-relaxation iterations per substep
const DAMPING = 0.985 // per-substep velocity retention (whipline's tuned value, reused)
const KICK_SCALE = 0.045 // rotation-drive attenuation (whipline's tuned value, reused)
const ROT_SPEED = 1 // fixed internal rotation rate (no live knob — 8-param budget)
const TENSION = 0.85 // fixed internal constraint stiffness
const BOUNCE = 0.8 // fixed internal wall restitution

const RING_CAPACITY_PER_WHIP = 8 // preallocated echo ring-buffer slots, per whip
const ECHO_DRAW_COUNT = 3 // ghost sets drawn per whip by default (not a live param)

const HUE_DRIFT_RATE = 0.03 // continuous hue creep, 1/s (whipline's rate, reused)
const HUE_BEAT_STEP = 0.055 // extra hue jump fired once per beat pulse
const PULSE_DECAY_RATE = 5 // 1/s exponential decay of the beat-brightness envelope
const ONSET_DECAY_RATE = 7 // 1/s decay of the onset-flash envelope (snappier than beat)

// Ribbon geometry: fixed real screen-space half-width in NDC (no live `thickness`
// knob here — several thinner ribbons read more clearly as a storm than one
// thick one). TAPER_MIN tapers each whip's tail ends, same profile as whipline.
const HALF_WIDTH = 0.0032
const TAPER_MIN = 0.55

// --- Magnetic interplay (task spec §2) --------------------------------------
const MAGNET_STRENGTH = 0.5 // base pairwise-force scale
const MAGNET_SOFTEN = 0.08 // softening length, prevents a 1/dist singularity
const MAGNET_MAX_F = 6 // hard clamp on any single pair's force magnitude
const MAGNET_KICK_SCALE = 0.05 // extra attenuation applied when the force becomes a velocity delta
const BASS_FOLLOW_RATE = 4 // 1/s, dt-based exponential follower on the `bass` signal

// --- Wall sparks (task spec §3) ---------------------------------------------
const SPARK_SLOTS = 12 // preallocated spark-burst pool, oldest recycled round-robin
const SPARK_POINTS = 6 // points per burst
const SPARK_LIFETIME = 0.4 // seconds a spark burst stays visible
const SPARK_MIN_SPEED = 0.15 // logical units/second, radial burst speed range
const SPARK_MAX_SPEED = 0.6
const SPARK_VEL_THRESHOLD = 0.01 // per-substep displacement magnitude that counts as "struck hard"

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** Differential-rotation angular rate for particle `i` (0-indexed, N total) —
 * identical generalization to whipline's: `rotSpeed` at the inner end,
 * `rotSpeed*dispersion` at the outer end, linear between. */
function computeOmega(rotSpeed: number, dispersion: number, i: number): number {
  return rotSpeed * (1 + (dispersion - 1) * (i / (N - 1)))
}

/** Tangential drive-kick velocity for particle `i` of ONE chain: direction
 * follows its CURRENT position relative to `pivot` (that chain's own inner
 * end), magnitude uses the chain's IDEAL rest-length radius (`restLen * i`)
 * — see class doc / whipline's doc for why that bound is what keeps a whip
 * from feedback-amplifying into a tangle. */
function kickVector(
  i: number,
  px: number,
  py: number,
  pivotX: number,
  pivotY: number,
  omega: number,
  restLen: number,
): { kx: number; ky: number } {
  const dxp = px - pivotX
  const dyp = py - pivotY
  const dist = Math.sqrt(dxp * dxp + dyp * dyp)
  if (dist < 1e-6) return { kx: 0, ky: 0 }
  const ux = dxp / dist
  const uy = dyp / dist
  const idealR = restLen * i
  return { kx: -uy * idealR * omega, ky: ux * idealR * omega }
}

/** Pure integer hash for spark point directions/speeds — a function of
 * (impactCounter, pointIndex) only, NOT the scene's PRNG stream (hard rule:
 * randomness after init() must never consume `Math.random`/an ongoing PRNG
 * draw that would desync replay-vs-live if impact COUNT ever differed by
 * timing jitter; a pure hash is immune to that by construction). */
function sparkHash(a: number, b: number): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h = h ^ (h >>> 16)
  return (h >>> 0) / 4294967296
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h * 12) % 12
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return [f(0), f(8), f(4)]
}

const PASSTHROUGH_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
  gl_PointSize = 6.0; // only honored when drawn as gl.POINTS (sparks) — harmless otherwise
}`

const LINE_FS = `#version 300 es
precision highp float;
uniform vec3 uColor;
uniform float uAlpha;
out vec4 outColor;
void main() {
  outColor = vec4(uColor, uAlpha);
}`

const FADE_FS = `#version 300 es
precision highp float;
uniform float uFade;
out vec4 outColor;
void main() { outColor = vec4(0.0, 0.0, 0.0, uFade); }`

export class WhipStormScene implements SceneRuntime {
  meta = { id: 'whipstorm', name: 'Whip Storm', family: 'geometry' as const }

  // Order is a contract: exactly 8 params, this order (task spec).
  params: ParamSchema[] = [
    { name: 'whips', label: 'Whips', min: 2, max: 6, step: 1, default: 4 },
    { name: 'length', label: 'Length', min: 0.3, max: 1.6, default: 1.05 },
    { name: 'dispersion', label: 'Dispersion', min: 1, max: 4, default: 2 },
    { name: 'magnet', label: 'Magnet', min: -1, max: 1, default: 0.4 },
    { name: 'sparks', label: 'Sparks', min: 0, max: 1, default: 0.7 },
    { name: 'drive', label: 'Drive', min: 0, max: 1, default: 0.5 },
    { name: 'trail', label: 'Trail', min: 0.7, max: 0.995, default: 0.85 },
    { name: 'pulse', label: 'Beat pulse', min: 0, max: 1, default: 0.6 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu

  private lineProgram!: WebGLProgram
  private fadeProgram!: WebGLProgram
  private lineVao!: WebGLVertexArrayObject
  private lineVbo!: WebGLBuffer
  private fadeVao!: WebGLVertexArrayObject

  private lineSource = LINE_FS
  private fadeSource = FADE_FS

  // --- Verlet chains: flat WHIPS_MAX*N arrays, idx = w*N + i -----------------
  private posX = new Float32Array(WHIPS_MAX * N)
  private posY = new Float32Array(WHIPS_MAX * N)
  private prevX = new Float32Array(WHIPS_MAX * N)
  private prevY = new Float32Array(WHIPS_MAX * N)
  private tier = new Float32Array(WHIPS_MAX) // per-whip length multiplier, 0.75..1.25 (PRNG, init only)
  private baseRestLen = new Float32Array(WHIPS_MAX) // fixed at init, per whip
  private restLen = new Float32Array(WHIPS_MAX) // this frame's effective rest length per whip

  // --- Ribbon-builder scratch (reused across every whip's head + echo draws) -
  private ndcX = new Float32Array(N)
  private ndcY = new Float32Array(N)
  private ribbonVerts = new Float32Array(N * 4) // 2 verts/point * 2 floats/vert

  // --- Beat-echo ring buffers, per whip (preallocated at RING_CAPACITY_PER_WHIP)
  private ringPosX: Float32Array[][] = []
  private ringPosY: Float32Array[][] = []
  private ringHue: Float32Array[] = []
  private ringWrite = new Int32Array(WHIPS_MAX)
  private ringCount = new Int32Array(WHIPS_MAX)

  // --- Color / brightness state -----------------------------------------------
  private huePhase = 0
  private pulseEnv = 0
  private onsetEnv = 0

  // --- Magnetic interplay state -------------------------------------------
  private bassFollower = 0
  private magAccelX = new Float32Array(WHIPS_MAX)
  private magAccelY = new Float32Array(WHIPS_MAX)

  // --- Wall-spark pool (preallocated) -----------------------------------------
  private sparkOriginX = new Float32Array(SPARK_SLOTS)
  private sparkOriginY = new Float32Array(SPARK_SLOTS)
  private sparkHue = new Float32Array(SPARK_SLOTS)
  private sparkSpawnTime = new Float32Array(SPARK_SLOTS)
  private sparkVelX = new Float32Array(SPARK_SLOTS * SPARK_POINTS)
  private sparkVelY = new Float32Array(SPARK_SLOTS * SPARK_POINTS)
  private sparkVerts = new Float32Array(SPARK_POINTS * 2) // scratch for one burst's draw
  private sparkWrite = 0
  private impactCounter = 0

  private currentTime = 0 // this frame's frame.time, cached for spawnSpark()/render()

  init(gpu: Gpu, seed: number): void {
    this.gpu = gpu
    for (const p of this.params) this.values.set(p.name, p.default)

    this.lineSource = LINE_FS
    this.fadeSource = FADE_FS

    const prng = mulberry32(seed)

    const aspect = gpu.width / gpu.height
    const Wy = Math.max(1 / aspect, 1)

    // Seed all WHIPS_MAX chains, always — only the live `whips` count is
    // simulated/rendered each frame, but every slot must hold valid state so
    // raising `whips` mid-take activates an already-consistent chain.
    for (let w = 0; w < WHIPS_MAX; w++) {
      this.tier[w] = 0.75 + prng() * 0.5 // 0.75..1.25
      const jitter = (prng() - 0.5) * 0.15 // small angular variation, radians
      const theta = -Math.PI / 2 + (w * (2 * Math.PI)) / WHIPS_MAX + jitter

      const reach = Wy * this.tier[w] // this chain's initial seed length (length=1.0 equivalent)
      this.baseRestLen[w] = reach / (N - 1)

      const base = w * N
      const cosT = Math.cos(theta)
      const sinT = Math.sin(theta)
      for (let i = 0; i < N; i++) {
        const t = i / (N - 1)
        const x = t * reach * cosT
        const y = t * reach * sinT
        this.posX[base + i] = x
        this.posY[base + i] = y
        this.prevX[base + i] = x
        this.prevY[base + i] = y
      }
    }

    const lengthParam = clamp(this.getParam('length'), 0.3, 1.6)
    for (let w = 0; w < WHIPS_MAX; w++) this.restLen[w] = this.baseRestLen[w] * lengthParam

    // Seed the initial swirl per whip ("it begins to rotate") — one-off
    // full-strength tangential kick, encoded exactly as update()'s continuous
    // kick is (see kickVector()/integrate()).
    const dispersion0 = clamp(this.getParam('dispersion'), 1, 4)
    for (let w = 0; w < WHIPS_MAX; w++) {
      const base = w * N
      const pivotX = this.posX[base]
      const pivotY = this.posY[base]
      for (let i = 0; i < N; i++) {
        const omega = computeOmega(ROT_SPEED, dispersion0, i)
        const { kx, ky } = kickVector(i, this.posX[base + i], this.posY[base + i], pivotX, pivotY, omega, this.restLen[w])
        const vx = kx * DT_SUB
        const vy = ky * DT_SUB
        this.prevX[base + i] = this.posX[base + i] - vx
        this.prevY[base + i] = this.posY[base + i] - vy
      }
    }

    this.ringPosX = []
    this.ringPosY = []
    this.ringHue = []
    for (let w = 0; w < WHIPS_MAX; w++) {
      const px: Float32Array[] = []
      const py: Float32Array[] = []
      for (let r = 0; r < RING_CAPACITY_PER_WHIP; r++) {
        px.push(new Float32Array(N))
        py.push(new Float32Array(N))
      }
      this.ringPosX.push(px)
      this.ringPosY.push(py)
      this.ringHue.push(new Float32Array(RING_CAPACITY_PER_WHIP))
    }
    this.ringWrite.fill(0)
    this.ringCount.fill(0)

    this.huePhase = 0
    this.pulseEnv = 0
    this.onsetEnv = 0
    this.bassFollower = 0
    this.magAccelX.fill(0)
    this.magAccelY.fill(0)

    this.sparkOriginX.fill(0)
    this.sparkOriginY.fill(0)
    this.sparkHue.fill(0)
    this.sparkSpawnTime.fill(-1000) // far enough in the past to read as "dead" from frame 0
    this.sparkVelX.fill(0)
    this.sparkVelY.fill(0)
    this.sparkWrite = 0
    this.impactCounter = 0
    this.currentTime = 0

    const gl = gpu.gl
    this.lineProgram = gpu.compileProgram(PASSTHROUGH_VS, this.lineSource)
    this.fadeProgram = gpu.compileProgram(PASSTHROUGH_VS, this.fadeSource)

    this.lineVao = gl.createVertexArray()!
    this.lineVbo = gl.createBuffer()!
    gl.bindVertexArray(this.lineVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo)
    gl.bufferData(gl.ARRAY_BUFFER, this.ribbonVerts.byteLength, gl.DYNAMIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    this.fadeVao = gl.createVertexArray()!
    const quad = gl.createBuffer()!
    gl.bindVertexArray(this.fadeVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)

    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  setParam(name: string, value: number): void {
    this.values.set(name, value)
  }

  getParam(name: string): number {
    return this.values.get(name) ?? 0
  }

  /** Hue for whip `w` out of `whipsCount` currently active — evenly spaced
   * around the wheel from the same continuously-advancing/beat-stepped
   * `huePhase` every whip shares (spec: "complementary hue offsets ... spaced
   * TAU/whips around a slowly-advancing base"). */
  private whipHue(w: number, whipsCount: number): number {
    return (this.huePhase + w / whipsCount) % 1
  }

  update(ctx: FrameContext): void {
    const { frame, signals } = ctx
    this.currentTime = frame.time

    const whipsCount = clamp(Math.round(this.getParam('whips')), 2, WHIPS_MAX)
    const dispersion = clamp(this.getParam('dispersion'), 1, 4)
    const magnet = clamp(this.getParam('magnet'), -1, 1)
    const sparksParam = clamp(this.getParam('sparks'), 0, 1)
    const drive = clamp(this.getParam('drive'), 0, 1)
    const lengthParam = clamp(this.getParam('length'), 0.3, 1.6)

    for (let w = 0; w < WHIPS_MAX; w++) this.restLen[w] = this.baseRestLen[w] * lengthParam

    const aspect = this.gpu.width / this.gpu.height
    const Wx = Math.max(aspect, 1)
    const Wy = Math.max(1 / aspect, 1)

    // Bass follower -> signed polarity ("attract when quiet, repel on the
    // swell" for magnet > 0; inverted for magnet < 0). dt-based exponential
    // smoothing so it is frame-rate-independent and replay-deterministic
    // (a pure function of the `bass` signal stream and frame.dt, nothing else).
    const bass = clamp(signals.get('bass'), 0, 1)
    this.bassFollower += (bass - this.bassFollower) * (1 - Math.exp(-BASS_FOLLOW_RATE * frame.dt))
    const swell = clamp(this.bassFollower, 0, 1)
    const bassSign = 1 - 2 * swell
    const polarity = magnet * bassSign

    for (let s = 0; s < SUBSTEPS; s++) {
      this.computeMagnetAccel(whipsCount, polarity)
      this.integrate(whipsCount, dispersion, drive, Wx, Wy, sparksParam)
      for (let k = 0; k < RELAX_ITERS; k++) this.relax(whipsCount)
    }

    this.huePhase = (this.huePhase + HUE_DRIFT_RATE * frame.dt) % 1
    const beat = signals.get('beat')
    if (beat === 1) {
      this.huePhase = (this.huePhase + HUE_BEAT_STEP) % 1
      this.pulseEnv = 1
    } else {
      this.pulseEnv *= Math.exp(-PULSE_DECAY_RATE * frame.dt)
    }

    if (signals.get('onset')) {
      this.onsetEnv = 1
    } else {
      this.onsetEnv *= Math.exp(-ONSET_DECAY_RATE * frame.dt)
    }

    if (beat === 1) {
      for (let w = 0; w < whipsCount; w++) this.captureEcho(w, whipsCount)
    }
  }

  /** Pairwise force between every pair of whip HEAD particles (index N-1),
   * softened + hard-clamped + perfectly antisymmetric (Newton's third law —
   * cannot inject net momentum, cannot blow up regardless of `magnet`,
   * `whips`, `length`, or `dispersion`). Fills `magAccelX`/`magAccelY`, one
   * scalar force-vector per whip, applied to that whip's head in integrate(). */
  private computeMagnetAccel(whipsCount: number, polarity: number): void {
    this.magAccelX.fill(0)
    this.magAccelY.fill(0)
    for (let i = 0; i < whipsCount; i++) {
      const hi = i * N + (N - 1)
      const hix = this.posX[hi]
      const hiy = this.posY[hi]
      for (let j = i + 1; j < whipsCount; j++) {
        const hj = j * N + (N - 1)
        const dx = hix - this.posX[hj]
        const dy = hiy - this.posY[hj]
        const dist = Math.sqrt(dx * dx + dy * dy)
        const invDist = dist > 1e-6 ? 1 / dist : 0
        const ux = dx * invDist
        const uy = dy * invDist
        let f = (MAGNET_STRENGTH * polarity) / (dist + MAGNET_SOFTEN)
        f = clamp(f, -MAGNET_MAX_F, MAGNET_MAX_F)
        // f > 0 (attract): pulls i toward j and j toward i.
        this.magAccelX[i] -= ux * f
        this.magAccelY[i] -= uy * f
        this.magAccelX[j] += ux * f
        this.magAccelY[j] += uy * f
      }
    }
  }

  /** One verlet substep for every active whip: velocity-from-prevPos
   * integration, the differential tangential drive kick, the magnetic head
   * kick, then wall-bounce reflection (which may spawn a spark). Constraint
   * relaxation runs separately, right after, in relax(). */
  private integrate(whipsCount: number, dispersion: number, drive: number, Wx: number, Wy: number, sparksParam: number): void {
    for (let w = 0; w < whipsCount; w++) {
      const base = w * N
      const pivotX = this.posX[base]
      const pivotY = this.posY[base]
      const restLen = this.restLen[w]

      for (let i = 0; i < N; i++) {
        const idx = base + i
        const px = this.posX[idx]
        const py = this.posY[idx]
        let vx = (px - this.prevX[idx]) * DAMPING
        let vy = (py - this.prevY[idx]) * DAMPING

        const omega = computeOmega(ROT_SPEED, dispersion, i)
        const { kx, ky } = kickVector(i, px, py, pivotX, pivotY, omega, restLen)
        vx += kx * DT_SUB * drive * KICK_SCALE
        vy += ky * DT_SUB * drive * KICK_SCALE

        if (i === N - 1) {
          vx += this.magAccelX[w] * DT_SUB * MAGNET_KICK_SCALE
          vy += this.magAccelY[w] * DT_SUB * MAGNET_KICK_SCALE
        }

        let nx = px + vx
        let ny = py + vy
        const preSpeed = Math.sqrt(vx * vx + vy * vy)
        let bounced = false

        if (nx > Wx) {
          nx = Wx
          vx = -vx * BOUNCE
          bounced = true
        } else if (nx < -Wx) {
          nx = -Wx
          vx = -vx * BOUNCE
          bounced = true
        }
        if (ny > Wy) {
          ny = Wy
          vy = -vy * BOUNCE
          bounced = true
        } else if (ny < -Wy) {
          ny = -Wy
          vy = -vy * BOUNCE
          bounced = true
        }

        if (bounced && sparksParam > 0 && preSpeed > SPARK_VEL_THRESHOLD) {
          this.spawnSpark(nx, ny, this.whipHue(w, whipsCount))
        }

        this.posX[idx] = nx
        this.posY[idx] = ny
        this.prevX[idx] = nx - vx
        this.prevY[idx] = ny - vy
      }
    }
  }

  /** Position-based constraint relaxation for every active whip: pulls every
   * consecutive pair back toward that whip's own `restLen`. */
  private relax(whipsCount: number): void {
    for (let w = 0; w < whipsCount; w++) {
      const base = w * N
      const rest = this.restLen[w]
      for (let i = 0; i < N - 1; i++) {
        const a = base + i
        const b = a + 1
        const dx = this.posX[b] - this.posX[a]
        const dy = this.posY[b] - this.posY[a]
        const dist = Math.sqrt(dx * dx + dy * dy) || 1e-6
        const corr = (0.5 * TENSION * (dist - rest)) / dist
        const cx = dx * corr
        const cy = dy * corr
        this.posX[a] += cx
        this.posY[a] += cy
        this.posX[b] -= cx
        this.posY[b] -= cy
      }
    }
  }

  /** Spawn (or recycle-and-respawn) one spark burst at `(ox, oy)`. Point
   * directions/speeds are a pure hash of `(impactCounter, pointIndex)` — see
   * `sparkHash()` doc for why this must NOT touch the scene's PRNG stream. */
  private spawnSpark(ox: number, oy: number, hue: number): void {
    const slot = this.sparkWrite
    this.sparkOriginX[slot] = ox
    this.sparkOriginY[slot] = oy
    this.sparkHue[slot] = hue
    this.sparkSpawnTime[slot] = this.currentTime
    for (let p = 0; p < SPARK_POINTS; p++) {
      const angle = sparkHash(this.impactCounter, p * 2) * Math.PI * 2
      const speedT = sparkHash(this.impactCounter, p * 2 + 1)
      const speed = SPARK_MIN_SPEED + speedT * (SPARK_MAX_SPEED - SPARK_MIN_SPEED)
      const vIdx = slot * SPARK_POINTS + p
      this.sparkVelX[vIdx] = Math.cos(angle) * speed
      this.sparkVelY[vIdx] = Math.sin(angle) * speed
    }
    this.sparkWrite = (this.sparkWrite + 1) % SPARK_SLOTS
    this.impactCounter += 1
  }

  /** Snapshot whip `w`'s full chain into its next ring slot — called once
   * per beat pulse for every active whip simultaneously. */
  private captureEcho(w: number, whipsCount: number): void {
    const base = w * N
    const slot = this.ringWrite[w]
    this.ringPosX[w][slot].set(this.posX.subarray(base, base + N))
    this.ringPosY[w][slot].set(this.posY.subarray(base, base + N))
    this.ringHue[w][slot] = this.whipHue(w, whipsCount)
    this.ringWrite[w] = (slot + 1) % RING_CAPACITY_PER_WHIP
    this.ringCount[w] = Math.min(RING_CAPACITY_PER_WHIP, this.ringCount[w] + 1)
  }

  /** Builds a TRIANGLE_STRIP ribbon (2*N vertices, into `this.ribbonVerts`)
   * for one chain's `(x, y)` in logical space — identical technique to
   * whipline's `buildRibbon()` (see its doc): aspect-fit to NDC, central-
   * difference tangent, ±halfWidth offset along the normal, tapered ends. */
  private buildRibbon(x: Float32Array, y: Float32Array, halfWidth: number, aspect: number): void {
    const kx = 1 / Math.max(aspect, 1)
    const ky = Math.min(aspect, 1)
    for (let i = 0; i < N; i++) {
      this.ndcX[i] = x[i] * kx
      this.ndcY[i] = y[i] * ky
    }

    let lastTx = 0
    let lastTy = 1
    for (let i = 0; i < N; i++) {
      const ax = i > 0 ? i - 1 : i
      const bx = i < N - 1 ? i + 1 : i
      let tx = this.ndcX[bx] - this.ndcX[ax]
      let ty = this.ndcY[bx] - this.ndcY[ax]
      const len = Math.sqrt(tx * tx + ty * ty)
      if (len > 1e-8) {
        tx /= len
        ty /= len
        lastTx = tx
        lastTy = ty
      } else {
        tx = lastTx
        ty = lastTy
      }
      const nx = -ty
      const ny = tx

      const t = i / (N - 1)
      const w = halfWidth * (TAPER_MIN + (1 - TAPER_MIN) * Math.sin(Math.PI * t))

      const px = this.ndcX[i]
      const py = this.ndcY[i]
      this.ribbonVerts[i * 4 + 0] = px + nx * w
      this.ribbonVerts[i * 4 + 1] = py + ny * w
      this.ribbonVerts[i * 4 + 2] = px - nx * w
      this.ribbonVerts[i * 4 + 3] = py - ny * w
    }
  }

  render(ctx: FrameContext, surface: RenderSurface): void {
    void ctx
    const gl = this.gpu.gl
    surface.bind()
    const aspect = surface.width / surface.height

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    gl.useProgram(this.fadeProgram)
    gl.uniform1f(gl.getUniformLocation(this.fadeProgram, 'uFade'), 1 - clamp(this.getParam('trail'), 0.7, 0.995))
    gl.bindVertexArray(this.fadeVao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    gl.useProgram(this.lineProgram)
    gl.bindVertexArray(this.lineVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo)

    const whipsCount = clamp(Math.round(this.getParam('whips')), 2, WHIPS_MAX)
    const pulseParam = clamp(this.getParam('pulse'), 0, 1)
    const uColorLoc = gl.getUniformLocation(this.lineProgram, 'uColor')
    const uAlphaLoc = gl.getUniformLocation(this.lineProgram, 'uAlpha')

    for (let w = 0; w < whipsCount; w++) {
      const hue = this.whipHue(w, whipsCount)
      const available = Math.min(ECHO_DRAW_COUNT, this.ringCount[w])

      for (let rank = available; rank >= 1; rank--) {
        const slot = (this.ringWrite[w] - rank + RING_CAPACITY_PER_WHIP * 2) % RING_CAPACITY_PER_WHIP
        const age = available > 1 ? (rank - 1) / (available - 1) : 0 // 0 (newest) .. 1 (oldest)
        const alpha = 0.5 - 0.35 * age
        const lightness = 0.5 - 0.12 * age
        const [r, g, b] = hsl(this.ringHue[w][slot], 0.82, lightness)
        this.buildRibbon(this.ringPosX[w][slot], this.ringPosY[w][slot], HALF_WIDTH, aspect)
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.ribbonVerts)
        gl.uniform3f(uColorLoc, r, g, b)
        gl.uniform1f(uAlphaLoc, clamp(alpha, 0, 1))
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, N * 2)
      }

      const pulseBoost = pulseParam * this.pulseEnv * 0.3 + pulseParam * this.onsetEnv * 0.25
      const headLightness = clamp(0.52 + pulseBoost, 0, 0.95)
      const [hr, hg, hb] = hsl(hue, 0.82, headLightness)
      const base = w * N
      this.buildRibbon(this.posX.subarray(base, base + N), this.posY.subarray(base, base + N), HALF_WIDTH, aspect)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.ribbonVerts)
      gl.uniform3f(uColorLoc, hr, hg, hb)
      gl.uniform1f(uAlphaLoc, 1)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, N * 2)
    }

    // Wall sparks — drawn last (on top), as punctuation, not noise.
    const sparksParam = clamp(this.getParam('sparks'), 0, 1)
    if (sparksParam > 0) {
      const kx = 1 / Math.max(aspect, 1)
      const ky = Math.min(aspect, 1)
      for (let slot = 0; slot < SPARK_SLOTS; slot++) {
        const age = this.currentTime - this.sparkSpawnTime[slot]
        if (age < 0 || age >= SPARK_LIFETIME) continue
        const alpha = clamp((1 - age / SPARK_LIFETIME) * sparksParam, 0, 1)
        for (let p = 0; p < SPARK_POINTS; p++) {
          const vIdx = slot * SPARK_POINTS + p
          const lx = this.sparkOriginX[slot] + this.sparkVelX[vIdx] * age
          const ly = this.sparkOriginY[slot] + this.sparkVelY[vIdx] * age
          this.sparkVerts[p * 2 + 0] = lx * kx
          this.sparkVerts[p * 2 + 1] = ly * ky
        }
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.sparkVerts)
        const [sr, sg, sb] = hsl(this.sparkHue[slot], 0.9, 0.75)
        gl.uniform3f(uColorLoc, sr, sg, sb)
        gl.uniform1f(uAlphaLoc, alpha)
        gl.drawArrays(gl.POINTS, 0, SPARK_POINTS)
      }
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
    gl.deleteProgram(this.fadeProgram)
    gl.deleteVertexArray(this.lineVao)
    gl.deleteBuffer(this.lineVbo)
    gl.deleteVertexArray(this.fadeVao)
  }

  getShaderSources(): ShaderStage[] {
    return [
      { key: 'line-fs', label: 'Line color (line-fs)', source: this.lineSource },
      { key: 'fade-fs', label: 'Trail fade (fade-fs)', source: this.fadeSource },
    ]
  }

  setShaderSource(key: string, source: string): void {
    const gl = this.gpu.gl
    switch (key) {
      case 'line-fs': {
        const program = this.gpu.compileProgram(PASSTHROUGH_VS, source)
        gl.deleteProgram(this.lineProgram)
        this.lineProgram = program
        this.lineSource = source
        return
      }
      case 'fade-fs': {
        const program = this.gpu.compileProgram(PASSTHROUGH_VS, source)
        gl.deleteProgram(this.fadeProgram)
        this.fadeProgram = program
        this.fadeSource = source
        return
      }
      default:
        throw new Error(`Unknown shader stage "${key}" for scene "${this.meta.id}"`)
    }
  }
}
