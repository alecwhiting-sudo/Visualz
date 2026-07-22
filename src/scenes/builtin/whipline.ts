import type { Gpu } from '../../gpu/context'
import type { RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'

/**
 * "Whip Line" (geometry family) — the user's spec, verbatim: a straight line
 * from screen center to the top begins to rotate with its outer end moving
 * twice as fast as its inner end, develops an echo of itself spaced by the
 * music's beats, bounces off the walls like a wave (each subsection acting
 * like a particle but staying attached to the next), keeps whipping along its
 * bouncing path followed by its beat-echoes, and pulses hue/brightness to
 * the beat.
 *
 * Architecture (lissajous.ts's pattern): a fade-feedback trail pass + one
 * draw per drawn line, a code layer exposing 'line-fs' and 'fade-fs'. Two
 * additions lissajous doesn't need:
 *
 * 1. The physics: a CPU verlet chain of N particles (waves.ts's "fixed
 *    frame-clocked substeps" discipline applied to point-mass integration
 *    instead of a GPU field) plus a position-based-dynamics relaxation pass
 *    that keeps consecutive particles a fixed distance apart — literally
 *    "each subsection operates like a particle but remains attached to the
 *    next part of the line."
 *
 * 2. Real geometric ribbon rendering (post-review rework, task #46b): GL
 *    line primitives clamp to ~1px on nearly every platform, which read as
 *    scattered hairlines, not "one continuous elegant ribbon." Every drawn
 *    line (head + echoes) is instead a screen-space-width TRIANGLE_STRIP:
 *    per chain point, a tangent/normal computed in already-aspect-corrected
 *    NDC space (glyphgeometry.ts's "aspect correction on the CPU before
 *    building the vertex buffer" convention, so a normal offset is never
 *    skewed by a non-square viewport), offset by ±halfWidth. `thickness` is
 *    real geometric half-width now, not a brightness scale.
 *
 * Coordinate scheme: physics runs in the SAME undistorted "logical" space
 * lissajous's curve lives in, and buildRibbon() applies that curve's exact
 * aspect-fit (p.x /= max(aspect,1), p.y *= min(aspect,1)) on the CPU before
 * computing tangents, so the ribbon never renders in the anisotropic
 * pre-fit space. Inverting that fit gives the logical-space half-extents of
 * the ACTUAL screen edges for any aspect — Wx = max(aspect,1), Wy =
 * max(1/aspect,1) — so wall bounces (done in logical space every update())
 * land exactly on the real edges at 16:9, 9:16, and 1:1. NDC's top edge is
 * always y=+1, i.e. logical y=+Wy, which is why seeding the line from
 * (0,0) to (0,Wy) reaches "the top of screen" at any aspect.
 *
 * Differential rotation: every substep, each particle gets a tangential
 * velocity kick computed as an angular rate around the CURRENT inner-end
 * position (pos[0], captured once at the top of the substep) — omega_i =
 * rotSpeed * (1 + (dispersion-1) * i/(N-1)) (computeOmega()), generalizing
 * the user's original "outer end moving twice as fast as the inner" (that's
 * exactly `dispersion=2`, the default) to a tunable "difference in size of
 * the circle on the inner edge versus the outer edge" — 1 = rigid rotation,
 * 4 = violent 4x shear. Critically, the kick's MAGNITUDE uses the chain's
 * IDEAL rest-length radius (i*restLen), not the particle's instantaneous
 * (possibly stretched) distance from the pivot: using the live distance is a
 * positive-feedback loop (any transient stretch amplifies the kick, which
 * whips it further, which stretches it more — the "spaghetti" the first pass
 * shipped) whereas the ideal-radius version is a bounded torque that can
 * never runaway, only the *direction* of the kick still follows the chain's
 * current shape. The inner end is never pinned: it free-floats like every
 * other particle (the kick's own radius there is ~0, so the swirl is
 * entirely driven by the rest of the chain dragging it via the length
 * constraints). An initial full-strength kick is seeded once in init() ("it
 * begins to rotate"); every subsequent substep re-applies the SAME kick
 * scaled by `drive` ("keep feeding the differential torque so it keeps
 * whipping" — drive=0 coasts on pure momentum/bounces/constraints after the
 * initial swirl, drive=1 keeps driving it hard).
 *
 * `length` (task #46c, follow-up feature): scales the chain's rest length
 * per segment (`restLen = baseRestLen * length`, recomputed every update()
 * so it stays live-tweakable — a macro-slot param). `baseRestLen` (fixed at
 * init from the center-to-top-edge distance) is what `length=1.0` means;
 * the default of 1.2 is deliberate — a rope rest-length longer than the
 * center-to-edge distance guarantees the tip overshoots the screen edge and
 * wall-bounces regularly once the constraint relaxation stretches the chain
 * out to it, which is the user's explicit "it never bounces at defaults"
 * fix. Initial seed positions are unaffected by `length` (still exactly
 * reach the real top edge at t=0, per the class doc above) — the chain
 * organically stretches out to the larger rest length over its first few
 * updates, rather than snapping to it in one frame.
 *
 * `beatDiv` (task #46c): decouples the echo-capture cadence from the raw
 * per-beat pulse. A continuous beat clock (`beatCount` — incremented once
 * per `beat===1` pulse — plus the fractional `beatPhase` signal) is compared
 * against a musical division (`BEATS_PER_ECHO[beatDiv]`: whole/half/quarter/
 * eighth/sixteenth notes); an echo captures whenever the clock crosses into
 * a new division index. Pure function of the signal stream (`beat`,
 * `beatPhase`), so replay-deterministic by construction; the first frame is
 * guarded (no spurious capture before any real beat has elapsed) and at
 * most one capture fires per frame even if a mid-take `beatDiv` change makes
 * the division index jump by more than one (see update()).
 */

const N = 48 // particles in the chain — cheap enough to run every substep on the CPU
const SUBSTEPS = 4 // frame-clocked (not dt-scaled) verlet substeps per update()
const DT_SUB = 1 / 240 // fixed virtual substep — grayscott/waves-style determinism
const RELAX_ITERS = 6 // constraint-relaxation iterations per substep
const DAMPING = 0.985 // per-substep velocity retention — tuned (post-review) so the
// bounded-radius drive settles into one coherent serpentine arc at defaults
// instead of accumulating into a self-crossing tangle, verified at f200/f400.
const KICK_SCALE = 0.045 // extra internal attenuation on the continuous drive kick
// (on top of the `drive` param) — re-tuned slightly up from the previous
// rework's 0.03 alongside `length`'s new default (task #46c) so the longer
// rest length actually reaches and bounces off a wall within a graceful
// timeframe (verified non-blank wall contact at f200/f400/f700 at defaults),
// while still reading as one coherent ribbon, not a tangle.
const RING_CAPACITY = 16 // preallocated echo ring-buffer slots (matches echoes' max)

const HUE_DRIFT_RATE = 0.03 // continuous hue creep, 1/s
const HUE_BEAT_STEP = 0.055 // extra hue jump fired once per beat pulse
const PULSE_DECAY_RATE = 5 // 1/s exponential decay of the beat-brightness envelope

// beatDiv -> beats-per-echo (whole, half, quarter [default: current per-beat
// behavior], eighth, sixteenth notes). Smaller = more frequent captures.
const BEATS_PER_ECHO = [4, 2, 1, 0.5, 0.25]

// Ribbon geometry (task #46b): `thickness` is real screen-space half-width in
// NDC now. HALF_WIDTH_PER_THICKNESS chosen so thickness's default (1.2)
// renders a ~4px half-width (~8px full width) ribbon at 1080p:
// 0.004 NDC * (1080/2) px-per-NDC-unit ~= 2.16px half-width per axis.
const HALF_WIDTH_PER_THICKNESS = 0.004 / 1.2
const TAPER_MIN = 0.55 // ribbon width at each tail end, as a fraction of the mid-chain width

// Both passes are plain full-NDC-space draws — the ribbon builder does the
// only aspect-correction this scene needs, entirely on the CPU (see class
// doc), so neither vertex shader has any uniform left to apply.
const PASSTHROUGH_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`

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

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** Differential-rotation angular rate for particle `i` (0-indexed, N total):
 * `rotSpeed` at the inner end, `rotSpeed*dispersion` at the outer end,
 * linear between — dispersion=2 is the user's original "outer end moving
 * twice as fast as the inner" spec; dispersion=1 is rigid rotation. */
function computeOmega(rotSpeed: number, dispersion: number, i: number): number {
  return rotSpeed * (1 + (dispersion - 1) * (i / (N - 1)))
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h * 12) % 12
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return [f(0), f(8), f(4)]
}

export class WhipLineScene implements SceneRuntime {
  meta = { id: 'whipline', name: 'Whip Line', family: 'geometry' as const }

  // Order is a contract (task #46c): the first 8 are the hardware macro
  // slots. `tension` dropped out of the macro-8 (still a UI knob, just past
  // slot 8) to make room for the 3 new params.
  params: ParamSchema[] = [
    { name: 'rotSpeed', label: 'Rotation speed', min: 0, max: 3, default: 1 },
    { name: 'length', label: 'Length', min: 0.3, max: 1.6, default: 1.2 },
    { name: 'dispersion', label: 'Dispersion', min: 1, max: 4, default: 2 },
    { name: 'beatDiv', label: 'Echo spacing', min: 0, max: 4, step: 1, default: 2 },
    { name: 'echoes', label: 'Echoes', min: 0, max: 16, step: 1, default: 5 },
    { name: 'drive', label: 'Drive', min: 0, max: 1, default: 0.5 },
    { name: 'bounce', label: 'Wall bounce', min: 0.3, max: 1, default: 0.8 },
    { name: 'pulse', label: 'Beat pulse', min: 0, max: 1, default: 0.6 },
    { name: 'tension', label: 'Tension', min: 0.5, max: 1, default: 0.85 },
    { name: 'thickness', label: 'Thickness', min: 0.5, max: 3, default: 1.2 },
    { name: 'trail', label: 'Trail', min: 0.7, max: 0.995, default: 0.82 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu

  private lineProgram!: WebGLProgram
  private fadeProgram!: WebGLProgram
  private lineVao!: WebGLVertexArrayObject
  private lineVbo!: WebGLBuffer
  private fadeVao!: WebGLVertexArrayObject

  // Code layer (ARCHITECTURE.md §3.3): current source per editable stage,
  // reset to stock every init() (mirrors lissajous.ts).
  private lineSource = LINE_FS
  private fadeSource = FADE_FS

  // --- Verlet chain state (all logical-space, see class doc) --------------
  private posX = new Float32Array(N)
  private posY = new Float32Array(N)
  private prevX = new Float32Array(N)
  private prevY = new Float32Array(N)
  private baseRestLen = 0 // fixed at init: per-segment rest length at `length`=1.0
  private restLen = 0 // this frame's effective rest length (baseRestLen * length), see update()

  // --- Ribbon-builder scratch (reused across head + every echo draw) ------
  private ndcX = new Float32Array(N)
  private ndcY = new Float32Array(N)
  private ribbonVerts = new Float32Array(N * 4) // 2 verts/point * 2 floats/vert

  // --- Beat-echo ring buffer (preallocated at RING_CAPACITY, spec §3) ------
  private ringPosX: Float32Array[] = []
  private ringPosY: Float32Array[] = []
  private ringHue = new Float32Array(RING_CAPACITY)
  private ringWrite = 0 // next slot to write
  private ringCount = 0 // how many slots have ever been written (caps at RING_CAPACITY)

  // --- Color / brightness state --------------------------------------------
  private huePhase = 0
  private pulseEnv = 0

  // --- beatDiv echo-capture clock (task #46c, see class doc) ---------------
  private beatCount = 0
  private lastEchoIndex = 0
  private echoClockInit = false

  init(gpu: Gpu, _seed: number): void {
    this.gpu = gpu
    for (const p of this.params) this.values.set(p.name, p.default)

    this.lineSource = LINE_FS
    this.fadeSource = FADE_FS

    // Straight vertical line, center -> top of screen (logical space; see
    // class doc for why (0,Wy) is "the top" at any aspect).
    const aspect = gpu.width / gpu.height
    const Wy = Math.max(1 / aspect, 1)
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1)
      this.posX[i] = 0
      this.posY[i] = t * Wy
      this.prevX[i] = 0
      this.prevY[i] = t * Wy
    }
    this.baseRestLen = Wy / (N - 1)
    this.restLen = this.baseRestLen * clamp(this.getParam('length'), 0.3, 1.6)

    // Seed the initial swirl ("it begins to rotate") — a one-off full-strength
    // tangential kick regardless of `drive`, encoded the same way update()'s
    // continuous kick is (see kickVector()/integrate()): nudge prevPos
    // backward by the kick velocity so the very first substep already
    // carries this momentum.
    const rotSpeed0 = this.getParam('rotSpeed')
    const dispersion0 = clamp(this.getParam('dispersion'), 1, 4)
    for (let i = 0; i < N; i++) {
      const omega = computeOmega(rotSpeed0, dispersion0, i)
      const { kx, ky } = this.kickVector(i, this.posX[i], this.posY[i], this.posX[0], this.posY[0], omega)
      const vx = kx * DT_SUB
      const vy = ky * DT_SUB
      this.prevX[i] = this.posX[i] - vx
      this.prevY[i] = this.posY[i] - vy
    }

    this.ringPosX = []
    this.ringPosY = []
    for (let r = 0; r < RING_CAPACITY; r++) {
      this.ringPosX.push(new Float32Array(N))
      this.ringPosY.push(new Float32Array(N))
    }
    this.ringHue.fill(0)
    this.ringWrite = 0
    this.ringCount = 0

    this.huePhase = 0
    this.pulseEnv = 0

    this.beatCount = 0
    this.lastEchoIndex = 0
    this.echoClockInit = false

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

  update(ctx: FrameContext): void {
    const { frame, signals } = ctx
    const rotSpeed = this.getParam('rotSpeed')
    const dispersion = clamp(this.getParam('dispersion'), 1, 4)
    const tension = clamp(this.getParam('tension'), 0.5, 1)
    const bounce = clamp(this.getParam('bounce'), 0.3, 1)
    const drive = clamp(this.getParam('drive'), 0, 1)

    // `length` scales the rest length live every frame (a macro-slot param —
    // see class doc for why the default of 1.15 is deliberate).
    this.restLen = this.baseRestLen * clamp(this.getParam('length'), 0.3, 1.6)

    // Aspect read fresh every update() (gpu dims track canvas/resize()), so
    // wall bounds track the real screen edges even if the surface resizes.
    const aspect = this.gpu.width / this.gpu.height
    const Wx = Math.max(aspect, 1)
    const Wy = Math.max(1 / aspect, 1)

    for (let s = 0; s < SUBSTEPS; s++) {
      this.integrate(rotSpeed, dispersion, drive, bounce, Wx, Wy)
      for (let k = 0; k < RELAX_ITERS; k++) this.relax(tension)
    }

    // Hue: continuous drift plus a per-beat jump ("its hue changes ... to the
    // beat"). Brightness: a CPU dt-decay envelope, reset to 1 on each beat,
    // scaled by `pulse` at draw time. Both are tied to the raw per-beat pulse
    // (never to `beatDiv`, which only governs echo-capture cadence below).
    this.huePhase = (this.huePhase + HUE_DRIFT_RATE * frame.dt) % 1
    const beat = signals.get('beat')
    if (beat === 1) {
      this.huePhase = (this.huePhase + HUE_BEAT_STEP) % 1
      this.pulseEnv = 1
      this.beatCount += 1
    } else {
      this.pulseEnv *= Math.exp(-PULSE_DECAY_RATE * frame.dt)
    }

    // Echo-capture cadence (`beatDiv`, task #46c — see class doc): a
    // continuous beat clock compared against a musical division. Pure
    // function of (beatCount, beatPhase); guards the first frame (no
    // spurious capture at clock 0) and fires at most one capture per frame
    // even if `beatDiv` changes mid-take jump the division index by more
    // than one — the `!==` check below only ever advances `lastEchoIndex`
    // to the new value once, never loops to "catch up".
    const beatDivIndex = clamp(Math.round(this.getParam('beatDiv')), 0, BEATS_PER_ECHO.length - 1)
    const beatsPerEcho = BEATS_PER_ECHO[beatDivIndex]
    const beatClock = this.beatCount + signals.get('beatPhase')
    const echoIndex = Math.floor(beatClock / beatsPerEcho)
    if (!this.echoClockInit) {
      this.lastEchoIndex = echoIndex
      this.echoClockInit = true
    } else if (echoIndex !== this.lastEchoIndex) {
      this.lastEchoIndex = echoIndex
      this.captureEcho()
    }
  }

  /** Tangential drive-kick velocity for particle `i`: direction follows the
   * particle's CURRENT position relative to `pivot`, but magnitude uses the
   * chain's IDEAL rest-length radius (i*restLen) rather than the live
   * (possibly stretched) distance — see class doc for why that bound is
   * what keeps the whip from feedback-amplifying into a tangle. */
  private kickVector(i: number, px: number, py: number, pivotX: number, pivotY: number, omega: number): { kx: number; ky: number } {
    const dxp = px - pivotX
    const dyp = py - pivotY
    const dist = Math.sqrt(dxp * dxp + dyp * dyp)
    if (dist < 1e-6) return { kx: 0, ky: 0 }
    const ux = dxp / dist
    const uy = dyp / dist
    const idealR = this.restLen * i
    return { kx: -uy * idealR * omega, ky: ux * idealR * omega }
  }

  /** One verlet substep: velocity-from-prevPos integration, the differential
   * tangential drive kick, then wall-bounce reflection. Constraint relaxation
   * (equal segment lengths — "remains attached to the next part") runs
   * separately, right after this, in relax(). */
  private integrate(rotSpeed: number, dispersion: number, drive: number, bounce: number, Wx: number, Wy: number): void {
    const pivotX = this.posX[0]
    const pivotY = this.posY[0]
    for (let i = 0; i < N; i++) {
      const px = this.posX[i]
      const py = this.posY[i]
      let vx = (px - this.prevX[i]) * DAMPING
      let vy = (py - this.prevY[i]) * DAMPING

      // Differential rotation drive: omega_i linear from rotSpeed (i=0) to
      // rotSpeed*dispersion (i=N-1) — dispersion=2 is the user's original
      // "outer end moving twice as fast as the inner end."
      const omega = computeOmega(rotSpeed, dispersion, i)
      const { kx, ky } = this.kickVector(i, px, py, pivotX, pivotY, omega)
      vx += kx * DT_SUB * drive * KICK_SCALE
      vy += ky * DT_SUB * drive * KICK_SCALE

      let nx = px + vx
      let ny = py + vy

      // Wall bounce off the four real screen edges (restitution = bounce);
      // the length constraints re-attach this particle to its neighbors in
      // relax() right after, which is what propagates the bounce down the
      // chain "like a wave."
      if (nx > Wx) {
        nx = Wx
        vx = -vx * bounce
      } else if (nx < -Wx) {
        nx = -Wx
        vx = -vx * bounce
      }
      if (ny > Wy) {
        ny = Wy
        vy = -vy * bounce
      } else if (ny < -Wy) {
        ny = -Wy
        vy = -vy * bounce
      }

      this.posX[i] = nx
      this.posY[i] = ny
      this.prevX[i] = nx - vx
      this.prevY[i] = ny - vy
    }
  }

  /** Position-based constraint relaxation: pulls every consecutive pair back
   * toward `restLen`, split evenly (neither end is pinned) and scaled by
   * `tension` (relaxation stiffness). */
  private relax(tension: number): void {
    const rest = this.restLen
    for (let i = 0; i < N - 1; i++) {
      const dx = this.posX[i + 1] - this.posX[i]
      const dy = this.posY[i + 1] - this.posY[i]
      const dist = Math.sqrt(dx * dx + dy * dy) || 1e-6
      const corr = (0.5 * tension * (dist - rest)) / dist
      const cx = dx * corr
      const cy = dy * corr
      this.posX[i] += cx
      this.posY[i] += cy
      this.posX[i + 1] -= cx
      this.posY[i + 1] -= cy
    }
  }

  /** Snapshot the full chain into the next ring slot — called once per beat
   * pulse (never per-frame otherwise), per spec §3. */
  private captureEcho(): void {
    const slot = this.ringWrite
    this.ringPosX[slot].set(this.posX)
    this.ringPosY[slot].set(this.posY)
    this.ringHue[slot] = this.huePhase
    this.ringWrite = (this.ringWrite + 1) % RING_CAPACITY
    this.ringCount = Math.min(RING_CAPACITY, this.ringCount + 1)
  }

  /**
   * Builds a TRIANGLE_STRIP ribbon (2*N vertices, into `this.ribbonVerts`)
   * for chain `(x, y)` in logical space: converts each point to NDC using
   * the scene's aspect-fit (glyphgeometry.ts's "aspect correction on the CPU
   * before building the vertex buffer" convention — a normal computed in
   * NDC is never skewed by a non-square viewport), takes a central-difference
   * tangent per point, and offsets ±halfWidth along its normal. Width tapers
   * down slightly at both tail ends (TAPER_MIN..1) for a whip-like profile.
   * Shared verbatim by the head line and every echo (task #46b).
   */
  private buildRibbon(x: Float32Array, y: Float32Array, halfWidth: number, aspect: number): void {
    const kx = 1 / Math.max(aspect, 1)
    const ky = Math.min(aspect, 1)
    for (let i = 0; i < N; i++) {
      this.ndcX[i] = x[i] * kx
      this.ndcY[i] = y[i] * ky
    }

    let lastTx = 0
    let lastTy = 1 // fallback tangent (matches the initial straight-up line)
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

    // Fade pass: translucent black quad, leaves a soft motion-blur trail
    // underneath the crisp, discrete beat-echo ribbons drawn below.
    gl.useProgram(this.fadeProgram)
    gl.uniform1f(gl.getUniformLocation(this.fadeProgram, 'uFade'), 1 - clamp(this.getParam('trail'), 0.7, 0.995))
    gl.bindVertexArray(this.fadeVao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    gl.useProgram(this.lineProgram)
    gl.bindVertexArray(this.lineVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo)

    const thickness = clamp(this.getParam('thickness'), 0.5, 3)
    const halfWidth = thickness * HALF_WIDTH_PER_THICKNESS
    const echoesParam = clamp(Math.round(this.getParam('echoes')), 0, RING_CAPACITY)
    const available = Math.min(echoesParam, this.ringCount)

    // Echoes: oldest first (dimmest, drawn behind) up to newest (drawn just
    // before the head) — "an echo of itself ... spaced out by the music
    // beats." Each beat-ghost must read as an individually countable, discrete
    // copy of the ribbon (task #46b review), so alpha steps linearly across a
    // wide, clearly-separated band (0.55 newest .. 0.15 oldest) rather than
    // fading toward invisibility. Tinted by whatever hue was live at the
    // moment each one was captured ("progressively back along the hue trail").
    for (let rank = available; rank >= 1; rank--) {
      const slot = (this.ringWrite - rank + RING_CAPACITY * 2) % RING_CAPACITY
      const age = echoesParam > 1 ? (rank - 1) / (echoesParam - 1) : 0 // 0 (newest) .. 1 (oldest)
      const alpha = 0.55 - 0.4 * age
      const lightness = 0.5 - 0.12 * age
      const [r, g, b] = hsl(this.ringHue[slot], 0.85, lightness)
      this.buildRibbon(this.ringPosX[slot], this.ringPosY[slot], halfWidth, aspect)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.ribbonVerts)
      gl.uniform3f(gl.getUniformLocation(this.lineProgram, 'uColor'), r, g, b)
      gl.uniform1f(gl.getUniformLocation(this.lineProgram, 'uAlpha'), clamp(alpha, 0, 1))
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, N * 2)
    }

    // Head: the live chain, brightest and fully opaque, hue-pulsing on the beat.
    const pulseBoost = this.getParam('pulse') * this.pulseEnv * 0.35
    const headLightness = clamp(0.55 + pulseBoost, 0, 0.95)
    const [hr, hg, hb] = hsl(this.huePhase, 0.85, headLightness)
    this.buildRibbon(this.posX, this.posY, halfWidth, aspect)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.ribbonVerts)
    gl.uniform3f(gl.getUniformLocation(this.lineProgram, 'uColor'), hr, hg, hb)
    gl.uniform1f(gl.getUniformLocation(this.lineProgram, 'uAlpha'), 1)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, N * 2)

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
        const program = this.gpu.compileProgram(PASSTHROUGH_VS, source) // throws on GLSL error; old program untouched
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
