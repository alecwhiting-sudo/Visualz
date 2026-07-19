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
 * Geometry family: "Glyph Rain" — the classic Matrix-movie digital rain,
 * built deliberately RECTILINEAR (per the product brief: "more like the
 * matrix movie, where the lines are more straight rather than a tangled ball
 * of wool") in contrast to glyphlattice.ts's curved/tangled lattice. Two
 * straight-line populations share one glyph atlas:
 *
 *  1. Rain columns: a grid of vertical streamers (bright head + dimming
 *     tail) falling straight down an exact column/row grid — no rotation,
 *     no horizontal drift.
 *  2. Circuit traces: axis-aligned polylines (90° turns only, generated once
 *     at init) along which a second population of glyph streamers travels,
 *     glyph orientation snapping to 0°/90° at each turn — never an
 *     arbitrary angle. These read as data flowing through a circuit board.
 *
 * Architecture borrowed from glyphlattice.ts: fade pass (keep-factor trail)
 * then glyph pass, CPU-built batched glyph quads sampling the shared 5x7
 * bitmap atlas, stock shader sources as instance-field initializers. Unlike
 * glyphlattice, geometry here needs no "aspect-corrected logical square" —
 * the rain grid and the circuit-trace grid both live directly in full clip
 * space ([-1,1] on both axes) since nothing here should be confined to a
 * centered square; only individual glyph quads need a per-axis pixel-size
 * correction so a 5x7 character isn't stretched by a non-square canvas (see
 * `glyphCorners` below, which rotates in true pixel space before converting
 * back to NDC — the only way a 90°-snapped glyph stays unskewed under a
 * non-uniform NDC-to-pixel scale).
 *
 * PRNG discipline (resonance.ts's pattern): `random` is advanced ONLY at
 * init() — column speed/brightness tiers (MAX_COLUMNS slots), all circuit
 * paths (MAX_PATHS, with their fixed polyline geometry) and their streamer
 * pools (MAX_PATHS * MAX_STREAMERS_PER_PATH slots) — and on each `onset`
 * pulse in update(), which draws a FIXED number of values (one restart
 * offset per respawned column, plus one path pick for the flash). It is
 * never advanced per-frame. `columns`/`paths`/`tailLength` only change how
 * much of the pre-generated pool is drawn/looped over each frame — never
 * trigger regeneration, so scrubbing them live never touches the PRNG.
 *
 * Tail-glyph "mutation" is explicitly NOT randomness: a tail character's
 * glyph index is `hashGlyph(col, row, floor(time * mutateRate))` — a pure
 * integer hash (murmur-style finalizer, no held state) of the grid cell and
 * a time-quantized epoch. Same inputs always produce the same glyph, so it's
 * safe to call from render() every frame (including frozen-control replays
 * that never call update()) and replays byte-identically regardless of
 * frame rate.
 */

// ---------------------------------------------------------------------------
// Code-layer editable stages (task brief: 'glyph-fs' + 'fade-fs'). The
// circuit-trace wire lines use their own small fixed program — not exposed
// for editing, same as glyphlattice's FADE_VS/FADE_FS pass-through wrapper.
const FADE_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`

const FADE_FS = `#version 300 es
precision highp float;
uniform float uFade;
out vec4 outColor;
void main() { outColor = vec4(0.0, 0.0, 0.0, uFade); }`

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

// ---------------------------------------------------------------------------
// Tuning constants (design constants, not user params — the 8 knobs are the
// only user-facing surface per spec).
const MAX_COLUMNS = 128
const MAX_TAIL = 30 // matches tailLength's param max
const MIN_ROWS = 10
const MAX_ROWS = 60 // matches columns' param max (row count == columns param)
const MIN_COLUMNS_CLAMP = 6

const MAX_PATHS = 8 // matches paths' param max
const PATH_GRID = 8 // abstract NDC grid resolution circuit traces snap to
const MAX_PATH_POINTS = 9 // supports up to 8 segments per path
const MIN_PATH_SEGMENTS = 4
const MAX_PATH_SEGMENTS = MAX_PATH_POINTS - 1
const MAX_STREAMERS_PER_PATH = 5
const PATH_TAIL = 7 // fixed trailing-glyph count for circuit streamers
const PATH_STREAMER_GLYPHS = 8 // fixed glyph-sequence length per streamer

const RAIN_RESPAWN_BATCH = 4
const BASE_FALL_ROWS_PER_SEC = 9
const PATH_SPEED_UNITS_PER_SEC = 0.5
const FLASH_DECAY_PER_SEC = 1.6
const MIN_ROW_ALPHA = 0.045
const MIN_PATH_ALPHA = 0.05

// Vertex layouts (floats/vertex).
const LINE_FLOATS_PER_VERTEX = 6 // pos.xy + color.rgba
const GLYPH_FLOATS_PER_VERTEX = 8 // pos.xy + uv.xy + color.rgba
const MAX_LINE_VERTS = MAX_PATHS * (MAX_PATH_POINTS - 1) * 2
const MAX_RAIN_GLYPHS = MAX_COLUMNS * MAX_TAIL
const MAX_PATH_GLYPHS = MAX_PATHS * MAX_STREAMERS_PER_PATH * PATH_TAIL
const MAX_GLYPH_VERTS = (MAX_RAIN_GLYPHS + MAX_PATH_GLYPHS) * 6

function clampInt(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(v)))
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h * 12) % 12
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return [f(0), f(8), f(4)]
}

/**
 * Pure integer hash (murmur3-style finalizer over three ints combined with
 * distinct odd multipliers) — deterministic, stateless, no PRNG stream
 * consumed. Drives tail-glyph "mutation": same (col,row,epoch) always yields
 * the same result, so it's safe to call from render() every frame.
 */
function hashGlyphIndex(col: number, row: number, epoch: number): number {
  let h = (col * 374761393 + row * 668265263 + epoch * 2246822519) | 0
  h = Math.imul(h ^ (h >>> 15), 2246822519)
  h = Math.imul(h ^ (h >>> 13), 3266489917)
  h ^= h >>> 16
  const u = (h >>> 0) / 4294967296
  return Math.floor(u * NUM_GLYPHS) % NUM_GLYPHS
}

interface PathData {
  points: Float32Array // flattened xy, length MAX_PATH_POINTS*2, direct NDC space
  pointCount: number
  cumLen: Float32Array // cumulative arc length up to each point, length pointCount
  totalLen: number
}

/** Random-walk axis-aligned polyline on the PATH_GRID lattice, 90°-turn-only. */
function genPath(rng: Prng): PathData {
  const step = 2 / PATH_GRID
  const points = new Float32Array(MAX_PATH_POINTS * 2)
  let x = clampGrid(-1 + Math.floor(rng() * (PATH_GRID + 1)) * step)
  let y = clampGrid(-1 + Math.floor(rng() * (PATH_GRID + 1)) * step)
  points[0] = x
  points[1] = y
  let count = 1
  let horizontal = rng() < 0.5
  const segCount = MIN_PATH_SEGMENTS + Math.floor(rng() * (MAX_PATH_SEGMENTS - MIN_PATH_SEGMENTS + 1))
  for (let s = 0; s < segCount && count < MAX_PATH_POINTS; s++) {
    const len = (1 + Math.floor(rng() * 3)) * step
    const sign = rng() < 0.5 ? -1 : 1
    if (horizontal) x = clampGrid(x + sign * len)
    else y = clampGrid(y + sign * len)
    points[count * 2] = x
    points[count * 2 + 1] = y
    count++
    horizontal = !horizontal
  }
  const cumLen = new Float32Array(count)
  let total = 0
  for (let i = 1; i < count; i++) {
    const dx = points[i * 2] - points[(i - 1) * 2]
    const dy = points[i * 2 + 1] - points[(i - 1) * 2 + 1]
    total += Math.hypot(dx, dy)
    cumLen[i] = total
  }
  return { points, pointCount: count, cumLen, totalLen: total > 1e-4 ? total : 1e-4 }
}

function clampGrid(v: number): number {
  return Math.min(1, Math.max(-1, v))
}

interface PathSample {
  x: number
  y: number
  horizontal: boolean
}

/** Position + segment orientation at arc-length `s` (mod total), for glyph placement. */
function samplePath(path: PathData, s: number): PathSample {
  const total = path.totalLen
  let t = s % total
  if (t < 0) t += total
  let i = 1
  while (i < path.pointCount - 1 && path.cumLen[i] < t) i++
  const segStart = path.cumLen[i - 1]
  const segEnd = path.cumLen[i]
  const segLen = segEnd - segStart
  const localT = segLen > 1e-6 ? (t - segStart) / segLen : 0
  const x0 = path.points[(i - 1) * 2]
  const y0 = path.points[(i - 1) * 2 + 1]
  const x1 = path.points[i * 2]
  const y1 = path.points[i * 2 + 1]
  const horizontal = Math.abs(x1 - x0) >= Math.abs(y1 - y0)
  return { x: x0 + (x1 - x0) * localT, y: y0 + (y1 - y0) * localT, horizontal }
}

interface PathStreamer {
  pathIdx: number
  speedMul: number
  glyphs: number[]
}

function genPathStreamer(rng: Prng, pathIdx: number): PathStreamer {
  const speedMul = 0.7 + rng() * 0.7
  const glyphs: number[] = new Array(PATH_STREAMER_GLYPHS)
  for (let g = 0; g < PATH_STREAMER_GLYPHS; g++) glyphs[g] = Math.floor(rng() * NUM_GLYPHS)
  return { pathIdx, speedMul, glyphs }
}

interface FadeLocs {
  uFade: WebGLUniformLocation | null
}
interface GlyphLocs {
  uAtlas: WebGLUniformLocation | null
}

export class GlyphRainScene implements SceneRuntime {
  meta = { id: 'glyphrain', name: 'Glyph Rain', family: 'geometry' as const }

  params: ParamSchema[] = [
    { name: 'columns', label: 'Columns', min: 10, max: 60, default: 28, step: 1 },
    { name: 'fallSpeed', label: 'Fall speed', min: 0.2, max: 3, default: 1 },
    { name: 'tailLength', label: 'Tail length', min: 3, max: 30, default: 14, step: 1 },
    { name: 'paths', label: 'Circuit paths', min: 0, max: 8, default: 3, step: 1 },
    { name: 'glyphSize', label: 'Glyph scale', min: 0.5, max: 2, default: 1 },
    { name: 'mutateRate', label: 'Mutate rate', min: 0, max: 8, default: 2.5 },
    { name: 'trail', label: 'Trail', min: 0.7, max: 0.995, default: 0.88 },
    { name: 'hue', label: 'Hue', min: 0, max: 1, default: 0.34 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu
  private random: Prng = mulberry32(1)

  // CPU-only state (ARCHITECTURE.md §1): generated once at init (column
  // tiers, all circuit paths + their streamer pools) plus continuous
  // dt-advanced accumulators (never randomly) and the onset respawn/flash
  // state (advanced by a fixed count on each onset — see class doc).
  private colSpeedMul = new Float32Array(MAX_COLUMNS)
  private colBrightTier = new Float32Array(MAX_COLUMNS)
  private headRow = new Float64Array(MAX_COLUMNS) // unbounded "rows fallen" accumulator
  private respawnCursor = 0

  private paths: PathData[] = []
  private streamers: PathStreamer[] = []
  private arcPos = new Float64Array(MAX_PATHS * MAX_STREAMERS_PER_PATH)
  private flashPathIndex = -1
  private flashLevel = 0

  private fadeProgram!: WebGLProgram
  private lineProgram!: WebGLProgram
  private glyphProgram!: WebGLProgram
  private fadeLoc!: FadeLocs
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
  private glyphSource = GLYPH_FS
  private fadeSource = FADE_FS

  init(gpu: Gpu, seed: number): void {
    this.gpu = gpu
    this.random = mulberry32(seed)
    for (const p of this.params) this.values.set(p.name, p.default)

    for (let c = 0; c < MAX_COLUMNS; c++) {
      this.colSpeedMul[c] = 0.6 + this.random() * 0.8
      this.colBrightTier[c] = 0.7 + this.random() * 0.6
      this.headRow[c] = this.random() * 40
    }
    this.respawnCursor = 0

    this.paths = []
    for (let p = 0; p < MAX_PATHS; p++) this.paths.push(genPath(this.random))

    this.streamers = []
    this.arcPos = new Float64Array(MAX_PATHS * MAX_STREAMERS_PER_PATH)
    let si = 0
    for (let p = 0; p < MAX_PATHS; p++) {
      for (let k = 0; k < MAX_STREAMERS_PER_PATH; k++) {
        this.streamers.push(genPathStreamer(this.random, p))
        this.arcPos[si] = this.random() * this.paths[p].totalLen
        si++
      }
    }
    this.flashPathIndex = -1
    this.flashLevel = 0

    this.glyphSource = GLYPH_FS
    this.fadeSource = FADE_FS

    const gl = gpu.gl
    this.fadeProgram = gpu.compileProgram(FADE_VS, this.fadeSource)
    this.lineProgram = gpu.compileProgram(LINE_VS, LINE_FS)
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

    // Circuit-trace wire lines: dynamic buffer, rebuilt every render() (the
    // flash brightness is time-varying).
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

    // Glyph quads (rain + circuit streamers share one batch): dynamic
    // buffer, rebuilt every render() (positions are time-varying).
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
    // ourselves (no canvas fillText / system font — cross-platform
    // determinism, see glyphFont.ts).
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

  /** Fixed-size respawn batch (deterministic from `this.random`), cycling
   *  through the MAX_COLUMNS pool so repeated onsets eventually touch every
   *  column — same discipline as glyphlattice's respawn(). */
  private respawnColumns(count: number): void {
    for (let c = 0; c < count; c++) {
      const idx = (this.respawnCursor + c) % MAX_COLUMNS
      this.headRow[idx] = this.random() * 40
    }
    this.respawnCursor = (this.respawnCursor + count) % MAX_COLUMNS
  }

  update(ctx: FrameContext): void {
    const { frame, signals } = ctx
    const rms = signals.get('rms')
    const fallSpeed = this.getParam('fallSpeed')

    const rowAdvance = fallSpeed * BASE_FALL_ROWS_PER_SEC * (1 + rms * 0.5) * frame.dt
    for (let c = 0; c < MAX_COLUMNS; c++) {
      this.headRow[c] += rowAdvance * this.colSpeedMul[c]
    }

    const arcAdvance = fallSpeed * PATH_SPEED_UNITS_PER_SEC * (1 + rms * 0.5) * frame.dt
    for (let i = 0; i < this.streamers.length; i++) {
      this.arcPos[i] += arcAdvance * this.streamers[i].speedMul
    }

    this.flashLevel = Math.max(0, this.flashLevel - frame.dt * FLASH_DECAY_PER_SEC)

    if (signals.get('onset')) {
      this.respawnColumns(RAIN_RESPAWN_BATCH)
      this.flashPathIndex = Math.floor(this.random() * MAX_PATHS)
      this.flashLevel = 1
    }
  }

  render(ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()
    const t = ctx.frame.time
    const bass = ctx.signals.get('bass')

    const aspect = surface.width / surface.height
    const invHalfWpx = 2 / surface.width
    const invHalfHpx = 2 / surface.height

    const columnsParam = this.getParam('columns')
    const numColumns = clampInt(Math.round(columnsParam * aspect), MIN_COLUMNS_CLAMP, MAX_COLUMNS)
    const numRows = clampInt(columnsParam, MIN_ROWS, MAX_ROWS)
    const tailLength = clampInt(this.getParam('tailLength'), 1, MAX_TAIL)
    const pathCount = clampInt(this.getParam('paths'), 0, MAX_PATHS)
    const glyphSizeParam = this.getParam('glyphSize')
    const mutateRate = Math.max(0, this.getParam('mutateRate'))
    const trail = this.getParam('trail')
    const hue = this.getParam('hue')

    const pitchX = 2 / numColumns
    const pitchY = 2 / numRows
    const period = numRows + tailLength

    // Base glyph pixel half-extents, auto-derived from the column pitch so
    // the character grid always reads legibly regardless of aspect/column
    // count, then scaled by the glyphSize knob.
    const pitchXpx = surface.width / numColumns
    const pw = pitchXpx * 0.4 * glyphSizeParam
    const ph = pw * (GLYPH_H / GLYPH_W)

    gl.enable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)

    // Fade pass: keep-factor knob -> alpha = 1 - keep.
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(this.fadeProgram)
    gl.uniform1f(this.fadeLoc.uFade, 1 - trail)
    gl.bindVertexArray(this.fadeVao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // --- Circuit-trace wire lines (dim, brightened by an onset flash) ---
    let lCursor = 0
    let lineVertCount = 0
    for (let p = 0; p < pathCount; p++) {
      const path = this.paths[p]
      const h = (hue + 0.5 + p * 0.05) % 1
      const flashBoost = p === this.flashPathIndex ? this.flashLevel : 0
      const [r, g, b] = hsl(h, 0.6, 0.22 + 0.45 * flashBoost)
      const alpha = 0.35 + 0.55 * flashBoost
      for (let i = 1; i < path.pointCount; i++) {
        lCursor = pushLineVert(this.linesCPU, lCursor, path.points[(i - 1) * 2], path.points[(i - 1) * 2 + 1], r, g, b, alpha)
        lCursor = pushLineVert(this.linesCPU, lCursor, path.points[i * 2], path.points[i * 2 + 1], r, g, b, alpha)
        lineVertCount += 2
      }
    }
    if (lineVertCount > 0) {
      gl.bindVertexArray(this.lineVao)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.linesCPU, 0, lCursor)
      gl.useProgram(this.lineProgram)
      gl.drawArrays(gl.LINES, 0, lineVertCount)
    }

    // --- Glyph quads: rain columns, then circuit-trace streamers ---
    let gCursor = 0

    // Rain: perfectly straight columns on the exact grid. Head is brightest
    // white-green (boosted further by bass); tail dims with an exponential
    // falloff tuned so it always reaches MIN_ROW_ALPHA by tailLength glyphs
    // in, regardless of the tailLength knob's current value.
    const rowDecay = Math.pow(MIN_ROW_ALPHA, 1 / Math.max(1, tailLength - 1))
    const headBoost = Math.min(1, 0.5 + bass * 0.6)
    for (let col = 0; col < numColumns; col++) {
      const cx = -1 + pitchX * (col + 0.5)
      const wrapped = (((this.headRow[col] % period) + period) % period)
      const headRowInt = Math.floor(wrapped) - tailLength
      const brightTier = this.colBrightTier[col]
      const [br, bg, bb] = hsl(hue, 0.85, 0.5)

      let alpha = 1
      for (let k = 0; k < tailLength; k++) {
        if (alpha < MIN_ROW_ALPHA && k > 0) break
        const row = headRowInt - k
        if (row >= 0 && row < numRows) {
          const cy = 1 - pitchY * (row + 0.5)
          const epoch = Math.floor(t * mutateRate)
          const gi = hashGlyphIndex(col, row, epoch)
          let r: number, g: number, b: number, a: number
          if (k === 0) {
            r = br + (1 - br) * headBoost
            g = bg + (1 - bg) * headBoost
            b = bb + (1 - bb) * headBoost
            a = brightTier
          } else {
            r = br
            g = bg
            b = bb
            a = alpha * brightTier
          }
          gCursor = pushGlyphQuad(this.glyphsCPU, gCursor, cx, cy, pw, ph, false, gi, r, g, b, a, invHalfWpx, invHalfHpx)
        }
        alpha *= rowDecay
      }
    }

    // Circuit traces: text flowing along straight wire paths, orientation
    // snapped to 0°/90° per segment — never an arbitrary tangent angle.
    // Spacing is expressed in the same (approximately-NDC-x) units as the
    // paths' arc length, derived from the glyph pixel width.
    const pathGlyphSpacing = Math.max(1e-4, pw * invHalfWpx * 2.2)
    let si = 0
    for (let p = 0; p < MAX_PATHS; p++) {
      const path = this.paths[p]
      const flashBoost = p === this.flashPathIndex ? this.flashLevel : 0
      for (let k = 0; k < MAX_STREAMERS_PER_PATH; k++) {
        const streamer = this.streamers[si]
        const active = p < pathCount
        if (active) {
          const sBase = this.arcPos[si]
          for (let g = 0; g < PATH_TAIL; g++) {
            const alpha = Math.pow(0.6, g)
            if (alpha < MIN_PATH_ALPHA) break
            const sample = samplePath(path, sBase - g * pathGlyphSpacing)
            const gi = streamer.glyphs[g % streamer.glyphs.length]
            const isHead = g === 0
            const [hr, hg, hb] = hsl(hue, isHead ? 0.5 : 0.85, isHead ? 0.75 : 0.5)
            const r = isHead ? hr + (1 - hr) * (0.6 + 0.4 * flashBoost) : hr
            const gg = isHead ? hg + (1 - hg) * (0.6 + 0.4 * flashBoost) : hg
            const b = isHead ? hb + (1 - hb) * (0.6 + 0.4 * flashBoost) : hb
            const a = Math.min(1, alpha * (0.85 + flashBoost))
            gCursor = pushGlyphQuad(
              this.glyphsCPU,
              gCursor,
              sample.x,
              sample.y,
              pw,
              ph,
              !sample.horizontal,
              gi,
              r,
              gg,
              b,
              a,
              invHalfWpx,
              invHalfHpx,
            )
          }
        }
        si++
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

  private lookupFadeLocs(program: WebGLProgram): FadeLocs {
    return { uFade: this.gpu.gl.getUniformLocation(program, 'uFade') }
  }

  private lookupGlyphLocs(program: WebGLProgram): GlyphLocs {
    return { uAtlas: this.gpu.gl.getUniformLocation(program, 'uAtlas') }
  }

  getShaderSources(): ShaderStage[] {
    return [
      { key: 'glyph-fs', label: 'Rain glyphs (glyph-fs)', source: this.glyphSource },
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

// ---------------------------------------------------------------------------
// Shared vertex-push helpers (module scope: pure functions over caller-owned
// buffers, no allocation).

function pushLineVert(
  out: Float32Array,
  cursor: number,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a: number,
): number {
  out[cursor++] = x
  out[cursor++] = y
  out[cursor++] = r
  out[cursor++] = g
  out[cursor++] = b
  out[cursor++] = a
  return cursor
}

/**
 * Pushes one glyph quad (6 vertices) into `out` at `cursor`, returning the
 * new cursor. `pw`/`ph` are PIXEL half-extents (not NDC) — rotation happens
 * in pixel space (true squares in, true squares out) and is only converted
 * to NDC afterward via `invHalfWpx`/`invHalfHpx`, which is what keeps a
 * 90°-snapped glyph from skewing under a non-square canvas: rotating
 * pre-scaled NDC offsets directly would skew, since NDC x/y already carry
 * different pixels-per-unit scales whenever aspect != 1.
 */
function pushGlyphQuad(
  out: Float32Array,
  cursor: number,
  cx: number,
  cy: number,
  pw: number,
  ph: number,
  rotated: boolean,
  glyphIndex: number,
  r: number,
  g: number,
  b: number,
  a: number,
  invHalfWpx: number,
  invHalfHpx: number,
): number {
  const cellX = glyphIndex % ATLAS_COLS
  const cellY = Math.floor(glyphIndex / ATLAS_COLS)
  const u0 = (cellX * ATLAS_CELL) / ATLAS_W
  const u1 = (cellX * ATLAS_CELL + GLYPH_W) / ATLAS_W
  const v0 = (cellY * ATLAS_CELL) / ATLAS_H
  const v1 = (cellY * ATLAS_CELL + GLYPH_H) / ATLAS_H

  // Base (unrotated) pixel-space offsets paired with the atlas UV corner
  // each must sample. A vertical (rotated) glyph rotates every offset 90°
  // CCW in this same pixel space before conversion to NDC.
  let tlx = -pw, tly = ph
  let blx = -pw, bly = -ph
  let trx = pw, trY = ph
  let brx = pw, brY = -ph
  if (rotated) {
    ;[tlx, tly] = [-tly, tlx]
    ;[blx, bly] = [-bly, blx]
    ;[trx, trY] = [-trY, trx]
    ;[brx, brY] = [-brY, brx]
  }

  const px = (ox: number): number => cx + ox * invHalfWpx
  const py = (oy: number): number => cy + oy * invHalfHpx

  const push = (x: number, y: number, u: number, v: number): number => {
    out[cursor++] = x
    out[cursor++] = y
    out[cursor++] = u
    out[cursor++] = v
    out[cursor++] = r
    out[cursor++] = g
    out[cursor++] = b
    out[cursor++] = a
    return cursor
  }

  const tlX = px(tlx), tlY = py(tly)
  const blX = px(blx), blY = py(bly)
  const trX = px(trx), trYndc = py(trY)
  const brX = px(brx), brYndc = py(brY)

  cursor = push(tlX, tlY, u0, v0)
  cursor = push(blX, blY, u0, v1)
  cursor = push(trX, trYndc, u1, v0)
  cursor = push(trX, trYndc, u1, v0)
  cursor = push(blX, blY, u0, v1)
  cursor = push(brX, brYndc, u1, v1)
  return cursor
}
