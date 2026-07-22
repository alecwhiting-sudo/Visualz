import { mulberry32, type Prng } from '../../core/prng'
import type { Gpu } from '../../gpu/context'
import type { RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'

/**
 * Geometry family wildcard: "Guilloché" — a full-bleed, beat-locked ornamental-
 * lathe curve engine. Lissajous's richer cousin: each layer is a sum of TWO
 * harmonically related sines per axis (not one), rendered as a filled ribbon
 * (CPU-built triangle-strip, thickness-controllable — real `lineWidth` is
 * clamped to 1px on most WebGL2 drivers including SwiftShader, so a thickness
 * knob needs real geometry) and additively layered for an engraved-metal
 * interference look, same "curve engine, not a fullscreen shader" shape as
 * lissajous.ts/glyphlattice.ts.
 *
 * Two things distinguish it from lissajous.ts:
 *
 * 1. FULL BLEED (REQUIREMENTS.md's "cover the whole display, not a square"):
 *    lissajous's vertex shader *undoes* the aspect stretch (`p.x /= max(uAspect,1)`)
 *    to keep the curve's shape undistorted — which is exactly what leaves it
 *    letterboxed inside the shorter screen axis. Guilloché does the opposite
 *    on purpose: points are emitted directly in clip space with NO aspect
 *    correction at all. Clip-space NDC ([-1,1] on both axes) already maps onto
 *    the FULL viewport on both axes at any aspect ratio — that's what the
 *    rasterizer does by construction. So `x(s) = BLEED * (weighted sine sum)`,
 *    `y(s) = BLEED * (weighted cosine sum)` with BLEED close to 1 and the
 *    per-axis weights normalized to sum to 1 (dividing by a1+a2 / b1+b2)
 *    guarantees the envelope reaches near all four edges on every aspect —
 *    16:9, 9:16, 1:1 alike — with no per-aspect special-casing needed. Verified
 *    by the dedicated edge-sampling assertion in guilloche.spec.ts.
 *
 * 2. BEAT-LOCKED STRUCTURE (not just continuous drift): two independent
 *    beat-driven mechanisms, both advanced only on the `beat` signal pulse
 *    (never per-frame, never per-onset):
 *      - Every beat, each layer's phase-drift TARGET jumps by a fixed step
 *        (`sweep` × a per-layer detune multiplier spread by `weave`); the
 *        actual rendered phase each frame is `lerp(prevTarget, nextTarget,
 *        easeOutCubic(beatPhase))` — an ease-out settle that lands exactly
 *        on target the instant the next beat fires, so motion visibly
 *        "arrives" in time with the music rather than drifting continuously
 *        against the wall clock.
 *      - Every `cycle` beats, ONE layer's harmonics (p,q,r,u + the a2/b2
 *        richness weights) are redrawn wholesale from the PRNG pool — a
 *        discrete "phrase" change, like a kaleidoscope tumbler click,
 *        deliberately NOT crossfaded (resonance.ts crossfades; here the
 *        instant pop *is* the beat-locked aesthetic the user asked for).
 *    The PRNG (mulberry32(seed)) is advanced ONLY at init (MAX_LAYERS harmonic
 *    + identity draws) and once per cycle-event (one fresh harmonics draw) —
 *    never per-frame, per-beat, or per-onset — so replay is exactly
 *    reproducible from the `beat`/`onset` signal's frame-indexed pulse
 *    sequence alone, which fixed-timestep replay reproduces exactly.
 *    Onsets separately drive a CPU dt-decay brightness accent (no PRNG).
 *
 * `layers`/`complexity` only change how many of the MAX_LAYERS pre-generated
 * pool slots are drawn / the integer range future harmonics draws use — never
 * a live regenerate, same "knobs choose from a pre-baked pool" discipline as
 * glyphlattice.ts's curves/strings.
 *
 * Follow-up (params 8 -> 11; schema ORDER matters — the first 8 are the
 * hardware macro slots, per fractallab.ts's "Schema order matters" note):
 * `symmetry`, `breathe`, `spin` slot in at positions 2/5/6 respectively:
 *
 *   - `symmetry` (default 1, a no-op fold): each layer is drawn `symmetry`
 *     times, copy k rotated by `TAU*k/symmetry` about the screen center
 *     (k=0 always untransformed). Curve points live in raw NDC (the
 *     full-bleed mechanism above) — rotating there directly would SHEAR
 *     under a non-square aspect (NDC's x/y already scale unevenly relative
 *     to physical pixels once width != height). So rotation instead goes
 *     through an aspect-corrected "square" space — literally the inverse of
 *     lissajous.ts's own correction (`toSquare`/`toNDCFromSquare` below) —
 *     rotate there (an isotropic, angle-preserving physical-pixel rotation),
 *     then map back to full-bleed NDC. This is verified to preserve equal
 *     physical pixel distances pre/post rotation regardless of aspect (see
 *     the function's own derivation comment).
 *   - `breathe` (default 0.35): scales the whole normalized envelope by
 *     `1 + breathe * bassEnv * 0.35`, where `bassEnv` is a CPU dt-smoothed
 *     bass follower — fractallab.ts's exact envelope idiom
 *     (`a = 1 - exp(-RATE*dt); env += (bass-env)*a`) — never raw per-frame
 *     bass, so there's no zipper noise.
 *   - `spin` (default 0.06): a CPU dt-integrated angle (`spinAngle += dt *
 *     spin * SPIN_RATE_SCALE`), applied through the SAME aspect-corrected
 *     rotation path as `symmetry`, to every copy including the k=0 base —
 *     so nonzero spin does pull the base copy's corners in from the far
 *     edges mid-rotation; accepted as the performer's choice. Both `bassEnv`
 *     and `spinAngle` are plain dt-accumulators advanced ONLY in update()
 *     (never render(), per the "render() draws only" frozen-control-tick
 *     rule) — no PRNG involved, so they don't affect the beat-lock replay
 *     discipline above.
 *
 * Net effect on the two prior invariants: at symmetry=1 the fold introduces
 * no extra copies (still exactly one ribbon per layer), so the full-bleed
 * edge-sampling test still passes with spin pinned to 0 (its own comment
 * explains why spin must be pinned there). `breathe`/`spin` do change the
 * frame-150 golden at stock defaults (both are nonzero by spec) — an
 * intentional visual update, not a regression.
 */

const TAU = Math.PI * 2
const MAX_LAYERS = 8
const MAX_SYMMETRY = 6
const POINTS_PER_CURVE = 320
// Envelope half-extent in clip space. Kept a little under 1 so the ribbon's
// own half-thickness never clips past the true edge, while still landing
// well within the non-blank edge-sampling margin used by the golden test.
const BLEED = 0.94
// Radians of phase-drift target advance per beat at sweep=1, detune=1.
const BASE_STEP = Math.PI * 0.6
// Per-layer detune multiplier range: [1 - SPREAD, 1 + SPREAD] at weave=1.
const DETUNE_SPREAD = 0.6
const ACCENT_DECAY_SEC = 0.35
// `breathe`'s bass-follower smoothing rate — fractallab.ts's BASS_SMOOTH_RATE,
// reused verbatim so both scenes' bass envelopes feel the same under a knob.
const BASS_SMOOTH_RATE = 3.0
// `breathe`'s envelope-scale coefficient, per the task spec's own formula.
const BREATHE_SCALE = 0.35
// `spin`'s radians-per-second at spin=1.
const SPIN_RATE_SCALE = 0.35

const LINE_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() {
  // Positions already arrive in final clip space (see class doc's full-bleed
  // note) — deliberately NO aspect correction here, unlike lissajous.ts.
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const LINE_FS = `#version 300 es
precision highp float;
uniform vec3 uColor;
uniform float uAlpha;
out vec4 outColor;
void main() {
  // Alpha carries the additive-blend contribution (see render()'s
  // gl.blendFunc(SRC_ALPHA, ONE)) so overlapping layers brighten instead of
  // simply occluding — the "layered interference" look the task asked for.
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

interface LayerHarmonics {
  p: number
  q: number
  r: number
  u: number
  a2: number
  b2: number
}

interface LayerIdentity {
  phi1: number
  phi2: number
  psi1: number
  psi2: number
  detuneRaw: number
}

function genHarmonics(rng: Prng, complexity: number): LayerHarmonics {
  const maxH = 1 + Math.max(1, Math.round(complexity))
  const harm = () => 1 + Math.floor(rng() * maxH)
  return {
    p: harm(),
    q: harm(),
    r: harm(),
    u: harm(),
    a2: 0.3 + rng() * 0.5,
    b2: 0.3 + rng() * 0.5,
  }
}

function genIdentity(rng: Prng): LayerIdentity {
  return {
    phi1: rng() * TAU,
    phi2: rng() * TAU,
    psi1: rng() * TAU,
    psi2: rng() * TAU,
    detuneRaw: 1 - DETUNE_SPREAD + rng() * (2 * DETUNE_SPREAD),
  }
}

/** Raw guilloché point at arc-parameter `s`, per the class doc's x(s)/y(s). */
function layerPoint(h: LayerHarmonics, id: LayerIdentity, s: number, drift: number): [number, number] {
  const phi1 = id.phi1 + drift
  const phi2 = id.phi2 + drift * 1.3
  const psi1 = id.psi1 + drift * 0.7
  const psi2 = id.psi2 + drift * 1.6
  const a1 = 1
  const b1 = 1
  const x = (BLEED * (a1 * Math.sin(h.p * s + phi1) + h.a2 * Math.sin(h.q * s + phi2))) / (a1 + h.a2)
  const y = (BLEED * (b1 * Math.cos(h.r * s + psi1) + h.b2 * Math.cos(h.u * s + psi2))) / (b1 + h.b2)
  return [x, y]
}

// --- Aspect-corrected rotation for `symmetry`/`spin` (class doc) -----------
//
// lissajous.ts's vertex shader maps an isotropic "square" coordinate to NDC
// via `p.x /= max(aspect,1); p.y *= min(aspect,1)`. `toSquare` is exactly its
// inverse; `toNDCFromSquare` is that same forward map. Rotating in between
// is a true on-screen (equal-physical-pixel-distance) rotation at any
// aspect: a point at NDC (0, y0) — "physically" y0*height/2 px north of
// center — maps to square-space (0, y0) at aspect a=w/h>=1 (ax=a, ay=1), a
// 90 deg rotation gives square (-y0, 0), which maps back to NDC
// (-y0/a, 0) = physical pixel offset (-y0/a * width/2, 0) = (-y0*height/2, 0)
// since width = a*height — the same physical magnitude, now westward: a
// genuine 90 deg on-screen turn, not an ellipse shear.
function toSquare(x: number, y: number, aspect: number): [number, number] {
  const ax = Math.max(aspect, 1)
  const ay = Math.min(aspect, 1)
  return [x * ax, y / ay]
}

function toNDCFromSquare(x: number, y: number, aspect: number): [number, number] {
  const ax = Math.max(aspect, 1)
  const ay = Math.min(aspect, 1)
  return [x / ax, y * ay]
}

/** Rotates an NDC point by `angle` radians as a true on-screen rotation. */
function rotateNDC(x: number, y: number, aspect: number, angle: number): [number, number] {
  if (angle === 0) return [x, y]
  const [xsq, ysq] = toSquare(x, y, aspect)
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const xr = xsq * c - ysq * s
  const yr = xsq * s + ysq * c
  return toNDCFromSquare(xr, yr, aspect)
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

// Vertex layout: pos.xy only, one draw call per (layer, symmetry-copy) pair
// with a uColor/uAlpha uniform pair (lissajous.ts's single-uniform-color
// convention) — all copies of a given layer share that layer's color.
const FLOATS_PER_VERTEX = 2
const MAX_VERTS_PER_LAYER = 2 * (POINTS_PER_CURVE + 1) // +1 closes the loop
const MAX_TOTAL_VERTS = MAX_LAYERS * MAX_SYMMETRY * MAX_VERTS_PER_LAYER

interface FadeLocs {
  uFade: WebGLUniformLocation | null
}
interface LineLocs {
  uColor: WebGLUniformLocation | null
  uAlpha: WebGLUniformLocation | null
}

export class GuillocheScene implements SceneRuntime {
  meta = { id: 'guilloche', name: 'Guilloché', family: 'geometry' as const }

  // Schema order matters (fractallab.ts's own note applies here too): the
  // first 8 entries are the hardware macro slots, positional — this is the
  // full param set in the order the follow-up task specified.
  params: ParamSchema[] = [
    { name: 'layers', label: 'Layers', min: 2, max: 8, default: 5, step: 1 },
    { name: 'symmetry', label: 'Symmetry', min: 1, max: 6, default: 1, step: 1 },
    { name: 'cycle', label: 'Cycle (beats)', min: 1, max: 16, default: 4, step: 1 },
    { name: 'sweep', label: 'Sweep', min: 0, max: 2, default: 0.8 },
    { name: 'breathe', label: 'Breathe', min: 0, max: 1, default: 0.35 },
    { name: 'spin', label: 'Spin', min: -1, max: 1, default: 0.06 },
    { name: 'weave', label: 'Weave', min: 0, max: 1, default: 0.5 },
    { name: 'hue', label: 'Hue', min: 0, max: 1, default: 0.55 },
    { name: 'complexity', label: 'Complexity', min: 1, max: 6, default: 3, step: 1 },
    { name: 'thickness', label: 'Thickness', min: 0.5, max: 3, default: 1.2 },
    { name: 'trail', label: 'Trail', min: 0.7, max: 0.995, default: 0.93 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu
  private random: Prng = mulberry32(1)

  // CPU-only state (ARCHITECTURE.md §1). `harmonics`/`identity` are fixed-size
  // MAX_LAYERS pools generated at init; `identity` never changes again,
  // `harmonics` is redrawn one slot at a time on cycle events (see class doc).
  // `prevPhase`/`nextPhase` are the beat-locked ease targets; `beatCounter`/
  // `cycleCursor` are the discrete event counters; `accent` is the onset
  // brightness envelope (dt-decayed in update(), read in render()).
  private harmonics: LayerHarmonics[] = []
  private identity: LayerIdentity[] = []
  private prevPhase = new Float64Array(MAX_LAYERS)
  private nextPhase = new Float64Array(MAX_LAYERS)
  private beatCounter = 0
  private cycleCursor = 0
  private accent = 0
  // `breathe`'s bass follower and `spin`'s dt-integrated rotation angle —
  // both plain dt-accumulators advanced ONLY in update() (see class doc).
  private bassEnv = 0
  private spinAngle = 0

  // Scratch curve-point buffers, reused every render() call (avoids a fresh
  // allocation per frame now that layers x symmetry can be up to 48 draws):
  // `basePoints` holds one layer's pre-rotation (post-breathe) curve; each
  // symmetry copy rotates it into `copyPoints` before ribbon-building.
  private basePoints = new Float64Array(POINTS_PER_CURVE * 2)
  private copyPoints = new Float64Array(POINTS_PER_CURVE * 2)

  private fadeProgram!: WebGLProgram
  private lineProgram!: WebGLProgram
  private fadeLoc!: FadeLocs
  private lineLoc!: LineLocs

  private fadeVao!: WebGLVertexArrayObject
  private fadeVbo!: WebGLBuffer
  private lineVao!: WebGLVertexArrayObject
  private lineVbo!: WebGLBuffer

  private vertsCPU = new Float32Array(MAX_TOTAL_VERTS * FLOATS_PER_VERTEX)

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

    const complexity = this.getParam('complexity')
    this.harmonics = []
    this.identity = []
    for (let i = 0; i < MAX_LAYERS; i++) {
      this.harmonics.push(genHarmonics(this.random, complexity))
      this.identity.push(genIdentity(this.random))
    }
    this.prevPhase = new Float64Array(MAX_LAYERS)
    this.nextPhase = new Float64Array(MAX_LAYERS)
    this.beatCounter = 0
    this.cycleCursor = 0
    this.accent = 0
    this.bassEnv = 0
    this.spinAngle = 0

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

    // Onset brightness accent: CPU dt-decay, no PRNG.
    if (signals.get('onset')) this.accent = 1
    this.accent = Math.max(0, this.accent - frame.dt / ACCENT_DECAY_SEC)

    // `breathe`'s bass follower: exp-smoothed, fractallab.ts's idiom — never
    // raw per-frame bass (that would zipper the envelope every frame).
    const bass = signals.get('bass')
    const bassA = 1 - Math.exp(-BASS_SMOOTH_RATE * frame.dt)
    this.bassEnv += (bass - this.bassEnv) * bassA

    // `spin`'s whole-figure rotation: plain dt integration of the current
    // knob value, so a live spin change takes effect as a rate change from
    // here on, not a retroactive rewrite of the accumulated angle.
    this.spinAngle += frame.dt * this.getParam('spin') * SPIN_RATE_SCALE

    if (signals.get('beat')) {
      const sweep = this.getParam('sweep')
      const weave = this.getParam('weave')
      for (let i = 0; i < MAX_LAYERS; i++) {
        const detune = 1 + (this.identity[i].detuneRaw - 1) * weave
        this.prevPhase[i] = this.nextPhase[i]
        this.nextPhase[i] += sweep * BASE_STEP * detune
      }

      this.beatCounter++
      const cycle = clampInt(this.getParam('cycle'), 1, 16)
      if (this.beatCounter >= cycle) {
        this.beatCounter = 0
        this.harmonics[this.cycleCursor] = genHarmonics(this.random, this.getParam('complexity'))
        this.cycleCursor = (this.cycleCursor + 1) % MAX_LAYERS
      }
    }
  }

  render(ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()

    const layers = clampInt(this.getParam('layers'), 2, MAX_LAYERS)
    const symmetry = clampInt(this.getParam('symmetry'), 1, MAX_SYMMETRY)
    const thicknessParam = this.getParam('thickness')
    const trail = this.getParam('trail')
    const hue = this.getParam('hue')
    const breathe = this.getParam('breathe')
    const rms = ctx.signals.get('rms')
    const beatPhase = clamp01(ctx.signals.get('beatPhase'))
    const ease = easeOutCubic(beatPhase)

    const width = surface.width
    const height = surface.height
    const aspect = width / height
    const sx = width / 2
    const sy = height / 2
    const halfWidthPx = Math.max(0.5, thicknessParam * 1.5 * (1 + 0.2 * rms) * (1 + 0.5 * this.accent))
    // `breathe`: scales the whole normalized envelope by the smoothed bass
    // follower (class doc) — always >= 1, so it only ever expands the
    // envelope, never pulls it back inside the full-bleed guarantee.
    const envScale = 1 + breathe * this.bassEnv * BREATHE_SCALE
    // Additive layers brighten fast once `symmetry` multiplies the ribbon
    // count per layer; damp per-copy alpha by sqrt(symmetry) so a dense
    // rosette doesn't just blow out to solid white (symmetry=1 => no-op).
    const alphaScale = 1 / Math.sqrt(symmetry)

    gl.enable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)

    // Fade pass: translucent black quad leaves trails from previous frames.
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(this.fadeProgram)
    gl.uniform1f(this.fadeLoc.uFade, 1 - trail)
    gl.bindVertexArray(this.fadeVao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // Build each active layer's ribbon geometry (CPU) into the shared
    // buffer — `symmetry` rotated copies per layer (class doc).
    const N = POINTS_PER_CURVE
    const ranges: { start: number; count: number; r: number; g: number; b: number; alpha: number }[] = []
    let vCursor = 0 // vertex index (not float index)

    for (let li = 0; li < layers; li++) {
      const h = this.harmonics[li]
      const id = this.identity[li]
      const drift = this.prevPhase[li] + (this.nextPhase[li] - this.prevPhase[li]) * ease

      // Base curve (pre-rotation), breathe-scaled.
      for (let i = 0; i < N; i++) {
        const s = (i / N) * TAU
        const [x, y] = layerPoint(h, id, s, drift)
        this.basePoints[i * 2] = x * envScale
        this.basePoints[i * 2 + 1] = y * envScale
      }

      const hueL = (hue + li * 0.07) % 1
      const light = 0.46 + 0.1 * Math.sin(li * 1.9 + 1) + 0.12 * this.accent
      const [r, g, b] = hsl(hueL, 0.8, light)
      const alpha = (0.42 + 0.12 * this.accent) * alphaScale

      for (let k = 0; k < symmetry; k++) {
        // k=0 is always untransformed by the fold itself (preserves full
        // bleed at symmetry=1); `spin` still rotates every copy, k=0 included.
        const angle = this.spinAngle + (k > 0 ? (TAU * k) / symmetry : 0)
        for (let i = 0; i < N; i++) {
          const [rx, ry] = rotateNDC(this.basePoints[i * 2], this.basePoints[i * 2 + 1], aspect, angle)
          this.copyPoints[i * 2] = rx
          this.copyPoints[i * 2 + 1] = ry
        }

        const start = vCursor
        for (let i = 0; i <= N; i++) {
          const curI = (i % N) * 2
          const prevI = ((i - 1 + N) % N) * 2
          const nextI = ((i + 1) % N) * 2
          // Central-difference tangent (in pixel-uniform space so the
          // ribbon's apparent width stays isotropic regardless of canvas
          // aspect), then rotate 90° for the extrusion normal.
          const dx = (this.copyPoints[nextI] - this.copyPoints[prevI]) * sx
          const dy = (this.copyPoints[nextI + 1] - this.copyPoints[prevI + 1]) * sy
          const len = Math.hypot(dx, dy) || 1
          const nxPx = -dy / len
          const nyPx = dx / len
          const nx = (nxPx * halfWidthPx) / sx
          const ny = (nyPx * halfWidthPx) / sy

          const cx = this.copyPoints[curI]
          const cy = this.copyPoints[curI + 1]
          const fi = vCursor * FLOATS_PER_VERTEX
          this.vertsCPU[fi] = cx + nx
          this.vertsCPU[fi + 1] = cy + ny
          this.vertsCPU[fi + 2] = cx - nx
          this.vertsCPU[fi + 3] = cy - ny
          vCursor += 2
        }
        ranges.push({ start, count: vCursor - start, r, g, b, alpha })
      }
    }

    gl.bindVertexArray(this.lineVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.vertsCPU, 0, vCursor * FLOATS_PER_VERTEX)

    // Additive blend: overlapping layers/copies brighten (engraved-metal
    // interference).
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE)
    gl.useProgram(this.lineProgram)
    for (const range of ranges) {
      gl.uniform3f(this.lineLoc.uColor, range.r, range.g, range.b)
      gl.uniform1f(this.lineLoc.uAlpha, range.alpha)
      gl.drawArrays(gl.TRIANGLE_STRIP, range.start, range.count)
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
      { key: 'line-fs', label: 'Ribbon color (line-fs)', source: this.lineSource },
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
