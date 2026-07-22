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
 * dynamic-VBO line-strip draw per drawn line, a code layer exposing 'line-fs'
 * and 'fade-fs'. The one addition lissajous doesn't need is the physics: a
 * CPU verlet chain of N particles (waves.ts's "fixed frame-clocked substeps"
 * discipline applied to point-mass integration instead of a GPU field) plus a
 * position-based-dynamics relaxation pass that keeps consecutive particles a
 * fixed distance apart — literally "each subsection operates like a particle
 * but remains attached to the next part of the line."
 *
 * Coordinate scheme: physics runs in the SAME undistorted "logical" square
 * space lissajous's curve lives in (aAspect fits it to the real NDC viewport
 * in LINE_VS: p.x /= max(aspect,1), p.y *= min(aspect,1)). Inverting that
 * fit gives the logical-space half-extents of the ACTUAL screen edges for any
 * aspect — Wx = max(aspect,1), Wy = max(1/aspect,1) — so wall bounces (done
 * in logical space, on the CPU, every update()) land exactly on the real
 * edges at 16:9, 9:16, and 1:1 once LINE_VS maps logical -> NDC for drawing.
 * NDC's top edge is always y=+1, i.e. logical y=+Wy, which is why seeding the
 * line from (0,0) to (0,Wy) reaches "the top of screen" at any aspect.
 *
 * Differential rotation: every substep, each particle gets a tangential
 * velocity kick computed as an angular rate around the CURRENT inner-end
 * position (pos[0], captured once at the top of the substep) — omega_i =
 * rotSpeed * (1 + i/(N-1)), i.e. exactly rotSpeed at the inner end and
 * exactly 2*rotSpeed at the outer end, linear between. The inner end is
 * never pinned: it free-floats like every other particle (the kick's own
 * radius there is ~0, so the swirl is entirely driven by the rest of the
 * chain dragging it via the length constraints). An initial full-strength
 * kick is seeded once in init() ("it begins to rotate"); every subsequent
 * substep re-applies the SAME kick scaled by `drive` ("keep feeding the
 * differential torque so it keeps whipping" — drive=0 coasts on pure
 * momentum/bounces/constraints after the initial swirl, drive=1 keeps
 * driving it hard).
 */

const N = 48 // particles in the chain — cheap enough to run every substep on the CPU
const SUBSTEPS = 4 // frame-clocked (not dt-scaled) verlet substeps per update()
const DT_SUB = 1 / 240 // fixed virtual substep — grayscott/waves-style determinism
const RELAX_ITERS = 6 // constraint-relaxation iterations per substep
const DAMPING = 0.995 // mild global per-substep velocity damping (keeps energy bounded)
const RING_CAPACITY = 16 // preallocated echo ring-buffer slots (matches echoes' max)

const HUE_DRIFT_RATE = 0.03 // continuous hue creep, 1/s
const HUE_BEAT_STEP = 0.055 // extra hue jump fired once per beat pulse
const PULSE_DECAY_RATE = 5 // 1/s exponential decay of the beat-brightness envelope

