import { mulberry32, type Prng } from '../../core/prng'
import type { Gpu } from '../../gpu/context'
import type { RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'
import {
  ATLAS_COLS,
  ATLAS_H,
  ATLAS_W,
  ATLAS_CELL,
  GLYPH_FS,
  GLYPH_H,
  GLYPH_VS,
  GLYPH_W,
  NUM_GLYPHS,
  buildAtlasData,
} from '../families/geometry/glyphFont'

/**
 * Geometry family: "Glyph Geometry" — the user's brief was blunt: "I don't
 * want there to be lines, I want there to be lines made of text." So unlike
 * glyphlattice.ts (which draws real GL_LINE_LOOP curves *plus* a decorative
 * text overlay), this scene contains NO line primitive of any kind. Every
 * stroke on screen — every arc of every outline — is a chain of rotated
 * glyph quads sampled directly off the parametric curve. The text IS the
 * geometry; delete the glyph pass and there is nothing left to see.
 *
 * `rings` nested closed outlines, each sampled at `density` points around
 * its own parametric curve, each sample rendered as one glyph quad rotated
 * to the curve's local tangent (same "batched instanced-style quads, CPU
 * aspect correction, rotate-to-tangent" technique as glyphlattice.ts — see
 * that file's class doc for why aspect correction must happen before
 * rotation). Consecutive glyphs around a ring repeat a short PRNG-chosen
 * "word" so the outline reads as calligraphy wrapping the shape, not noise.
 *
 * The outline maths continuously morphs across three families by the
 * `figure` knob (0..2):
 *   0 — epitrochoid rosette (rolling-circle curve, integer ratio so it
 *       closes; petal depth breathed by bass)
 *   1 — spirograph (inner-roll trochoid)
 *   2 — star-polygon / rose hybrid
 * `figure` in [0,1] blends epitrochoid->spirograph; [1,2] blends
 * spirograph->star/rose — same adjacent-pair lerp idiom as glyphlattice's
 * `morph`.
 *
 * PRNG discipline (resonance.ts's pattern, reused verbatim by glyphlattice.ts
 * too): `random` is advanced ONLY at init() — generating MAX_RINGS ring
 * curve-parameter sets, MAX_RINGS starting words, and MAX_RINGS starting
 * rotation offsets up front — and on each `onset` pulse in update(), which
 * re-rolls exactly one ring's word and gives that ring's rotation a one-time
 * "kick" (an offset jump, not a velocity change — the ring keeps spinning at
 * its own steady `rotRate` afterward, just from a new phase). The `rings`/
 * `density` knobs only change how much of the pre-generated MAX_RINGS pool
 * is drawn and how finely each ring is sampled — never regeneration — so
 * scrubbing them live never touches the PRNG, exactly like glyphlattice's
 * `curves`/`strings`.
 *
 * Everything else (ring rotation's continuous sweep, exponent drift, bass
 * spikiness, rms breathing) is plain maths over `ctx.frame.time`/signals —
 * never randomness — so render() alone (no update()) reproduces the exact
 * same frame: frozen control ticks read the last committed `rotOffset`/word
 * state and recompute the rest fresh, nothing here counts as "advancing".
 *
 * Coordinate convention: identical to glyphlattice.ts — aspect correction on
 * the CPU before building the vertex buffer, so rotated glyph quads (rotated
 * to the local tangent) don't skew under a non-uniform x/y aspect scale.
 */

// ---------------------------------------------------------------------------
// Fade pass (keeps the "living calligraphy" trail): a fullscreen
// near-transparent black quad, drawn before the glyphs each frame. Own local
// constants (glyphlattice.ts's FADE_VS/FADE_FS are not shared — this scene
// additionally exposes fade-fs in the code layer, which glyphlattice does
// not).
const FADE_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`

const FADE_FS = `#version 300 es
precision highp float;
uniform float uFade;
out vec4 outColor;
void main() { outColor = vec4(0.0, 0.0, 0.0, uFade); }`

// ---------------------------------------------------------------------------
// Curve geometry.

const TAU = Math.PI * 2
const AMP_BASE = 0.8
const TANGENT_EPS = 0.01
const MAX_RINGS = 8
const MAX_DENSITY = 200
const MIN_WORD_LEN = 3
const MAX_WORD_LEN = 8
const GLYPH_SCALE = 2.5 // maps the glyphSize knob to a legible on-screen size (same convention as glyphlattice.ts)
const TRAVEL_RATE = 0.5 // rad/s of glyph-chain traversal per unit of the `speed` knob (see class doc)
const GLYPH_FLOATS_PER_VERTEX = 8 // pos.xy + uv.xy + color.rgba
const MAX_GLYPH_VERTS = MAX_RINGS * MAX_DENSITY * 6

interface RingParams {
  // Epitrochoid rosette (family A) — swapped in for the Gielis superformula
  // (user decision: the superformula's APPLICATIONS are actively patented
  // (Gielis/Genicap), a commercial-sale risk; the epitrochoid is classic
  // public-domain 19th-century curve maths with comparable ornamental
  // richness). hyK is the integer rolling ratio so the curve closes over one
  // s:[0,TAU) loop; hyD is the pen distance (petal depth), breathed by bass.
  hyr: number
  hyK: number
  hyD: number
  hyWob: number
  hyPhase: number
  // Spirograph epitrochoid (family B). spR is always spr*kFactor so R/r is
  // an exact integer and the curve closes after exactly one s:[0,TAU) loop.
  spR: number
  spr: number
  spd: number
  spPhase: number
  // Star-polygon / rose hybrid (family C).
  stPoints: number
  stInner: number
  stSoftness: number
  stPhase: number
  // Shared: this ring's steady rotation rate (rad/s at evolve=1) — nested
  // rings get slightly different rates purely from this PRNG draw, giving
  // the "living mandala" desync the task asked for.
  rotRate: number
}

function genRingParams(rng: Prng): RingParams {
  const spr = 1 + Math.floor(rng() * 3) // 1..3
  const kFactor = 2 + Math.floor(rng() * 4) // 2..5
  const spR = spr * kFactor
  return {
    hyr: 1 + Math.floor(rng() * 3),
    hyK: 2 + Math.floor(rng() * 5),
    hyD: 0.4 + rng() * 1.4,
    hyWob: 0.15 + rng() * 0.5,
    hyPhase: rng() * TAU,
    spR,
    spr,
    spd: (0.3 + rng() * 1.2) * spr,
    spPhase: rng() * TAU,
    stPoints: 3 + Math.floor(rng() * 6),
    stInner: 0.25 + rng() * 0.35,
    stSoftness: 0.2 + rng() * 0.5,
    stPhase: rng() * TAU,
    rotRate: (rng() - 0.5) * 0.4,
  }
}

interface RingWord {
  glyphs: number[]
}

function genRingWord(rng: Prng): RingWord {
  const len = MIN_WORD_LEN + Math.floor(rng() * (MAX_WORD_LEN - MIN_WORD_LEN + 1))
  const glyphs: number[] = new Array(len)
  for (let g = 0; g < len; g++) glyphs[g] = Math.floor(rng() * NUM_GLYPHS)
  return { glyphs }
}

/** Family A: epitrochoid rosette — a circle of radius `hyr` rolling around
 *  the OUTSIDE of a larger one (integer ratio hyK+1, so the curve closes),
 *  pen at distance `d` from the rolling center. `bass` deepens the petals
 *  (pen distance), never the ratio, so figure=0 stays recognizable as the
 *  same ring shape between beats; `hyWob` adds a slow ornamental wobble. */
function epitrochoidPoint(rp: RingParams, theta: number, driftT: number, bass: number): [number, number] {
  const th = theta + rp.hyPhase
  const ratio = rp.hyK + 1
  const arm = rp.hyr * ratio // R + r with R = hyr * hyK
  const d =
    rp.hyD * rp.hyr * (1 + bass * 0.5 + rp.hyWob * Math.sin(driftT * 0.09 + rp.hyPhase))
  const reach = arm + Math.abs(d)
  const scale = 1 / (reach * 1.05)
  const x = (arm * Math.cos(th) - d * Math.cos(ratio * th)) * scale
  const y = (arm * Math.sin(th) - d * Math.sin(ratio * th)) * scale
  return [x, y]
}

/** Family B: spirograph epitrochoid, normalized so its max reach is ~1
 *  (same order of magnitude as the other two families, for a smooth `figure`
 *  blend across the family boundary). */
function spirographPoint(rp: RingParams, theta: number): [number, number] {
  const th = theta + rp.spPhase
  const rr = rp.spR - rp.spr
  const ratio = rr / rp.spr
  const reach = rr + rp.spd
  const scale = 1 / (reach * 1.05)
  const x = (rr * Math.cos(th) + rp.spd * Math.cos(ratio * th)) * scale
  const y = (rr * Math.sin(th) - rp.spd * Math.sin(ratio * th)) * scale
  return [x, y]
}

/** Family C: a triangle-wave-in-angle "star polygon" radius (sharp cusps at
 *  each of `stPoints` vertices) blended with a plain cos(k*theta) rose term
 *  by the ring's own `stSoftness` draw — the "sharp star vertices softened
 *  by a cos term" the task asked for. */
function starRosePoint(rp: RingParams, theta: number): [number, number] {
  const th = theta + rp.stPhase
  const starAngle = rp.stPoints * th
  const wrapped = ((starAngle % TAU) + TAU) % TAU
  const triangle = Math.abs(wrapped / Math.PI - 1) // 1 at each cusp, 0 at each valley
  const sharpR = rp.stInner + (1 - rp.stInner) * triangle
  const softR = 0.5 + 0.5 * Math.cos(starAngle)
  const r = sharpR * (1 - rp.stSoftness) + softR * rp.stSoftness
  return [r * Math.cos(th), r * Math.sin(th)]
}

/** Blends the three families by `figure` (0..2): [0,1] epitrochoid->
 *  spirograph, [1,2] spirograph->star/rose. */
function ringRawPoint(rp: RingParams, theta: number, driftT: number, figure: number, bass: number): [number, number] {
  const f = figure < 0 ? 0 : figure > 2 ? 2 : figure
  if (f <= 1) {
    const [ax, ay] = epitrochoidPoint(rp, theta, driftT, bass)
    const [bx, by] = spirographPoint(rp, theta)
    return [ax + (bx - ax) * f, ay + (by - ay) * f]
  }
  const g = f - 1
  const [bx, by] = spirographPoint(rp, theta)
  const [cx, cy] = starRosePoint(rp, theta)
  return [bx + (cx - bx) * g, by + (cy - by) * g]
}

/** Per-frame quantities shared by every ring/sample this render(), bundled
 *  to keep the point/frame helpers' signatures manageable. */
interface RenderCtx {
  t: number
  figure: number
  evolve: number
  bass: number
  breatheFactor: number
  // Uniform enlargement of the whole manifestation (positions AND glyph size
  // scale together — see render()) so the mandala fills more of the screen
  // without losing its "chain of touching glyphs" density.
  zoom: number
  // A shared phase added to every ring's rotation so the glyph chains slide
  // ("traverse") along their curves at a knob-controlled rate, on top of each
  // ring's own steady `rotRate`. Pure `speed * TRAVEL_RATE * t` — deterministic.
  travelPhase: number
  ax: number
  ay: number
}

/** Raw (pre-aspect-correction) point for ring `idx` at arc-parameter `s`. */
function ringPoint(rp: RingParams, s: number, rotOffset: number, idx: number, ctx: RenderCtx): [number, number] {
  const rot = rp.rotRate * ctx.evolve * ctx.t + rotOffset + ctx.travelPhase
  const theta = s + rot
  const driftT = ctx.t * ctx.evolve
  const [rx, ry] = ringRawPoint(rp, theta, driftT, ctx.figure, ctx.bass)
  const scale = AMP_BASE * ringScaleFor(idx) * ctx.breatheFactor * ctx.zoom
  return [rx * scale, ry * scale]
}

/** Aspect-corrected point + on-screen tangent angle (for glyph rotation). */
function ringFrame(
  rp: RingParams,
  s: number,
  rotOffset: number,
  idx: number,
  ctx: RenderCtx,
): { x: number; y: number; angle: number } {
  const [x0, y0] = ringPoint(rp, s, rotOffset, idx, ctx)
  const [x1, y1] = ringPoint(rp, s + TANGENT_EPS, rotOffset, idx, ctx)
  const dx = (x1 - x0) * ctx.ax
  const dy = (y1 - y0) * ctx.ay
  const angle = dx === 0 && dy === 0 ? 0 : Math.atan2(dy, dx)
  return { x: x0 * ctx.ax, y: y0 * ctx.ay, angle }
}

/**
 * Nested-ring radius tier, purely a function of `idx` (never `rings`) so it
 * stays stable while the `rings` knob is scrubbed live — innermost ring
 * (idx 0) smallest, outermost (idx MAX_RINGS-1) at 1.0 (full glyphSize).
 * render() also uses this to scale each ring's glyph quads down by the same
 * factor as its radius: pitch (circumference/density) and glyph width then
 * shrink together, so every ring reads at the same "chain of touching
 * glyphs" density instead of inner rings collapsing into an overlapped
 * blob while the outer ring stays legible.
 */
function ringScaleFor(idx: number): number {
  return 0.4 + 0.6 * (idx / (MAX_RINGS - 1))
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

interface FadeLocs {
  uFade: WebGLUniformLocation | null
}
interface GlyphLocs {
  uAtlas: WebGLUniformLocation | null
}

export class GlyphGeometryScene implements SceneRuntime {
  meta = { id: 'glyphgeometry', name: 'Glyph Geometry', family: 'geometry' as const }

  params: ParamSchema[] = [
    { name: 'zoom', label: 'Zoom', min: 0.5, max: 2.5, default: 1 },
    { name: 'speed', label: 'Speed', min: 0, max: 6, default: 1 },
    { name: 'figure', label: 'Figure', min: 0, max: 2, default: 0.4 },
    { name: 'rings', label: 'Rings', min: 1, max: 8, default: 4, step: 1 },
    { name: 'density', label: 'Density', min: 20, max: 200, default: 90, step: 1 },
    { name: 'glyphSize', label: 'Glyph size', min: 0.012, max: 0.09, default: 0.035 },
    { name: 'evolve', label: 'Evolve', min: 0, max: 2, default: 0.7 },
    { name: 'breathe', label: 'Breathe', min: 0, max: 1, default: 0.4 },
    { name: 'trail', label: 'Trail', min: 0.7, max: 0.995, default: 0.9 },
    { name: 'hue', label: 'Hue', min: 0, max: 1, default: 0.62 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu
  private random: Prng = mulberry32(1)

  // CPU-only state (ARCHITECTURE.md §1): ring curve params + starting words +
  // starting rotation offsets generated once at init; `rotOffset` is the only
  // thing that changes after init, and only by a fixed jump on each onset
  // (see class doc) — never per-frame, never continuously.
  private ringParams: RingParams[] = []
  private ringWords: RingWord[] = []
  private rotOffset = new Float32Array(MAX_RINGS)
  private respawnCursor = 0

  private fadeProgram!: WebGLProgram
  private glyphProgram!: WebGLProgram
  private fadeLoc!: FadeLocs
  private glyphLoc!: GlyphLocs

  private fadeVao!: WebGLVertexArrayObject
  private fadeVbo!: WebGLBuffer
  private glyphVao!: WebGLVertexArrayObject
  private glyphVbo!: WebGLBuffer
  private atlasTexture!: WebGLTexture

  private glyphsCPU = new Float32Array(MAX_GLYPH_VERTS * GLYPH_FLOATS_PER_VERTEX)

  // Code layer (ARCHITECTURE.md §3.3): current source per editable stage, set
  // by field initializers (not inside init()) so a scene constructed without
  // a GL context can still report stock sources, and reset to stock every
  // init() so loadSession's dispose+init starts clean.
  private glyphSource = GLYPH_FS
  private fadeSource = FADE_FS

  init(gpu: Gpu, seed: number): void {
    this.gpu = gpu
    this.random = mulberry32(seed)
    for (const p of this.params) this.values.set(p.name, p.default)

    this.ringParams = []
    this.ringWords = []
    this.rotOffset = new Float32Array(MAX_RINGS)
    for (let i = 0; i < MAX_RINGS; i++) {
      this.ringParams.push(genRingParams(this.random))
      this.ringWords.push(genRingWord(this.random))
      this.rotOffset[i] = this.random() * TAU
    }
    this.respawnCursor = 0

    this.glyphSource = GLYPH_FS
    this.fadeSource = FADE_FS

    const gl = gpu.gl
    this.fadeProgram = gpu.compileProgram(FADE_VS, this.fadeSource)
    this.glyphProgram = gpu.compileProgram(GLYPH_VS, this.glyphSource)
    this.fadeLoc = this.lookupFadeLocs(this.fadeProgram)
    this.glyphLoc = this.lookupGlyphLocs(this.glyphProgram)

    // Fade quad (fullscreen triangle covering NDC).
    this.fadeVao = gl.createVertexArray()!
    this.fadeVbo = gl.createBuffer()!
    gl.bindVertexArray(this.fadeVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fadeVbo)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    // Glyph quads: dynamic buffer, rebuilt every render() (rings are
    // time-varying, so there's nothing to preserve between frames). Sized
    // for the worst case (MAX_RINGS x MAX_DENSITY glyphs) so no per-frame
    // allocation is ever needed.
    this.glyphVao = gl.createVertexArray()!
    this.glyphVbo = gl.createBuffer()!
    gl.bindVertexArray(this.glyphVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphVbo)
    gl.bufferData(gl.ARRAY_BUFFER, this.glyphsCPU.byteLength, gl.DYNAMIC_DRAW)
    const glyphStride = GLYPH_FLOATS_PER_VERTEX * 4
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, glyphStride, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, glyphStride, 2 * 4)
    gl.enableVertexAttribArray(2)
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, glyphStride, 4 * 4)
    gl.bindVertexArray(null)

    // Glyph atlas: shared bitmap font (src/scenes/families/geometry/glyphFont.ts)
    // — a single R8 texture built from a Uint8Array we fill ourselves (no
    // canvas fillText / system font — see class doc).
    this.atlasTexture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture)
    const prevAlign = gl.getParameter(gl.UNPACK_ALIGNMENT) as number
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, ATLAS_W, ATLAS_H, 0, gl.RED, gl.UNSIGNED_BYTE, buildAtlasData())
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, prevAlign)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindTexture(gl.TEXTURE_2D, null)

    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  setParam(name: string, value: number): void {
    this.values.set(name, value)
  }

  getParam(name: string): number {
    return this.values.get(name) ?? 0
  }

  /** Re-rolls one ring's word and kicks its rotation — a single deterministic
   *  slot advance (cycling through the MAX_RINGS pool so repeated onsets
   *  eventually touch every ring), never a per-frame draw. The kick is an
   *  offset JUMP, not a velocity change: the ring keeps spinning afterward at
   *  its own steady `rotRate`, just from a new phase — reads as a sudden
   *  jolt rather than a spin-up. */
  private reroll(): void {
    const idx = this.respawnCursor
    this.ringWords[idx] = genRingWord(this.random)
    const kickSign = this.random() < 0.5 ? -1 : 1
    const kickMag = 0.6 + this.random() * 0.9
    this.rotOffset[idx] += kickSign * kickMag
    this.respawnCursor = (this.respawnCursor + 1) % MAX_RINGS
  }

  update(ctx: FrameContext): void {
    if (ctx.signals.get('onset')) this.reroll()
  }

  render(ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()
    const t = ctx.frame.time
    const bass = ctx.signals.get('bass')
    const rms = ctx.signals.get('rms')

    const aspect = surface.width / surface.height
    const ax = 1 / Math.max(aspect, 1)
    const ay = Math.min(aspect, 1)

    const rings = clampInt(this.getParam('rings'), 1, MAX_RINGS)
    const density = clampInt(this.getParam('density'), 3, MAX_DENSITY)
    const figure = this.getParam('figure')
    const evolve = this.getParam('evolve')
    const breathe = this.getParam('breathe')
    const trail = this.getParam('trail')
    const hue = this.getParam('hue')
    const glyphSize = this.getParam('glyphSize')
    const zoom = this.getParam('zoom')
    const speed = this.getParam('speed')

    const renderCtx: RenderCtx = {
      t,
      figure,
      evolve,
      bass,
      breatheFactor: 1 + breathe * rms * 0.6, // rms gently breathes the overall radius
      zoom,
      travelPhase: speed * TRAVEL_RATE * t,
      ax,
      ay,
    }

    gl.enable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)

    // Fade pass: keep-factor knob -> alpha = 1 - keep.
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(this.fadeProgram)
    gl.uniform1f(this.fadeLoc.uFade, 1 - trail)
    gl.bindVertexArray(this.fadeVao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // --- The mandala: rings x density glyph quads, rotated to each ring's
    // local tangent. No line primitive is ever drawn — this pass is the
    // entire visible geometry. ---
    const halfWBase = ((glyphSize * GLYPH_SCALE) / 2) * zoom

    let cursor = 0
    for (let ring = 0; ring < rings; ring++) {
      const rp = this.ringParams[ring]
      const word = this.ringWords[ring].glyphs
      const rotOffset = this.rotOffset[ring]
      const h = (hue + ring * 0.09) % 1
      const light = 0.55 + 0.12 * Math.sin(ring * 1.7 + 1)
      const [r, g, b] = hsl(h, 0.75, light)
      // Glyph quads shrink with the same tier as the ring's radius (see
      // ringScaleFor's doc) so every ring reads at a consistent glyph
      // density instead of inner rings smearing into a blown-out blob.
      const halfW = halfWBase * ringScaleFor(ring)
      const halfH = (halfW * GLYPH_H) / GLYPH_W

      for (let i = 0; i < density; i++) {
        const s = (i / density) * TAU
        const frame = ringFrame(rp, s, rotOffset, ring, renderCtx)
        const cosA = Math.cos(frame.angle)
        const sinA = Math.sin(frame.angle)

        const gi = word[i % word.length] % NUM_GLYPHS
        const cellX = gi % ATLAS_COLS
        const cellY = Math.floor(gi / ATLAS_COLS)
        const u0 = (cellX * ATLAS_CELL) / ATLAS_W
        const u1 = (cellX * ATLAS_CELL + GLYPH_W) / ATLAS_W
        const v0 = (cellY * ATLAS_CELL) / ATLAS_H
        const v1 = (cellY * ATLAS_CELL + GLYPH_H) / ATLAS_H

        const rot = (dx: number, dy: number): [number, number] => [
          frame.x + dx * cosA - dy * sinA,
          frame.y + dx * sinA + dy * cosA,
        ]
        const [tlx, tly] = rot(-halfW, halfH)
        const [trx, try_] = rot(halfW, halfH)
        const [blx, bly] = rot(-halfW, -halfH)
        const [brx, bry] = rot(halfW, -halfH)

        const alpha = 0.92
        const push = (x: number, y: number, u: number, v: number): void => {
          this.glyphsCPU[cursor++] = x
          this.glyphsCPU[cursor++] = y
          this.glyphsCPU[cursor++] = u
          this.glyphsCPU[cursor++] = v
          this.glyphsCPU[cursor++] = r
          this.glyphsCPU[cursor++] = g
          this.glyphsCPU[cursor++] = b
          this.glyphsCPU[cursor++] = alpha
        }
        push(tlx, tly, u0, v0)
        push(blx, bly, u0, v1)
        push(trx, try_, u1, v0)
        push(trx, try_, u1, v0)
        push(blx, bly, u0, v1)
        push(brx, bry, u1, v1)
      }
    }
    const glyphVertCount = cursor / GLYPH_FLOATS_PER_VERTEX

    if (glyphVertCount > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphVbo)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.glyphsCPU, 0, cursor)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE) // additive: luminous ink instead of flat occlusion
      gl.useProgram(this.glyphProgram)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture)
      gl.uniform1i(this.glyphLoc.uAtlas, 0)
      gl.bindVertexArray(this.glyphVao)
      gl.drawArrays(gl.TRIANGLES, 0, glyphVertCount)
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
    gl.deleteProgram(this.glyphProgram)
    gl.deleteVertexArray(this.fadeVao)
    gl.deleteVertexArray(this.glyphVao)
    gl.deleteBuffer(this.fadeVbo)
    gl.deleteBuffer(this.glyphVbo)
    gl.deleteTexture(this.atlasTexture)
  }

  private lookupFadeLocs(program: WebGLProgram): FadeLocs {
    return { uFade: this.gpu.gl.getUniformLocation(program, 'uFade') }
  }

  private lookupGlyphLocs(program: WebGLProgram): GlyphLocs {
    return { uAtlas: this.gpu.gl.getUniformLocation(program, 'uAtlas') }
  }

  getShaderSources(): ShaderStage[] {
    return [
      { key: 'glyph-fs', label: 'Glyph ink (glyph-fs)', source: this.glyphSource },
      { key: 'fade-fs', label: 'Trail fade (fade-fs)', source: this.fadeSource },
    ]
  }

  setShaderSource(key: string, source: string): void {
    const gl = this.gpu.gl
    switch (key) {
      case 'glyph-fs': {
        const program = this.gpu.compileProgram(GLYPH_VS, source) // throws on GLSL error; old program untouched
        gl.deleteProgram(this.glyphProgram)
        this.glyphProgram = program
        this.glyphLoc = this.lookupGlyphLocs(program)
        this.glyphSource = source
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
