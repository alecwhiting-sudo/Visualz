import type { Gpu } from '../../gpu/context'
import type { RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'

/**
 * Terrain — a perspective grid ("the matrix floor"). A wireframe plane recedes
 * to a vanishing point on the screen's centre line and scrolls toward the
 * viewer, the lateral rungs spreading apart as they rush down out of the
 * horizon. `relief` raises randomised bumps out of the plane; at relief 0 it is
 * the completely flat matrix. First-built exemplar of the SCENE CONTRACT (see
 * docs/SCENE_CONTRACT.md + ARCHITECTURE.md §"Preview = export"); every rule the
 * old Terrain broke is designed out here rather than patched:
 *
 *  1. render() is PURE. It clears the surface and redraws the whole grid from
 *     `scrollDistance` every call — no fade quad, no framebuffer feedback, no
 *     scene state touched. Calling render() twice with no update() between
 *     produces byte-identical pixels (the frozen-control-tick case is free, not
 *     special). There are NO trails: a trail is history, and history that lives
 *     in the draw step is exactly what made the old scene render differently at
 *     different frame rates.
 *
 *  2. All motion lives in update(), paced by ELAPSED SECONDS. `scrollDistance`
 *     advances by `speed * SCROLL_PER_SEC * frame.dt`, so the floor covers the
 *     same ground per wall-second at 30, 60, or 120 fps — what you preview is
 *     what you export. (Determinism is intact: export/replay step a fixed dt.)
 *
 *  3. Randomness is a POSITIONAL HASH, not a stream. A bump's height is a pure
 *     function `heightAt(worldRow, col)` — a seeded value-noise over the integer
 *     terrain lattice (mulberry-adjacent hash, XORed with the scene seed). A
 *     stream PRNG (mulberry32) would tie a row's height to how many draws
 *     happened before it, which varies with frame rate and history — the same
 *     hazard as a trail. A pure hash makes each row's shape depend only on WHICH
 *     piece of world terrain it is (`floor(scrollDistance) + j`), so bumps flow
 *     smoothly toward the camera as the field scrolls and any row regenerates
 *     identically at any time. No Date.now / performance.now / Math.random.
 *
 * Deliberately non-audio-reactive for now: coupling `bass`→relief and the
 * Tunnel composite come next, on top of this compliant base.
 */

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

// --- Grid dimensions ---------------------------------------------------------

const ROWS = 28 // lateral rungs, near → far
const COLS = 28 // longitudinal rails, left → right
const ROW_SPACING = 0.9 // world depth between rungs
const COL_SPACING = 0.22 // world width between rails
const DEFAULT_ALTITUDE = 1.0 // default camera height above the base plane (the `altitude` param)
const FOCAL = 1.3 // pinhole focal length (vertical FOV)
const NEAR_EPS = 0.08 // clip a point once its depth drops below this
const SCROLL_PER_SEC = 3 // rungs crossed per second at speed 1 (wall-clock paced)
// Value-noise sampling frequencies over the (worldRow, col) terrain lattice:
// low frequency = broad rolling hills, the second octave adds finer detail.
const ROW_FREQ = 0.16
const COL_FREQ = 0.20
const ROW_FREQ2 = 0.41
const COL_FREQ2 = 0.53

const FLOATS_PER_VERTEX = 6 // pos.xy + color.rgba
// Worst case: every rung segment + every rail segment, all points unclipped.
const MAX_VERTS = (ROWS * (COLS - 1) + COLS * (ROWS - 1)) * 2

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

// --- Positional hash noise (seeded, no PRNG stream — see class doc) ----------

function hash32(x: number): number {
  x = (x + 0x9e3779b9) >>> 0
  x = x ^ (x >>> 16)
  x = Math.imul(x, 0x7feb352d) >>> 0
  x = x ^ (x >>> 15)
  x = Math.imul(x, 0x846ca68b) >>> 0
  x = x ^ (x >>> 16)
  return x >>> 0
}

/** Deterministic lattice value in [-1,1] at integer (ix, iy), keyed by seed. */
function lattice(ix: number, iy: number, seedXor: number): number {
  const k = (hash32(ix >>> 0) ^ Math.imul(iy | 0, 0x9e3779b9) ^ seedXor) >>> 0
  return (hash32(k) / 4294967296) * 2 - 1
}

function fadeCurve(t: number): number {
  return t * t * (3 - 2 * t)
}

/** Bilinear value noise over the hashed integer lattice — smooth, deterministic. */
function valueNoise2(x: number, y: number, seedXor: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const u = fadeCurve(x - ix)
  const v = fadeCurve(y - iy)
  const a = lattice(ix, iy, seedXor)
  const b = lattice(ix + 1, iy, seedXor)
  const c = lattice(ix, iy + 1, seedXor)
  const d = lattice(ix + 1, iy + 1, seedXor)
  return a + (b - a) * u + (c - a + (a - b - c + d) * u) * v
}

/** Two-octave terrain height at an integer world row/col — the bump field.
 *  Pure function of (worldRow, col, seed): the same terrain regenerates
 *  identically however the scroll got here (see class doc). */
function heightAt(worldRow: number, col: number, seedXor: number): number {
  const n1 = valueNoise2(worldRow * ROW_FREQ, col * COL_FREQ, seedXor)
  const n2 = valueNoise2(worldRow * ROW_FREQ2 + 31.7, col * COL_FREQ2 + 11.3, seedXor ^ 0x2545f491)
  return n1 * 0.72 + n2 * 0.28
}

function hsv2rgb(h: number, s: number, v: number): [number, number, number] {
  const hp = (((h % 1) + 1) % 1) * 6
  const c = v * s
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hp < 1) { r = c; g = x }
  else if (hp < 2) { r = x; g = c }
  else if (hp < 3) { g = c; b = x }
  else if (hp < 4) { g = x; b = c }
  else if (hp < 5) { r = x; b = c }
  else { r = c; b = x }
  const m = v - c
  return [r + m, g + m, b + m]
}