const LINE_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
uniform float uAspect;
void main() {
  // Same aspect-fit lissajous.ts uses: shrink x on wide screens, shrink y on
  // tall ones, so a shape built in undistorted logical space (where the
  // physics runs) lands on the real NDC edges at any aspect.
  vec2 p = aPos;
  p.x /= max(uAspect, 1.0);
  p.y *= min(uAspect, 1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`

const LINE_FS = `#version 300 es
precision highp float;
uniform vec3 uColor;
uniform float uAlpha;
out vec4 outColor;
void main() {
  outColor = vec4(uColor, uAlpha);
}`

const FADE_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`

const FADE_FS = `#version 300 es
precision highp float;
uniform float uFade;
out vec4 outColor;
void main() { outColor = vec4(0.0, 0.0, 0.0, uFade); }`

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
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

  params: ParamSchema[] = [
    { name: 'rotSpeed', label: 'Rotation speed', min: 0, max: 3, default: 1 },
    { name: 'echoes', label: 'Echoes', min: 0, max: 16, step: 1, default: 8 },
    { name: 'tension', label: 'Tension', min: 0.5, max: 1, default: 0.85 },
    { name: 'bounce', label: 'Wall bounce', min: 0.3, max: 1, default: 0.8 },
    { name: 'drive', label: 'Drive', min: 0, max: 1, default: 0.5 },
    { name: 'thickness', label: 'Thickness', min: 0.5, max: 3, default: 1.2 },
    { name: 'trail', label: 'Trail', min: 0.7, max: 0.995, default: 0.9 },
    { name: 'pulse', label: 'Beat pulse', min: 0, max: 1, default: 0.6 },
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
  private restLen = 0
  private scratch = new Float32Array(N * 2) // reused per-draw upload buffer

  // --- Beat-echo ring buffer (preallocated at RING_CAPACITY, spec §3) ------
  private ringPosX: Float32Array[] = []
  private ringPosY: Float32Array[] = []
  private ringHue = new Float32Array(RING_CAPACITY)
  private ringWrite = 0 // next slot to write
  private ringCount = 0 // how many slots have ever been written (caps at RING_CAPACITY)

  // --- Color / brightness state --------------------------------------------
  private huePhase = 0
  private pulseEnv = 0

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
    this.restLen = Wy / (N - 1)

    // Seed the initial swirl ("it begins to rotate") — a one-off full-strength
    // tangential kick regardless of `drive`, encoded the same way update()'s
    // continuous kick is (see integrate()): nudge prevPos backward by the
    // kick velocity so the very first substep already carries this momentum.
    const rotSpeed0 = this.getParam('rotSpeed')
    for (let i = 0; i < N; i++) {
      const dxp = this.posX[i] - this.posX[0]
      const dyp = this.posY[i] - this.posY[0]
      const omega = rotSpeed0 * (1 + i / (N - 1))
      const vx = -dyp * omega * DT_SUB
      const vy = dxp * omega * DT_SUB
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

    const gl = gpu.gl
    this.lineProgram = gpu.compileProgram(LINE_VS, this.lineSource)
    this.fadeProgram = gpu.compileProgram(FADE_VS, this.fadeSource)

    this.lineVao = gl.createVertexArray()!
    this.lineVbo = gl.createBuffer()!
    gl.bindVertexArray(this.lineVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo)
    gl.bufferData(gl.ARRAY_BUFFER, this.scratch.byteLength, gl.DYNAMIC_DRAW)
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
    const tension = clamp(this.getParam('tension'), 0.5, 1)
    const bounce = clamp(this.getParam('bounce'), 0.3, 1)
    const drive = clamp(this.getParam('drive'), 0, 1)

    // Aspect read fresh every update() (gpu dims track canvas/resize()), so
    // wall bounds track the real screen edges even if the surface resizes.
    const aspect = this.gpu.width / this.gpu.height
    const Wx = Math.max(aspect, 1)
    const Wy = Math.max(1 / aspect, 1)

    for (let s = 0; s < SUBSTEPS; s++) {
      this.integrate(rotSpeed, drive, bounce, Wx, Wy)
      for (let k = 0; k < RELAX_ITERS; k++) this.relax(tension)
    }

    // Hue: continuous drift plus a per-beat jump ("its hue changes ... to the
    // beat"). Brightness: a CPU dt-decay envelope, reset to 1 on each beat,
    // scaled by `pulse` at draw time.
    this.huePhase = (this.huePhase + HUE_DRIFT_RATE * frame.dt) % 1
    const beat = signals.get('beat')
    if (beat === 1) {
      this.huePhase = (this.huePhase + HUE_BEAT_STEP) % 1
      this.pulseEnv = 1
      this.captureEcho()
    } else {
      this.pulseEnv *= Math.exp(-PULSE_DECAY_RATE * frame.dt)
    }
  }

  /** One verlet substep: velocity-from-prevPos integration, the differential
   * tangential drive kick, then wall-bounce reflection. Constraint relaxation
   * (equal segment lengths — "remains attached to the next part") runs
   * separately, right after this, in relax(). */
  private integrate(rotSpeed: number, drive: number, bounce: number, Wx: number, Wy: number): void {
    const pivotX = this.posX[0]
    const pivotY = this.posY[0]
    for (let i = 0; i < N; i++) {
      const px = this.posX[i]
      const py = this.posY[i]
      let vx = (px - this.prevX[i]) * DAMPING
      let vy = (py - this.prevY[i]) * DAMPING

      // Differential rotation drive: tangential kick around the (free-
      // floating) inner end, omega_i linear from rotSpeed (i=0) to
      // 2*rotSpeed (i=N-1) — the user's exact "outer end moving twice as
      // fast as the inner end."
      const dxp = px - pivotX
      const dyp = py - pivotY
      const omega = rotSpeed * (1 + i / (N - 1))
      vx += -dyp * omega * DT_SUB * drive
      vy += dxp * omega * DT_SUB * drive

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

  render(ctx: FrameContext, surface: RenderSurface): void {
    void ctx
    const gl = this.gpu.gl
    surface.bind()
    const aspect = surface.width / surface.height

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    // Fade pass: translucent black quad, leaves a soft motion-blur trail on
    // top of the crisp beat-echo lines drawn below.
    gl.useProgram(this.fadeProgram)
    gl.uniform1f(gl.getUniformLocation(this.fadeProgram, 'uFade'), 1 - clamp(this.getParam('trail'), 0.7, 0.995))
    gl.bindVertexArray(this.fadeVao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    gl.useProgram(this.lineProgram)
    gl.uniform1f(gl.getUniformLocation(this.lineProgram, 'uAspect'), aspect)
    gl.bindVertexArray(this.lineVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo)

    const thickness = clamp(this.getParam('thickness'), 0.5, 3)
    const echoesParam = clamp(Math.round(this.getParam('echoes')), 0, RING_CAPACITY)
    const available = Math.min(echoesParam, this.ringCount)

    // Echoes: oldest first (dimmest, drawn behind) up to newest (brightest of
    // the echoes, drawn just before the head) — "an echo of itself ... spaced
    // out by the music beats," linearly decreasing alpha, tinted by whatever
    // hue was live at the moment each one was captured ("progressively back
    // along the hue trail").
    for (let rank = available; rank >= 1; rank--) {
      const slot = (this.ringWrite - rank + RING_CAPACITY * 2) % RING_CAPACITY
      const age = rank / Math.max(1, echoesParam) // 0 (newest) .. ~1 (oldest)
      const alpha = 0.5 * (1 - age) * thickness
      if (alpha <= 0) continue
      const lightness = 0.55 * (1 - 0.5 * age)
      const [r, g, b] = hsl(this.ringHue[slot], 0.85, lightness)
      this.uploadLine(this.ringPosX[slot], this.ringPosY[slot])
      gl.uniform3f(gl.getUniformLocation(this.lineProgram, 'uColor'), r, g, b)
      gl.uniform1f(gl.getUniformLocation(this.lineProgram, 'uAlpha'), clamp(alpha, 0, 1))
      gl.drawArrays(gl.LINE_STRIP, 0, N)
    }

    // Head: the live chain, brightest, hue-pulsing on the beat.
    const pulseBoost = this.getParam('pulse') * this.pulseEnv * 0.35
    const headLightness = clamp(0.55 + pulseBoost, 0, 0.95)
    const [hr, hg, hb] = hsl(this.huePhase, 0.85, headLightness)
    this.uploadLine(this.posX, this.posY)
    gl.uniform3f(gl.getUniformLocation(this.lineProgram, 'uColor'), hr * thickness, hg * thickness, hb * thickness)
    gl.uniform1f(gl.getUniformLocation(this.lineProgram, 'uAlpha'), 1)
    gl.drawArrays(gl.LINE_STRIP, 0, N)

    gl.bindVertexArray(null)
  }

  private uploadLine(x: Float32Array, y: Float32Array): void {
    const gl = this.gpu.gl
    for (let i = 0; i < N; i++) {
      this.scratch[i * 2] = x[i]
      this.scratch[i * 2 + 1] = y[i]
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.scratch)
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
        const program = this.gpu.compileProgram(LINE_VS, source) // throws on GLSL error; old program untouched
        gl.deleteProgram(this.lineProgram)
        this.lineProgram = program
        this.lineSource = source
        return
      }
      case 'fade-fs': {
        const program = this.gpu.compileProgram(FADE_VS, source)
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
