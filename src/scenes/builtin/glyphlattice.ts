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
 * Geometry family: "Glyph Lattice" — a diagram-style morphing lattice of
 * parametric curves (lissajous <-> rose/rhodonea <-> harmonograph, blended
 * continuously by `morph`) with Matrix-rain-style text strings flowing along
 * them, rendered from a deterministic baked 5x7 bitmap glyph atlas (no
 * canvas fillText / system fonts — cross-platform pixel determinism).
 *
 * PRNG discipline (resonance.ts's pattern): `random` is advanced ONLY at
 * init() — generating MAX_CURVES curve parameter sets and MAX_STRINGS text
 * strings up front — and on each `onset` pulse in update(), which re-rolls a
 * fixed-size batch of strings (new home curve, arc offset, glyph sequence).
 * It is never advanced per-frame, so replay is deterministic regardless of
 * frame rate. The `curves`/`strings` knobs only change how many of the
 * pre-generated MAX_CURVES/MAX_STRINGS slots are drawn each frame — they
 * never trigger regeneration, so scrubbing them live never touches the PRNG.
 *
 * Everything genuinely continuous (arc-position flow, curve phase drift,
 * amplitude/warp response to bass/rms) is plain maths over `ctx.frame.time`/
 * `frame.dt` — never randomness — so it can run in render() too (frozen
 * control ticks call render() without update(); reading stale `sPos` is
 * harmless, nothing is recomputed as "advance").
 *
 * Coordinate convention: rather than an `uAspect` vertex-shader uniform
 * (lissajous's approach), aspect correction happens on the CPU before
 * building any vertex buffer — every point already lives in final clip
 * space. That's required here because glyph quads are rotated to the
 * curve's tangent: rotating in aspect-corrected space keeps on-screen angles
 * true (uncorrected rotation would skew under a non-uniform x/y scale).
 */

// ---------------------------------------------------------------------------
// Fixed-vertex-shader pass-through: both line and glyph geometry arrive in
// already aspect-corrected clip space (see class doc), so neither VS does
// any transform work.
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
void main() {
  outColor = vColor;
}`

const FADE_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`

const FADE_FS = `#version 300 es
precision highp float;
uniform float uFade;
out vec4 outColor;
void main() { outColor = vec4(0.0, 0.0, 0.0, uFade); }`

// ---------------------------------------------------------------------------
// Curve geometry: three parametric families blended continuously by `morph`
// (0..2): lissajous [0,1] rose/rhodonea, rose [1,2] harmonograph.

const TAU = Math.PI * 2
const AMP_BASE = 0.82
const TANGENT_EPS = 0.01

interface CurveParams {
  a: number
  b: number
  phiA: number
  k: number
  kMul: number
  phiB: number
  h1: number
  h2: number
  h3: number
  h4: number
  phiC1: number
  phiC2: number
}

function genCurveParams(rng: Prng): CurveParams {
  return {
    a: 1 + Math.floor(rng() * 5),
    b: 1 + Math.floor(rng() * 5),
    phiA: rng() * TAU,
    k: 2 + Math.floor(rng() * 5),
    kMul: 1 + Math.floor(rng() * 3),
    phiB: rng() * TAU,
    h1: 1 + Math.floor(rng() * 4),
    h2: 1 + Math.floor(rng() * 4),
    h3: 1 + Math.floor(rng() * 4),
    h4: 1 + Math.floor(rng() * 4),
    phiC1: rng() * TAU,
    phiC2: rng() * TAU,
  }
}

/**
 * Raw (pre-aspect-correction) curve point at arc-parameter `s`, blended
 * across the three families by `morph`, with a time-driven phase drift, a
 * bass-driven amplitude (`ampMod`), and a `warp`-scaled swirl + layered-sine
 * "noise" displacement (deterministic — no PRNG — so it's safe to call from
 * render() every frame).
 */
function curvePoint(
  cp: CurveParams,
  s: number,
  t: number,
  morph: number,
  warp: number,
  ampMod: number,
  idx: number,
): [number, number] {
  const drift = t * 0.05 + idx * 0.017

  // Family A: lissajous.
  const axA = Math.sin(cp.a * s + cp.phiA + drift)
  const ayA = Math.sin(cp.b * s + cp.phiA * 0.6 + drift * 0.7)

  // Family B: rose / rhodonea (r = cos(k*theta), projected by a possibly
  // different integer angle multiplier for extra lattice variety).
  const rAngle = cp.k * s + cp.phiB + drift * 0.3
  const r = Math.cos(rAngle)
  const axB = r * Math.cos(cp.kMul * s)
  const ayB = r * Math.sin(cp.kMul * s)

  // Family C: harmonograph (undamped two-sine superposition per axis, all
  // integer frequencies so it stays exactly periodic over s in [0, TAU)).
  const axC = 0.6 * Math.sin(cp.h1 * s + cp.phiC1 + drift) + 0.4 * Math.sin(cp.h3 * s + cp.phiC2)
  const ayC = 0.6 * Math.cos(cp.h2 * s + cp.phiC1) + 0.4 * Math.cos(cp.h4 * s + cp.phiC2 + drift)

  const m = morph < 0 ? 0 : morph > 2 ? 2 : morph
  let bx: number
  let by: number
  if (m <= 1) {
    bx = axA + (axB - axA) * m
    by = ayA + (ayB - ayA) * m
  } else {
    const f = m - 1
    bx = axB + (axC - axB) * f
    by = ayB + (ayC - ayB) * f
  }

  const radius = Math.hypot(bx, by)
  const swirl = warp * 0.6 * Math.sin(radius * 2.5 - t * 0.25 + idx * 0.6)
  const cosw = Math.cos(swirl)
  const sinw = Math.sin(swirl)
  const nx = warp * 0.12 * Math.sin(bx * 2.3 + t * 0.37 + idx) * Math.cos(by * 1.7 - t * 0.29)
  const ny = warp * 0.12 * Math.cos(bx * 1.9 - t * 0.31) * Math.sin(by * 2.1 + t * 0.24 + idx)
  const wx = bx * cosw - by * sinw + nx
  const wy = bx * sinw + by * cosw + ny

  // Nested-layer radius scale, purely a function of `idx` (never `curveCount`)
  // so it stays stable while the `curves` knob is scrubbed live: without it,
  // MAX_CURVES same-size overlapping curves read as a tangled scribble
  // rather than a "lattice" — cycling through 4 radius tiers gives the
  // lattice visible nested structure at any curve count.
  const radiusScale = 0.55 + 0.45 * ((idx % 4) / 3)
  const scale = AMP_BASE * ampMod * radiusScale
  return [wx * scale, wy * scale]
}

/** Aspect-corrected point (final clip-space xy — see class doc). */
function curvePointCorrected(
  cp: CurveParams,
  s: number,
  t: number,
  morph: number,
  warp: number,
  ampMod: number,
  idx: number,
  ax: number,
  ay: number,
): [number, number] {
  const [x, y] = curvePoint(cp, s, t, morph, warp, ampMod, idx)
  return [x * ax, y * ay]
}

/** Aspect-corrected point + on-screen tangent angle (for glyph rotation). */
function curveFrame(
  cp: CurveParams,
  s: number,
  t: number,
  morph: number,
  warp: number,
  ampMod: number,
  idx: number,
  ax: number,
  ay: number,
): { x: number; y: number; angle: number } {
  const [x0, y0] = curvePoint(cp, s, t, morph, warp, ampMod, idx)
  const [x1, y1] = curvePoint(cp, s + TANGENT_EPS, t, morph, warp, ampMod, idx)
  const dx = (x1 - x0) * ax
  const dy = (y1 - y0) * ay
  const angle = dx === 0 && dy === 0 ? 0 : Math.atan2(dy, dx)
  return { x: x0 * ax, y: y0 * ay, angle }
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

// ---------------------------------------------------------------------------
// Text strings: a fixed pool of MAX_STRINGS slots, each bound to one of
// MAX_CURVES curves and carrying its own glyph sequence + flow-speed
// multiplier. `curves`/`strings` params only change how many pool slots are
// drawn (`curveRaw % activeCurveCount`, first M slots) — never regenerated.

const MAX_CURVES = 16
const MAX_STRINGS = 32
const MIN_GLYPHS_PER_STRING = 4
const MAX_GLYPHS_PER_STRING = 12
const RESPAWN_BATCH = 3
const GLYPH_SPACING = 0.16 // arc-length (s-radians) gap between trailing glyphs
const TRAIL_FALLOFF = 0.72
const MIN_ALPHA = 0.035
const GLYPH_SCALE = 2.5 // maps the glyphSize knob to a legible on-screen size
const POINTS_PER_CURVE = 128
const LINK_STEP = 16

interface StringSlot {
  curveRaw: number
  speedMul: number
  glyphs: number[]
}

function genStringSlot(rng: Prng): StringSlot {
  const curveRaw = Math.floor(rng() * MAX_CURVES)
  const speedMul = 0.7 + rng() * 0.6
  const len = MIN_GLYPHS_PER_STRING + Math.floor(rng() * (MAX_GLYPHS_PER_STRING - MIN_GLYPHS_PER_STRING + 1))
  const glyphs: number[] = new Array(len)
  for (let g = 0; g < len; g++) glyphs[g] = Math.floor(rng() * NUM_GLYPHS)
  return { curveRaw, speedMul, glyphs }
}

// Vertex layouts (floats/vertex): lines = pos.xy + color.rgba; glyphs =
// pos.xy + uv.xy + color.rgba.
const LINE_FLOATS_PER_VERTEX = 6
const GLYPH_FLOATS_PER_VERTEX = 8
const LINKS_PER_CURVE = Math.floor(POINTS_PER_CURVE / LINK_STEP)
const MAX_LINE_VERTS = MAX_CURVES * POINTS_PER_CURVE + MAX_CURVES * LINKS_PER_CURVE * 2
const MAX_GLYPH_VERTS = MAX_STRINGS * MAX_GLYPHS_PER_STRING * 6

interface LineLocs {
  uFade: WebGLUniformLocation | null
}
interface GlyphLocs {
  uAtlas: WebGLUniformLocation | null
}

export class GlyphLatticeScene implements SceneRuntime {
  meta = { id: 'glyphlattice', name: 'Glyph Lattice', family: 'geometry' as const }

  params: ParamSchema[] = [
    { name: 'curves', label: 'Curves', min: 3, max: 16, default: 8, step: 1 },
    { name: 'morph', label: 'Morph', min: 0, max: 2, default: 0.3 },
    { name: 'flowSpeed', label: 'Flow speed', min: 0, max: 3, default: 1 },
    { name: 'strings', label: 'Strings', min: 0, max: 32, default: 14, step: 1 },
    { name: 'glyphSize', label: 'Glyph size', min: 0.01, max: 0.08, default: 0.03 },
    { name: 'warp', label: 'Warp', min: 0, max: 1, default: 0.15 },
    { name: 'trail', label: 'Trail', min: 0.7, max: 0.995, default: 0.92 },
    { name: 'hue', label: 'Hue', min: 0, max: 1, default: 0.35 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu
  private random: Prng = mulberry32(1)

  // CPU-only state (ARCHITECTURE.md §1): generated once at init (curve
  // params, all string slots) plus the per-string arc-position accumulator
  // (advanced continuously in update(), never randomly) and a respawn
  // cursor (advanced by a fixed count on each onset — see class doc).
  private curveParams: CurveParams[] = []
  private stringSlots: StringSlot[] = []
  private sPos = new Float32Array(MAX_STRINGS)
  private respawnCursor = 0

  private fadeProgram!: WebGLProgram
  private lineProgram!: WebGLProgram
  private glyphProgram!: WebGLProgram
  private fadeLoc!: LineLocs
  private glyphLoc!: GlyphLocs

  private fadeVao!: WebGLVertexArrayObject
  private lineVao!: WebGLVertexArrayObject
  private lineVbo!: WebGLBuffer
  private glyphVao!: WebGLVertexArrayObject
  private glyphVbo!: WebGLBuffer
  private atlasTexture!: WebGLTexture

  private linesCPU = new Float32Array(MAX_LINE_VERTS * LINE_FLOATS_PER_VERTEX)
  private glyphsCPU = new Float32Array(MAX_GLYPH_VERTS * GLYPH_FLOATS_PER_VERTEX)

  // Code layer (ARCHITECTURE.md §3.3): current source per editable stage,
  // set by field initializers (not inside init()) so a scene constructed
  // without a GL context can still report stock sources, and reset to stock
  // every init() so loadSession's dispose+init starts clean.
  private lineSource = LINE_FS
  private glyphSource = GLYPH_FS

  init(gpu: Gpu, seed: number): void {
    this.gpu = gpu
    this.random = mulberry32(seed)
    for (const p of this.params) this.values.set(p.name, p.default)

    this.curveParams = []
    for (let i = 0; i < MAX_CURVES; i++) this.curveParams.push(genCurveParams(this.random))

    this.stringSlots = []
    this.sPos = new Float32Array(MAX_STRINGS)
    for (let i = 0; i < MAX_STRINGS; i++) {
      const slot = genStringSlot(this.random)
      this.stringSlots.push(slot)
      this.sPos[i] = this.random() * TAU
    }
    this.respawnCursor = 0

    this.lineSource = LINE_FS
    this.glyphSource = GLYPH_FS

    const gl = gpu.gl
    this.fadeProgram = gpu.compileProgram(FADE_VS, FADE_FS)
    this.lineProgram = gpu.compileProgram(LINE_VS, this.lineSource)
    this.glyphProgram = gpu.compileProgram(GLYPH_VS, this.glyphSource)
    this.fadeLoc = this.lookupFadeLocs(this.fadeProgram)
    this.glyphLoc = this.lookupGlyphLocs(this.glyphProgram)

    // Fade quad (fullscreen triangle covering NDC).
    this.fadeVao = gl.createVertexArray()!
    const fadeVbo = gl.createBuffer()!
    gl.bindVertexArray(this.fadeVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, fadeVbo)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    // Line geometry: dynamic buffer, rebuilt every render() (curves are
    // time-varying, so there's nothing to preserve between frames).
    this.lineVao = gl.createVertexArray()!
    this.lineVbo = gl.createBuffer()!
    gl.bindVertexArray(this.lineVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo)
    gl.bufferData(gl.ARRAY_BUFFER, this.linesCPU.byteLength, gl.DYNAMIC_DRAW)
    const lineStride = LINE_FLOATS_PER_VERTEX * 4
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, lineStride, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, lineStride, 2 * 4)

    // Glyph quads: dynamic buffer, same reasoning.
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

    // Glyph atlas: a single R8 texture built from a Uint8Array we fill
    // ourselves (no canvas fillText / system font — see class doc).
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

  /** Re-rolls `count` pool slots (new home curve, arc offset, speed, glyphs) —
   * a fixed batch, deterministic from `this.random`, cycling through the
   * MAX_STRINGS pool so repeated onsets eventually touch every slot. */
  private respawn(count: number): void {
    for (let c = 0; c < count; c++) {
      const idx = (this.respawnCursor + c) % MAX_STRINGS
      this.stringSlots[idx] = genStringSlot(this.random)
      this.sPos[idx] = this.random() * TAU
    }
    this.respawnCursor = (this.respawnCursor + count) % MAX_STRINGS
  }

  update(ctx: FrameContext): void {
    const { frame, signals } = ctx
    const rms = signals.get('rms')
    const flow = this.getParam('flowSpeed')
    const advance = flow * (1 + rms * 1.4) * frame.dt
    for (let i = 0; i < MAX_STRINGS; i++) {
      this.sPos[i] += advance * this.stringSlots[i].speedMul
    }
    if (signals.get('onset')) this.respawn(RESPAWN_BATCH)
  }

  render(ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()
    const t = ctx.frame.time
    const bass = ctx.signals.get('bass')
    const ampMod = 0.75 + 0.5 * Math.min(1, bass * 1.3)

    const aspect = surface.width / surface.height
    const ax = 1 / Math.max(aspect, 1)
    const ay = Math.min(aspect, 1)

    const curveCount = clampInt(this.getParam('curves'), 3, MAX_CURVES)
    const morph = this.getParam('morph')
    const warp = this.getParam('warp')
    const hue = this.getParam('hue')
    const trail = this.getParam('trail')

    gl.enable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)

    // Fade pass: keep-factor knob -> alpha = 1 - keep.
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(this.fadeProgram)
    gl.uniform1f(this.fadeLoc.uFade, 1 - trail)
    gl.bindVertexArray(this.fadeVao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // --- Lattice lines: curveCount closed polylines + dimmer cross-links ---
    let cursor = 0
    for (let c = 0; c < curveCount; c++) {
      const cp = this.curveParams[c]
      const h = (hue + c * 0.015) % 1
      const light = 0.4 + 0.06 * Math.sin(c * 1.7 + 1)
      const [r, g, b] = hsl(h, 0.7, light)
      for (let i = 0; i < POINTS_PER_CURVE; i++) {
        const s = (i / POINTS_PER_CURVE) * TAU
        const [x, y] = curvePointCorrected(cp, s, t, morph, warp, ampMod, c, ax, ay)
        this.linesCPU[cursor++] = x
        this.linesCPU[cursor++] = y
        this.linesCPU[cursor++] = r
        this.linesCPU[cursor++] = g
        this.linesCPU[cursor++] = b
        this.linesCPU[cursor++] = 0.85
      }
    }
    const curveVertCount = curveCount * POINTS_PER_CURVE

    let linkVertCount = 0
    for (let c = 0; c < curveCount; c++) {
      const other = (c + 1) % curveCount
      const cp1 = this.curveParams[c]
      const cp2 = this.curveParams[other]
      const h = (hue + c * 0.015) % 1
      const [r, g, b] = hsl(h, 0.5, 0.22)
      for (let i = 0; i < POINTS_PER_CURVE; i += LINK_STEP) {
        const s = (i / POINTS_PER_CURVE) * TAU
        const [x1, y1] = curvePointCorrected(cp1, s, t, morph, warp, ampMod, c, ax, ay)
        const [x2, y2] = curvePointCorrected(cp2, s, t, morph, warp, ampMod, other, ax, ay)
        this.linesCPU[cursor++] = x1
        this.linesCPU[cursor++] = y1
        this.linesCPU[cursor++] = r
        this.linesCPU[cursor++] = g
        this.linesCPU[cursor++] = b
        this.linesCPU[cursor++] = 0.32
        this.linesCPU[cursor++] = x2
        this.linesCPU[cursor++] = y2
        this.linesCPU[cursor++] = r
        this.linesCPU[cursor++] = g
        this.linesCPU[cursor++] = b
        this.linesCPU[cursor++] = 0.32
        linkVertCount += 2
      }
    }

    gl.bindVertexArray(this.lineVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.linesCPU, 0, cursor)
    gl.useProgram(this.lineProgram)
    for (let c = 0; c < curveCount; c++) {
      gl.drawArrays(gl.LINE_LOOP, c * POINTS_PER_CURVE, POINTS_PER_CURVE)
    }
    if (linkVertCount > 0) gl.drawArrays(gl.LINES, curveVertCount, linkVertCount)

    // --- Matrix-rain text: glyph quads rotated to each curve's local tangent ---
    const stringCount = clampInt(this.getParam('strings'), 0, MAX_STRINGS)
    const glyphSize = this.getParam('glyphSize')
    const halfW = (glyphSize * GLYPH_SCALE) / 2
    const halfH = (halfW * GLYPH_H) / GLYPH_W

    let gCursor = 0
    for (let si = 0; si < stringCount; si++) {
      const slot = this.stringSlots[si]
      const curveIdx = slot.curveRaw % curveCount
      const cp = this.curveParams[curveIdx]
      const sBase = this.sPos[si]
      const glyphs = slot.glyphs

      for (let g = 0; g < glyphs.length; g++) {
        const alpha = Math.pow(TRAIL_FALLOFF, g)
        if (alpha < MIN_ALPHA) break

        const sVal = sBase - g * GLYPH_SPACING
        const frame = curveFrame(cp, sVal, t, morph, warp, ampMod, curveIdx, ax, ay)
        const cosA = Math.cos(frame.angle)
        const sinA = Math.sin(frame.angle)

        let r: number
        let gg: number
        let b: number
        if (g === 0) {
          const [hr, hg, hb] = hsl(hue, 0.55, 0.72)
          r = hr + (1 - hr) * 0.55
          gg = hg + (1 - hg) * 0.55
          b = hb + (1 - hb) * 0.55
        } else {
          ;[r, gg, b] = hsl(hue, 0.85, 0.5)
        }

        const gi = glyphs[g] % NUM_GLYPHS
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

        const push = (x: number, y: number, u: number, v: number): void => {
          this.glyphsCPU[gCursor++] = x
          this.glyphsCPU[gCursor++] = y
          this.glyphsCPU[gCursor++] = u
          this.glyphsCPU[gCursor++] = v
          this.glyphsCPU[gCursor++] = r
          this.glyphsCPU[gCursor++] = gg
          this.glyphsCPU[gCursor++] = b
          this.glyphsCPU[gCursor++] = alpha
        }
        push(tlx, tly, u0, v0)
        push(blx, bly, u0, v1)
        push(trx, try_, u1, v0)
        push(trx, try_, u1, v0)
        push(blx, bly, u0, v1)
        push(brx, bry, u1, v1)
      }
    }
    const glyphVertCount = gCursor / GLYPH_FLOATS_PER_VERTEX

    if (glyphVertCount > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphVbo)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.glyphsCPU, 0, gCursor)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE) // additive: glow instead of occlusion
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
    gl.deleteProgram(this.lineProgram)
    gl.deleteProgram(this.glyphProgram)
    gl.deleteVertexArray(this.fadeVao)
    gl.deleteVertexArray(this.lineVao)
    gl.deleteVertexArray(this.glyphVao)
    gl.deleteBuffer(this.lineVbo)
    gl.deleteBuffer(this.glyphVbo)
    gl.deleteTexture(this.atlasTexture)
  }

  private lookupFadeLocs(program: WebGLProgram): LineLocs {
    return { uFade: this.gpu.gl.getUniformLocation(program, 'uFade') }
  }

  private lookupGlyphLocs(program: WebGLProgram): GlyphLocs {
    return { uAtlas: this.gpu.gl.getUniformLocation(program, 'uAtlas') }
  }

  getShaderSources(): ShaderStage[] {
    return [
      { key: 'line-fs', label: 'Lattice lines (line-fs)', source: this.lineSource },
      { key: 'glyph-fs', label: 'Glyph rain (glyph-fs)', source: this.glyphSource },
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
      case 'glyph-fs': {
        const program = this.gpu.compileProgram(GLYPH_VS, source)
        gl.deleteProgram(this.glyphProgram)
        this.glyphProgram = program
        this.glyphLoc = this.lookupGlyphLocs(program)
        this.glyphSource = source
        return
      }
      default:
        throw new Error(`Unknown shader stage "${key}" for scene "${this.meta.id}"`)
    }
  }
}