export class TerrainScene implements SceneRuntime {
  meta = { id: 'terrain', name: 'Terrain', family: 'geometry' as const }

  params: ParamSchema[] = [
    { name: 'speed', label: 'Speed', min: 0.1, max: 3, default: 1 },
    { name: 'relief', label: 'Relief', min: 0, max: 1.5, default: 0.7 },
    // Flight height: camera altitude above the base plane. At ~0 you fly at sea
    // level and the contours rise above you and pass overhead; higher looks down
    // on the terrain. The camera never tilts, so the horizon stays on the centre
    // line at every altitude.
    { name: 'altitude', label: 'Flight height', min: 0, max: 3, default: DEFAULT_ALTITUDE },
    { name: 'spread', label: 'Spread', min: 0.6, max: 2, default: 1 },
    { name: 'fog', label: 'Fog', min: 0.2, max: 1.2, default: 0.6 },
    { name: 'glow', label: 'Glow', min: 0.3, max: 2, default: 1 },
    { name: 'hue', label: 'Hue', min: 0, max: 1, default: 0.55 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu
  private seedXor = 0

  // The one piece of scene state: continuous scroll distance in ROWS, advanced
  // ONLY in update(). render() reads it and nothing else. Its integer part picks
  // which world terrain rows are on screen (so bumps flow toward the camera) and
  // its fraction is the sub-row offset. Continuous (not wrapped) so `floor()`
  // gives a stable, monotonic world-row index. This is what keeps render() pure
  // and the whole scene frame-rate independent.
  private scrollDistance = 0

  // Scratch grid buffers, sized once, reused every render() — no per-frame alloc.
  private gridX = new Float32Array(ROWS * COLS)
  private gridY = new Float32Array(ROWS * COLS)
  private gridVisible = new Uint8Array(ROWS * COLS)
  private gridR = new Float32Array(ROWS * COLS)
  private gridG = new Float32Array(ROWS * COLS)
  private gridB = new Float32Array(ROWS * COLS)
  private lineVerts = new Float32Array(MAX_VERTS * FLOATS_PER_VERTEX)

  private lineProgram!: WebGLProgram
  private lineVao!: WebGLVertexArrayObject
  private lineVbo!: WebGLBuffer
  private lineSource = LINE_FS

  init(gpu: Gpu, seed: number): void {
    this.gpu = gpu
    this.seedXor = seed >>> 0
    for (const p of this.params) this.values.set(p.name, p.default)
    this.scrollDistance = 0
    this.lineSource = LINE_FS

    const gl = gpu.gl
    this.lineProgram = gpu.compileProgram(LINE_VS, this.lineSource)
    this.lineVao = gl.createVertexArray()!
    this.lineVbo = gl.createBuffer()!
    gl.bindVertexArray(this.lineVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo)
    gl.bufferData(gl.ARRAY_BUFFER, this.lineVerts.byteLength, gl.DYNAMIC_DRAW)
    const stride = FLOATS_PER_VERTEX * 4
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 2 * 4)
    gl.bindVertexArray(null)
  }

  setParam(name: string, value: number): void {
    this.values.set(name, value)
  }

  getParam(name: string): number {
    // Reserved read-only introspection key (never enumerated in `params`): lets
    // the frame-rate-independence spec read the accumulated scroll distance and
    // assert it lands the same per wall-second at any fps — the direct probe of
    // dt-paced scroll, which pixel counts are too coarse to reveal.
    if (name === '#scrollDistance') return this.scrollDistance
    return this.values.get(name) ?? 0
  }

  update(ctx: FrameContext): void {
    // The ONLY state change in the scene. Wall-clock paced (× frame.dt), so the
    // floor advances the same distance per second at any frame rate. Continuous
    // (never wrapped) so floor(scrollDistance) is a stable world-row index for
    // the bump field.
    this.scrollDistance += this.getParam('speed') * SCROLL_PER_SEC * ctx.frame.dt
  }

  render(_ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()

    // Pure clear-and-draw: the frame is fully determined by scrollPhase + size,
    // so render() has no dependence on what was on the surface before it.
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    const relief = this.getParam('relief')
    const altitude = this.getParam('altitude')
    const spread = this.getParam('spread')
    const fog = this.getParam('fog')
    const glow = this.getParam('glow')
    const hue = this.getParam('hue')
    const aspect = surface.width / surface.height
    const centerCol = (COLS - 1) / 2
    const frac = this.scrollDistance - Math.floor(this.scrollDistance)
    const baseRow = Math.floor(this.scrollDistance)

    // --- Pass 1: project every grid intersection, raised by the bump field. ---
    for (let j = 0; j < ROWS; j++) {
      // Nearest rung at j=0; (1 - frac) slides the whole field toward the camera
      // as the scroll grows, so rungs flow down out of the horizon. `worldRow`
      // is the integer piece of terrain this screen rung shows — advancing
      // baseRow by one as the scroll crosses a row boundary hands each bump to
      // the next-nearer screen slot, so the field scrolls seamlessly.
      const depth = (j + (1 - frac)) * ROW_SPACING
      const worldRow = baseRow + j
      const fogFactor = Math.exp(-fog * 0.12 * depth)
      for (let c = 0; c < COLS; c++) {
        const idx = j * COLS + c
        if (depth < NEAR_EPS) {
          this.gridVisible[idx] = 0
          continue
        }
        const worldX = (c - centerCol) * COL_SPACING * spread
        const height = heightAt(worldRow, c, this.seedXor) * relief
        // Pinhole projection of the plane at worldY = height - altitude (camera
        // at y=0, base plane `altitude` below it). The optical axis is horizontal
        // (no pitch), so worldY=0 as depth→∞ projects to ndcY=0 — the horizon
        // sits on the screen's centre line at every altitude. At altitude→0
        // (sea level) a bump's positive height projects to positive ndcY (above
        // the camera) and rushes off the top as it nears — the contour flies over.
        this.gridX[idx] = (FOCAL * (worldX / depth)) / aspect
        this.gridY[idx] = (FOCAL * ((height - altitude) / depth))
        this.gridVisible[idx] = 1

        // Tint by height: peaks read hotter/brighter than valleys, a cheap depth
        // cue that also makes the bumps legible in wireframe.
        const heightNorm = clamp01(0.5 + height * 0.5)
        const light = clamp01(0.22 + heightNorm * 0.3 + fogFactor * 0.5)
        const [r, g, b] = hsv2rgb(hue + heightNorm * 0.06, 0.75, light)
        const intensity = glow * fogFactor
        this.gridR[idx] = r * intensity
        this.gridG[idx] = g * intensity
        this.gridB[idx] = b * intensity
      }
    }

    // --- Pass 2: emit line-list vertices (rungs + rails), skipping any segment
    // touching a near-clipped point. ---
    let n = 0
    const push = (idx: number) => {
      this.lineVerts[n++] = this.gridX[idx]
      this.lineVerts[n++] = this.gridY[idx]
      this.lineVerts[n++] = this.gridR[idx]
      this.lineVerts[n++] = this.gridG[idx]
      this.lineVerts[n++] = this.gridB[idx]
      this.lineVerts[n++] = 1.0
    }
    // Rungs (constant depth, spanning the width).
    for (let j = 0; j < ROWS; j++) {
      for (let c = 0; c < COLS - 1; c++) {
        const a = j * COLS + c
        const b = a + 1
        if (this.gridVisible[a] && this.gridVisible[b]) { push(a); push(b) }
      }
    }
    // Rails (constant lateral position, running into the distance).
    for (let c = 0; c < COLS; c++) {
      for (let j = 0; j < ROWS - 1; j++) {
        const a = j * COLS + c
        const b = a + COLS
        if (this.gridVisible[a] && this.gridVisible[b]) { push(a); push(b) }
      }
    }

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE) // additive: overlapping wires brighten (neon)
    gl.useProgram(this.lineProgram)
    gl.bindVertexArray(this.lineVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo)
    if (n > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.lineVerts, 0, n)
    gl.drawArrays(gl.LINES, 0, n / FLOATS_PER_VERTEX)
    gl.bindVertexArray(null)
  }

  resize(width: number, height: number): void {
    this.gpu.resize(width, height)
  }

  dispose(): void {
    const gl = this.gpu.gl
    gl.deleteProgram(this.lineProgram)
    gl.deleteVertexArray(this.lineVao)
    gl.deleteBuffer(this.lineVbo)
  }

  getShaderSources(): ShaderStage[] {
    return [{ key: 'line-fs', label: 'Grid line color (line-fs)', source: this.lineSource }]
  }

  setShaderSource(key: string, source: string): void {
    if (key !== 'line-fs') throw new Error(`Unknown shader stage "${key}" for scene "${this.meta.id}"`)
    const gl = this.gpu.gl
    const program = this.gpu.compileProgram(LINE_VS, source) // throws on GLSL error; old program untouched
    gl.deleteProgram(this.lineProgram)
    this.lineProgram = program
    this.lineSource = source
  }
}
