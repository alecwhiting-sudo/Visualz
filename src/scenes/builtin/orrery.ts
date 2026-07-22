import { mulberry32, type Prng } from '../../core/prng'
import type { Gpu } from '../../gpu/context'
import type { RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'

/**
 * Geometry family wildcard: "Orrery" — a DRAWING MACHINE made visible. A chain
 * of rotating geared arms (harmonograph/spirograph lineage, orrery in name and
 * feel) whose final joint holds a pen. Two things are drawn every frame, on
 * purpose overlapping in the same buffer:
 *
 *   1. The ARTWORK: the pen's trace, accumulated via a slow fade-feedback
 *      trail (lissajous.ts's mechanism) — the drawing genuinely persists and
 *      builds up over the whole session, like ink on paper.
 *   2. The MACHINE: the arms (rods) and joints that are CURRENTLY producing
 *      that trace, redrawn crisp and bright on top every single frame (never
 *      accumulated) — so the audience watches the geometry being
 *      manufactured, not just the finished ornament. `machineGlow` fades the
 *      mechanism out (0 = invisible) without touching the trace underneath.
 *
 * MATHS. Joint chain: `p_0` is the machine's center (fixed at the origin of
 * an aspect-corrected "square" space — see `toNDCFromSquare` below, the same
 * "fits the shorter axis" mapping lissajous.ts's vertex shader does, just
 * applied on the CPU here since arms/joints need physical-pixel-uniform
 * thickness like guilloche.ts's ribbons). For k = 1..arms:
 *
 *   theta_k = phase_k + omega_k * machineTime
 *   p_k = p_{k-1} + L_k * (cos(theta_k), sin(theta_k))
 *
 * `omega_k` is a small-integer gear ratio (num/den, both drawn 1..6 from the
 * seeded PRNG at init) reshaped by `gearing`: `omega_k = 1 + (ratio_k - 1) *
 * gearing` — gearing=1 uses the drawn ratio as-is; smaller gearing pulls every
 * arm's speed toward 1 (near-synchronized, meditative); larger gearing
 * amplifies the spread between arms (a wilder gear train). `L_k` is a fixed
 * geometric taper (`LENGTH_DECAY^k`) times a per-arm PRNG "wobble" (drawn once
 * at init, never touched again) so arms aren't perfectly self-similar,
 * normalized against the *active* arm count so `p_M` (the pen) stays within
 * budget regardless of how many arms are enabled.
 *
 * BEAT-LOCK — THE ESCAPEMENT (this scene's musical identity, guilloche.ts's
 * beat-only-advance trick reused for a different purpose): `machineTime`
 * never reads the wall clock or free-runs off `frame.time` — it is built
 * entirely from the `beat`/`beatPhase` signals:
 *
 *   linear  = beatCount + beatPhase                  // constant angular rate
 *   stepped = beatCount + easeOutCubic(beatPhase)     // accelerate-then-settle
 *   machineTime = lerp(linear, stepped, escapement)
 *
 * `beatCount` is a plain integer, incremented ONLY on the `beat` signal's
 * one-frame pulse (in update() — state advance), never in render(). Both
 * `linear` and `stepped` land on exactly `beatCount+1` the instant beatPhase
 * hits 1 and beatCount increments, so there is no discontinuity at the beat
 * boundary at ANY escapement value — only the motion WITHIN each beat
 * changes shape. `escapement=0` is smooth constant-rate rotation (no sense of
 * the beat in the motion itself); `escapement=1` is a true mechanical
 * escapement — the machine visibly winds up and lands a tick exactly on each
 * beat. Default 0.7 leans mechanical.
 *
 * PHRASE EVENTS (resonance.ts's deterministic count-based PRNG-advance
 * discipline): every `phrase` beats (counted in update(), reset on trigger),
 * ONE arm slot's gear ratio is redrawn from the PRNG (cursor cycles through
 * arm slots in order — never re-rolls all of them, never rerolls length/phase)
 * and a short dt-decayed fade-boost fires so the trail visibly clears faster
 * for a few frames — "the machine changes gears and begins a new figure." The
 * PRNG is advanced ONLY at init (MAX_ARMS ratio+phase+wobble draws) and once
 * per phrase event (one fresh ratio draw) — never per-frame, per-beat, or
 * per-onset — so replay is exactly reproducible from the `beat` signal's
 * frame-indexed pulse sequence alone, same guarantee guilloche.ts documents.
 *
 * Onset drives a separate CPU dt-decay brightness accent on the pen/trace
 * only (not the arms) — "the nib presses harder." Bass drives a smoothed
 * follower (fractallab.ts's/guilloche.ts's `1 - exp(-RATE*dt)` idiom) that
 * gently breathes the overall arm-length budget — never raw per-frame bass.
 *
 * `hue` is deliberately NOT a param: the trace's color is `machineTime *
 * HUE_RATE` (mod 1) at the instant each new ink segment is drawn — since only
 * the LATEST segment is drawn each frame (the rest of the trace persists
 * untouched in the framebuffer, per the "artwork" mechanism above), the
 * accumulated drawing naturally self-rainbows along its own length as
 * machine-time advances, with no per-pixel or per-vertex hue sweep needed.
 *
 * All geometry (rods, joints, the one-frame ink segment) is built from the
 * SAME small preallocated vertex buffer as axis-aligned/oriented pixel-uniform
 * quads (guilloche.ts's tangent/normal-in-pixel-space technique, degenerately
 * simple here since every piece is a straight 2-point segment, not a sampled
 * curve) and drawn with the SAME two-stage program pair (`line-fs` ribbons/
 * quads + `fade-fs` trail) as lissajous.ts/guilloche.ts.
 */

const TAU = Math.PI * 2
const MAX_ARMS = 6
const RATIO_INT_MAX = 6
// Geometric taper between successive arm lengths (index 0 = innermost arm).
const LENGTH_DECAY = 0.62
// Per-arm length wobble range around 1, drawn once at init: [1-WOBBLE, 1+WOBBLE].
const LENGTH_WOBBLE = 0.18
// Reach budget in aspect-corrected "square" space (half-extent ~1 = shorter
// axis edge) — kept under 1 so the pen's nominal max reach never rides the
// true edge, even before `scale`/breathing expand it further.
const REACH = 0.82
// `escapement`'s machine-time increment per beat (both the linear and eased
// branches share this so they always agree exactly at integer beat counts).
const STRIDE = 1.0
// How fast the trace's self-rainbow hue advances per unit of machineTime
// (machineTime advances roughly one unit per beat) — "slowly" per the spec.
const HUE_RATE = 0.045
const BASS_SMOOTH_RATE = 3.0 // guilloche.ts's bass-follower smoothing rate, reused verbatim.
const BREATHE_SCALE = 0.15 // "gentle" arm-length breathing — smaller than guilloche's ornament breathe.
const ACCENT_DECAY_SEC = 0.35 // guilloche.ts's onset-accent decay window, reused verbatim.
const PHRASE_BOOST_DECAY_SEC = 0.5
const PHRASE_BOOST_ADD = 0.4 // extra fade alpha at the instant a phrase event fires, decaying to 0.

// Pixel half-sizes (physical, aspect-independent — guilloche.ts's discipline
// that a thickness knob needs real geometry since `lineWidth` clamps to 1px
// on most WebGL2 drivers including SwiftShader).
const ARM_HALF_WIDTH_PX = 1.3 // ~2.6px rods, per spec's "ribbons ~2-3px".
const JOINT_HALF_PX = 3.0
const PEN_JOINT_HALF_PX = 5.0 // pen tip joint: biggest, brightest.
const INK_HALF_WIDTH_PX = 1.2

const LINE_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() {
  // Positions already arrive in final clip space — the aspect-correcting
  // "square" mapping (see toNDCFromSquare) and all pixel-uniform quad/ribbon
  // extrusion happen on the CPU in render(), same discipline as guilloche.ts.
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const LINE_FS = `#version 300 es
precision highp float;
uniform vec3 uColor;
uniform float uAlpha;
out vec4 outColor;
void main() {
  // Alpha carries the additive-blend contribution (render()'s
  // gl.blendFunc(SRC_ALPHA, ONE)) so overlapping ink strokes and the
  // machine's own joints/rods brighten instead of just occluding.
  outColor = vec4(uColor * uAlpha, uAlpha);
}`

const FADE_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`

const FADE_FS = `#version 300 es
precision highp float;
uniform float uFade;
out vec4 outColor;
void main() { outColor = vec4(0.0, 0.0, 0.0, uFade); }`

/** One arm slot's fixed identity: gear ratio (redrawable per phrase event),
 *  a constant phase offset, and a constant length wobble — drawn once at
 *  init and never touched again except `ratio` on a phrase event. */
interface ArmSlot {
  ratio: number
  phase: number
  wobble: number
}

function drawRatio(rng: Prng): number {
  const num = 1 + Math.floor(rng() * RATIO_INT_MAX)
  const den = 1 + Math.floor(rng() * RATIO_INT_MAX)
  return num / den
}

function drawArmSlot(rng: Prng): ArmSlot {
  return {
    ratio: drawRatio(rng),
    phase: rng() * TAU,
    wobble: 1 - LENGTH_WOBBLE + rng() * (2 * LENGTH_WOBBLE),
  }
}

/** Aspect-corrected "square" -> clip-space NDC map (lissajous.ts's vertex-
 *  shader mapping, done on the CPU): fits an isotropic machine centered in
 *  the shorter axis at any aspect (16:9, 9:16, 1:1 alike). */
function toNDCFromSquare(x: number, y: number, aspect: number): [number, number] {
  const ax = Math.max(aspect, 1)
  const ay = Math.min(aspect, 1)
  return [x / ax, y * ay]
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h * 12) % 12
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return [f(0), f(8), f(4)]
}

function clampInt(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(v)))
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function easeOutCubic(t: number): number {
  const inv = 1 - t
  return 1 - inv * inv * inv
}

// One quad = 4 vertices (TRIANGLE_STRIP). Max simultaneous pieces: MAX_ARMS
// rods + (MAX_ARMS + 1) joints (center + one per arm) + 1 ink segment.
const FLOATS_PER_VERTEX = 2
const VERTS_PER_QUAD = 4
const MAX_QUADS = MAX_ARMS + (MAX_ARMS + 1) + 1
const MAX_VERTS = MAX_QUADS * VERTS_PER_QUAD

interface FadeLocs {
  uFade: WebGLUniformLocation | null
}
interface LineLocs {
  uColor: WebGLUniformLocation | null
  uAlpha: WebGLUniformLocation | null
}

interface QuadRange {
  start: number
  r: number
  g: number
  b: number
  alpha: number
}

export class OrreryScene implements SceneRuntime {
  meta = { id: 'orrery', name: 'Orrery', family: 'geometry' as const }

  // Schema order matters (fractallab.ts's/guilloche.ts's own note applies
  // here too): this is the exact 8-param order the task specified.
  params: ParamSchema[] = [
    { name: 'arms', label: 'Arms', min: 2, max: 6, default: 3, step: 1 },
    { name: 'gearing', label: 'Gearing', min: 0.3, max: 3, default: 1 },
    { name: 'scale', label: 'Scale', min: 0.4, max: 1.3, default: 0.9 },
    { name: 'escapement', label: 'Escapement', min: 0, max: 1, default: 0.7 },
    { name: 'phrase', label: 'Phrase (beats)', min: 1, max: 16, default: 8, step: 1 },
    { name: 'inkFlow', label: 'Ink flow', min: 0.2, max: 2, default: 1 },
    { name: 'machineGlow', label: 'Machine glow', min: 0, max: 1.5, default: 0.8 },
    { name: 'trail', label: 'Trail', min: 0.9, max: 0.999, default: 0.985 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu
  private random: Prng = mulberry32(1)

  // CPU-only state (ARCHITECTURE.md §1). `slots` is a fixed-size MAX_ARMS
  // pool generated at init; only `ratio` on one slot is ever redrawn again
  // (on a phrase event — see class doc). `beatCount` and `phraseCounter` are
  // the discrete beat-locked counters; `armCursor` cycles which slot a
  // phrase event redraws next. `accent`/`bassEnv` are dt-driven envelopes;
  // `phraseBoost` is the dt-decayed post-phrase-event fade kick.
  private slots: ArmSlot[] = []
  private beatCount = 0
  private phraseCounter = 0
  private armCursor = 0
  private accent = 0
  private bassEnv = 0
  private phraseBoost = 0
  // The beat-locked escapement blend's result (class doc), stored so render()
  // can derive the trace's self-rainbow hue from the SAME machineTime that
  // drove this tick's joint chain, without recomputing/duplicating the blend.
  private machineTime = 0

  // Joint positions in aspect-corrected "square" space (index 0 = center),
  // and their mapped NDC positions — both fixed-size (MAX_ARMS+1), recomputed
  // wholesale in update() (state advance) and only READ in render() (draws
  // only, frozen-tick safe: repeated render() calls with no intervening
  // update() reproduce byte-identical output). `penPrevNdc` is the pen tip's
  // NDC position as of the PREVIOUS update() call — genuine cross-frame
  // state, since it can't be recomputed from the current frame alone.
  private jointSquare = new Float64Array((MAX_ARMS + 1) * 2)
  private jointNdc = new Float64Array((MAX_ARMS + 1) * 2)
  private penPrevNdc = new Float64Array(2)
  private activeArms = 3

  // Scratch vertex buffer, reused every render() call.
  private vertsCPU = new Float32Array(MAX_VERTS * FLOATS_PER_VERTEX)

  private fadeProgram!: WebGLProgram
  private lineProgram!: WebGLProgram
  private fadeLoc!: FadeLocs
  private lineLoc!: LineLocs

  private fadeVao!: WebGLVertexArrayObject
  private fadeVbo!: WebGLBuffer
  private lineVao!: WebGLVertexArrayObject
  private lineVbo!: WebGLBuffer

  // Code layer (ARCHITECTURE.md §3.3): current source per editable stage, set
  // by field initializers (so a scene without a GL context still reports
  // stock sources) and reset every init() so loadSession's dispose+init
  // starts clean.
  private lineSource = LINE_FS
  private fadeSource = FADE_FS

  init(gpu: Gpu, seed: number): void {
    this.gpu = gpu
    this.random = mulberry32(seed)
    for (const p of this.params) this.values.set(p.name, p.default)

    this.slots = []
    for (let i = 0; i < MAX_ARMS; i++) this.slots.push(drawArmSlot(this.random))

    this.beatCount = 0
    this.phraseCounter = 0
    this.armCursor = 0
    this.accent = 0
    this.bassEnv = 0
    this.phraseBoost = 0

    this.jointSquare.fill(0)
    this.jointNdc.fill(0)
    this.penPrevNdc.fill(0)
    this.activeArms = clampInt(this.getParam('arms'), 2, MAX_ARMS)

    this.lineSource = LINE_FS
    this.fadeSource = FADE_FS

    const gl = gpu.gl
    this.fadeProgram = gpu.compileProgram(FADE_VS, this.fadeSource)
    this.lineProgram = gpu.compileProgram(LINE_VS, this.lineSource)
    this.fadeLoc = this.lookupFadeLocs(this.fadeProgram)
    this.lineLoc = this.lookupLineLocs(this.lineProgram)

    this.fadeVao = gl.createVertexArray()!
    this.fadeVbo = gl.createBuffer()!
    gl.bindVertexArray(this.fadeVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fadeVbo)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    this.lineVao = gl.createVertexArray()!
    this.lineVbo = gl.createBuffer()!
    gl.bindVertexArray(this.lineVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo)
    gl.bufferData(gl.ARRAY_BUFFER, this.vertsCPU.byteLength, gl.DYNAMIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)

    // Compute the resting (machineTime = 0) joint chain so the very first
    // frame's ink segment (drawn from penPrevNdc -> current pen) is a
    // zero-length dot at the true start, not a stray line from the origin.
    this.computeJoints(0, 1, 0.9)
    this.penPrevNdc[0] = this.jointNdc[this.activeArms * 2]
    this.penPrevNdc[1] = this.jointNdc[this.activeArms * 2 + 1]

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

    // Onset brightness accent (pen/trace only): CPU dt-decay, no PRNG.
    if (signals.get('onset')) this.accent = 1
    this.accent = Math.max(0, this.accent - frame.dt / ACCENT_DECAY_SEC)

    // Gentle bass-driven arm-length breathing: exp-smoothed follower
    // (guilloche.ts's idiom) — never raw per-frame bass.
    const bass = signals.get('bass')
    const bassA = 1 - Math.exp(-BASS_SMOOTH_RATE * frame.dt)
    this.bassEnv += (bass - this.bassEnv) * bassA

    // Phrase fade-boost: dt-decay back to 0 after a phrase event fires.
    this.phraseBoost = Math.max(0, this.phraseBoost - frame.dt / PHRASE_BOOST_DECAY_SEC)

    if (signals.get('beat')) {
      this.beatCount++
      this.phraseCounter++
      const phrase = clampInt(this.getParam('phrase'), 1, 16)
      if (this.phraseCounter >= phrase) {
        this.phraseCounter = 0
        // Deterministic count-based PRNG advance (resonance.ts discipline):
        // exactly one fresh ratio draw, one arm slot, cursor cycles in order.
        this.slots[this.armCursor].ratio = drawRatio(this.random)
        this.armCursor = (this.armCursor + 1) % MAX_ARMS
        this.phraseBoost = 1
      }
    }

    // The escapement blend needs the CURRENT beatPhase, which is a pure
    // signal read (not state) — safe to read here since update()/render()
    // see the identical frame/signals for a given tick.
    const beatPhase = clamp01(signals.get('beatPhase'))
    const escapement = this.getParam('escapement')
    const linear = this.beatCount + beatPhase * STRIDE
    const stepped = this.beatCount + easeOutCubic(beatPhase) * STRIDE
    const machineTime = linear + (stepped - linear) * escapement
    this.machineTime = machineTime

    this.activeArms = clampInt(this.getParam('arms'), 2, MAX_ARMS)
    const gearing = this.getParam('gearing')
    const scale = this.getParam('scale')
    const envScale = 1 + BREATHE_SCALE * this.bassEnv

    // Advance the pen-trace's "previous position" state before recomputing
    // this tick's joint chain, so render()'s ink segment spans exactly the
    // machine's motion since the last update() (genuine cross-frame state;
    // everything else here is a pure function of this tick's inputs).
    this.penPrevNdc[0] = this.jointNdc[this.activeArms * 2]
    this.penPrevNdc[1] = this.jointNdc[this.activeArms * 2 + 1]

    this.computeJoints(machineTime, gearing, scale * envScale)
  }

  /** Fills `jointSquare`/`jointNdc` for the currently active arm count. Pure
   *  function of its arguments + `this.slots` — safe to call from update()
   *  (state advance) without violating render()'s "draws only" contract,
   *  since render() never calls this itself. */
  private computeJoints(machineTime: number, gearing: number, scaleTotal: number): void {
    const aspect = this.gpu.canvas.width / this.gpu.canvas.height
    const M = this.activeArms

    let weightSum = 0
    for (let k = 0; k < M; k++) weightSum += Math.pow(LENGTH_DECAY, k) * this.slots[k].wobble

    this.jointSquare[0] = 0
    this.jointSquare[1] = 0
    let x = 0
    let y = 0
    for (let k = 1; k <= M; k++) {
      const slot = this.slots[k - 1]
      const omega = 1 + (slot.ratio - 1) * gearing
      const theta = slot.phase + omega * machineTime
      const weight = Math.pow(LENGTH_DECAY, k - 1) * slot.wobble
      const length = (REACH * scaleTotal * weight) / weightSum
      x += length * Math.cos(theta)
      y += length * Math.sin(theta)
      this.jointSquare[k * 2] = x
      this.jointSquare[k * 2 + 1] = y
    }

    for (let k = 0; k <= M; k++) {
      const [nx, ny] = toNDCFromSquare(this.jointSquare[k * 2], this.jointSquare[k * 2 + 1], aspect)
      this.jointNdc[k * 2] = nx
      this.jointNdc[k * 2 + 1] = ny
    }
  }

  render(_ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()

    const trail = this.getParam('trail')
    const inkFlow = this.getParam('inkFlow')
    const machineGlow = this.getParam('machineGlow')
    const width = surface.width
    const height = surface.height
    const sx = width / 2
    const sy = height / 2
    const M = this.activeArms

    gl.enable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)

    // Fade pass: translucent black quad — the trail's persistence. A short
    // dt-decayed boost right after a phrase event clears it faster ("the
    // machine changes gears and begins a new figure").
    const fadeAlpha = clamp01(1 - trail + this.phraseBoost * PHRASE_BOOST_ADD)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(this.fadeProgram)
    gl.uniform1f(this.fadeLoc.uFade, fadeAlpha)
    gl.bindVertexArray(this.fadeVao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // Build every quad (ink segment, then rods, then joints — draw order
    // below keeps the machine crisply on top of the trace) into the shared
    // scratch buffer.
    const ranges: QuadRange[] = []
    let vCursor = 0

    const penX = this.jointNdc[M * 2]
    const penY = this.jointNdc[M * 2 + 1]
    const hueRaw = this.machineTime * HUE_RATE
    const hue = ((hueRaw % 1) + 1) % 1
    const [ir, ig, ib] = hsl(hue, 0.85, 0.58)
    const inkAlpha = clamp01(0.5 * inkFlow * (1 + 0.6 * this.accent))
    vCursor = this.pushSegment(this.penPrevNdc[0], this.penPrevNdc[1], penX, penY, INK_HALF_WIDTH_PX, sx, sy, vCursor)
    ranges.push({ start: vCursor - VERTS_PER_QUAD, r: ir, g: ig, b: ib, alpha: inkAlpha })

    const armAlpha = clamp01(0.55 * machineGlow)
    const [mr, mg, mb] = [0.75, 0.88, 1.0] // cool "machined steel" — distinct from the self-rainbow ink.
    for (let k = 1; k <= M; k++) {
      const ax = this.jointNdc[(k - 1) * 2]
      const ay = this.jointNdc[(k - 1) * 2 + 1]
      const bx = this.jointNdc[k * 2]
      const by = this.jointNdc[k * 2 + 1]
      vCursor = this.pushSegment(ax, ay, bx, by, ARM_HALF_WIDTH_PX, sx, sy, vCursor)
      ranges.push({ start: vCursor - VERTS_PER_QUAD, r: mr, g: mg, b: mb, alpha: armAlpha })
    }

    for (let k = 0; k <= M; k++) {
      const jx = this.jointNdc[k * 2]
      const jy = this.jointNdc[k * 2 + 1]
      const isPen = k === M
      const half = isPen ? PEN_JOINT_HALF_PX : JOINT_HALF_PX
      vCursor = this.pushQuad(jx, jy, half, sx, sy, vCursor)
      const glow = isPen ? clamp01(machineGlow * (1 + 0.5 * this.accent)) : machineGlow
      const [jr, jg, jb] = isPen ? [1, 1, 1] : [mr, mg, mb]
      ranges.push({ start: vCursor - VERTS_PER_QUAD, r: jr, g: jg, b: jb, alpha: clamp01(0.7 * glow) })
    }

    gl.bindVertexArray(this.lineVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.vertsCPU, 0, vCursor * FLOATS_PER_VERTEX)

    // Additive: the ink trace brightens where strokes overlap, and the
    // machine glows rather than flatly occludes it.
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE)
    gl.useProgram(this.lineProgram)
    for (const range of ranges) {
      gl.uniform3f(this.lineLoc.uColor, range.r, range.g, range.b)
      gl.uniform1f(this.lineLoc.uAlpha, range.alpha)
      gl.drawArrays(gl.TRIANGLE_STRIP, range.start, VERTS_PER_QUAD)
    }
    gl.bindVertexArray(null)
  }

  /** Appends a pixel-uniform-width oriented quad from (ax,ay) to (bx,by)
   *  (both NDC) to `vertsCPU` at `vCursor`, returns the new cursor. Degenerate
   *  (ax==bx && ay==by, e.g. the very first frame's zero-length ink segment)
   *  falls back to the x-axis normal rather than dividing by a zero length. */
  private pushSegment(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    halfWidthPx: number,
    sx: number,
    sy: number,
    vCursor: number,
  ): number {
    const dxPx = (bx - ax) * sx
    const dyPx = (by - ay) * sy
    const len = Math.hypot(dxPx, dyPx) || 1
    const nxPx = -dyPx / len
    const nyPx = dxPx / len
    const nx = (nxPx * halfWidthPx) / sx
    const ny = (nyPx * halfWidthPx) / sy
    const fi = vCursor * FLOATS_PER_VERTEX
    this.vertsCPU[fi] = ax + nx
    this.vertsCPU[fi + 1] = ay + ny
    this.vertsCPU[fi + 2] = ax - nx
    this.vertsCPU[fi + 3] = ay - ny
    this.vertsCPU[fi + 4] = bx + nx
    this.vertsCPU[fi + 5] = by + ny
    this.vertsCPU[fi + 6] = bx - nx
    this.vertsCPU[fi + 7] = by - ny
    return vCursor + VERTS_PER_QUAD
  }

  /** Appends an axis-aligned pixel-uniform-size square centered at (cx,cy)
   *  (NDC) — a joint marker. */
  private pushQuad(cx: number, cy: number, halfPx: number, sx: number, sy: number, vCursor: number): number {
    const ox = halfPx / sx
    const oy = halfPx / sy
    const fi = vCursor * FLOATS_PER_VERTEX
    this.vertsCPU[fi] = cx - ox
    this.vertsCPU[fi + 1] = cy - oy
    this.vertsCPU[fi + 2] = cx + ox
    this.vertsCPU[fi + 3] = cy - oy
    this.vertsCPU[fi + 4] = cx - ox
    this.vertsCPU[fi + 5] = cy + oy
    this.vertsCPU[fi + 6] = cx + ox
    this.vertsCPU[fi + 7] = cy + oy
    return vCursor + VERTS_PER_QUAD
  }

  resize(width: number, height: number): void {
    this.gpu.resize(width, height)
    this.gpu.gl.clearColor(0, 0, 0, 1)
    this.gpu.gl.clear(this.gpu.gl.COLOR_BUFFER_BIT)
  }

  dispose(): void {
    const gl = this.gpu.gl
    gl.deleteProgram(this.fadeProgram)
    gl.deleteProgram(this.lineProgram)
    gl.deleteVertexArray(this.fadeVao)
    gl.deleteVertexArray(this.lineVao)
    gl.deleteBuffer(this.fadeVbo)
    gl.deleteBuffer(this.lineVbo)
  }

  private lookupFadeLocs(program: WebGLProgram): FadeLocs {
    return { uFade: this.gpu.gl.getUniformLocation(program, 'uFade') }
  }

  private lookupLineLocs(program: WebGLProgram): LineLocs {
    return {
      uColor: this.gpu.gl.getUniformLocation(program, 'uColor'),
      uAlpha: this.gpu.gl.getUniformLocation(program, 'uAlpha'),
    }
  }

  getShaderSources(): ShaderStage[] {
    return [
      { key: 'line-fs', label: 'Ink & mechanism color (line-fs)', source: this.lineSource },
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
        this.lineLoc = this.lookupLineLocs(program)
        this.lineSource = source
        return
      }
      case 'fade-fs': {
        const program = this.gpu.compileProgram(FADE_VS, source)
        gl.deleteProgram(this.fadeProgram)
        this.fadeProgram = program
        this.fadeLoc = this.lookupFadeLocs(program)
        this.fadeSource = source
        return
      }
      default:
        throw new Error(`Unknown shader stage "${key}" for scene "${this.meta.id}"`)
    }
  }
}
