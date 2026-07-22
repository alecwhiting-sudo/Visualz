import type { Gpu } from '../../gpu/context'
import type { RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'

/**
 * Geometry family: "Terrain Flight" — the app's first true 3D scene. An endless
 * wireframe landscape flythrough: a heightfield ring buffer scrolls toward the
 * camera, one new row spawning each time the scroll offset crosses a row
 * boundary at the horizon, its ridges carved from the live band energies
 * sampled at spawn time. Everything (grid geometry, the pinhole camera, depth
 * fog, height tint) is computed CPU-side per frame — like lissajous/glyphlattice
 * — into a plain position+color line-list vertex buffer; the GPU side is just
 * the pass-through line shader plus a trail-fade quad for the neon-persistence
 * look.
 *
 * PRNG discipline: terrain height uses NO seeded-PRNG-stream call anywhere.
 * `valueNoise2`/`lattice` below are a pure hash function of integer (row, col)
 * coordinates (mulberry32-adjacent hash32, ported from flowfield.ts's GLSL
 * `hash32`/`lattice2`), XORed with the scene seed. A stream (`mulberry32`)
 * would make a row's height depend on how many draws happened before it —
 * which varies with how many rows a given run has spawned, i.e. with frame
 * rate and playback history. A pure hash makes `height(row, col)` independent
 * of anything except its own coordinates: any row can be regenerated fresh at
 * any time (necessary since "frozen control ticks" call render() without a
 * preceding update(), and since the ring buffer only ever needs a row computed
 * once, at the moment it's spawned).
 *
 * Frame-clocked scroll (CLAUDE.md "scroll/spawn strictly frame-clocked"):
 * `scrollDistance` advances in update() by `speed * FIXED_STEP` — a constant
 * per-call step, not `speed * frame.dt`. That ties row-spawn cadence to the
 * *count* of update() calls (i.e. to frame number), not to whatever dt a given
 * frame happened to report, so replay reproduces the exact same spawn frame
 * numbers regardless of any timing jitter. `frame.dt` is still used (as
 * everywhere else in the codebase) for the genuinely continuous beat-bob/onset
 * envelopes in update() — those are audio-reactive shaping, not row-spawn
 * timing, so decaying them in real seconds is correct and matches
 * flowfield.ts's onset-pulse pattern.
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

// --- Grid dimensions ---------------------------------------------------------

const ROWS = 64 // depth (rows scrolling toward camera)
const COLS = 48 // lateral (across the terrain)
const COL_SPACING = 0.12
const ROW_SPACING = 1.0
const CAM_HEIGHT = 3.0
const NEAR_EPS = 0.05
const FIXED_STEP = 1 / 30 // frame-clocked scroll tick (see class doc)

// Vertex layout: pos.xy + color.rgba, matching glyphlattice.ts's convention.
const FLOATS_PER_VERTEX = 6
// Worst case: every row/col segment drawn (no near-plane clipping at all).
const MAX_ROW_VERTS = ROWS * (COLS - 1) * 2
const MAX_COL_VERTS = COLS * (ROWS - 1) * 2
const MAX_VERTS = MAX_ROW_VERTS + MAX_COL_VERTS

// --- Pure hash noise (no PRNG stream — see class doc) -----------------------

function hash32(x: number): number {
  x = (x + 0x9e3779b9) >>> 0
  x = x ^ (x >>> 16)
  x = Math.imul(x, 0x7feb352d) >>> 0
  x = x ^ (x >>> 15)
  x = Math.imul(x, 0x846ca68b) >>> 0
  x = x ^ (x >>> 16)
  return x >>> 0
}

function lattice(ix: number, iy: number, seedXor: number): number {
  const k = (hash32(ix >>> 0) ^ Math.imul(iy | 0, 0x9e3779b9) ^ seedXor) >>> 0
  return (hash32(k) / 4294967296) * 2 - 1
}

function fadeCurve(t: number): number {
  return t * t * (3 - 2 * t)
}

function mixLerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Bilinear value noise over a hashed integer lattice — deterministic, no PRNG stream. */
function valueNoise2(x: number, y: number, seedXor: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const u = fadeCurve(fx)
  const v = fadeCurve(fy)
  const a = lattice(ix, iy, seedXor)
  const b = lattice(ix + 1, iy, seedXor)
  const c = lattice(ix, iy + 1, seedXor)
  const d = lattice(ix + 1, iy + 1, seedXor)
  return mixLerp(mixLerp(a, b, u), mixLerp(c, d, u), v)
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

function hsv2rgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s
  const hp = ((h % 1) + 1) % 1 * 6
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hp < 1) { r = c; g = x; b = 0 }
  else if (hp < 2) { r = x; g = c; b = 0 }
  else if (hp < 3) { r = 0; g = c; b = x }
  else if (hp < 4) { r = 0; g = x; b = c }
  else if (hp < 5) { r = x; g = 0; b = c }
  else { r = c; g = 0; b = x }
  const m = v - c
  return [r + m, g + m, b + m]
}

// Lateral music-carving shape constants (§class doc): a broad center massif
// from bass, two lateral ridges from mid, and outer-column sparkle from high.
const MASSIF_WIDTH = 0.45
const RIDGE_CENTER = 0.55
const RIDGE_WIDTH = 0.22
const SPARKLE_START = 0.62

/** One spawned row's per-column noise/music components (kept separate so the
 *  `ridge` knob can remix them live at render time without re-spawning). */
function spawnRow(
  seedXor: number,
  rowCounter: number,
  bass: number,
  mid: number,
  high: number,
  rms: number,
  noiseOut: Float32Array,
  musicOut: Float32Array,
  base: number,
): void {
  const center = (COLS - 1) / 2
  const rmsScale = 0.4 + 0.6 * clamp01(rms)
  for (let col = 0; col < COLS; col++) {
    const nx = center === 0 ? 0 : (col - center) / center // -1..1

    // Two-octave hashed value noise across (rowCounter, col) — see class doc.
    const n1 = valueNoise2(rowCounter * 0.15, col * 0.35, seedXor)
    const n2 = valueNoise2(rowCounter * 0.35 + 50.7, col * 0.9 + 11.3, seedXor ^ 0x2545f491)
    noiseOut[base + col] = n1 * 0.7 + n2 * 0.3

    const massif = Math.exp(-(nx * nx) / (2 * MASSIF_WIDTH * MASSIF_WIDTH)) * bass * 2.2
    const distFromRidge = Math.abs(nx) - RIDGE_CENTER
    const ridgeShape =
      Math.exp(-(distFromRidge * distFromRidge) / (2 * RIDGE_WIDTH * RIDGE_WIDTH)) * mid * 1.5
    const outerMask = smoothstep(SPARKLE_START, 1.0, Math.abs(nx))
    const sparkleRaw = Math.abs(lattice(rowCounter, col * 7 + 3, seedXor ^ 0x1234567))
    const sparkle = outerMask * high * sparkleRaw * 1.4

    musicOut[base + col] = (massif + ridgeShape + sparkle) * rmsScale
  }
}

export class TerrainFlightScene implements SceneRuntime {
  meta = { id: 'terrain', name: 'Terrain Flight', family: 'geometry' as const }

  params: ParamSchema[] = [
    { name: 'speed', label: 'Speed', min: 0.2, max: 3, default: 1 },
    { name: 'relief', label: 'Relief', min: 0.2, max: 2.5, default: 1 },
    { name: 'ridge', label: 'Ridge', min: 0, max: 1, default: 0.5 },
    { name: 'pitch', label: 'Pitch', min: 0.05, max: 0.5, default: 0.22 },
    { name: 'fog', label: 'Fog', min: 0.3, max: 1, default: 0.65 },
    { name: 'glow', label: 'Glow', min: 0.3, max: 2, default: 1 },
    { name: 'hue', label: 'Hue', min: 0, max: 1, default: 0.58 },
    { name: 'pulseBob', label: 'Pulse bob', min: 0, max: 1, default: 0.5 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu
  private seedXor = 0

  // Ring buffer: two components per (row,col) cell, kept separate so `ridge`
  // remixes noise vs music live rather than being baked in at spawn time.
  private ringNoise = new Float32Array(ROWS * COLS)
  private ringMusic = new Float32Array(ROWS * COLS)
  private rowsSpawned = 0 // total rows ever spawned; ring slot = rowCounter % ROWS

  // Frame-clocked scroll state (see class doc) — advanced only in update().
  private scrollDistance = 0

  // dt-based audio envelopes (update()-only; render() only reads them).
  private bobEnv = 0
  private flashEnv = 0

  // Scratch grid buffers, sized once, reused every render() — no per-frame
  // allocation in the hot loop.
  private gridX = new Float32Array(ROWS * COLS)
  private gridY = new Float32Array(ROWS * COLS)
  private gridVisible = new Uint8Array(ROWS * COLS)
  private gridR = new Float32Array(ROWS * COLS)
  private gridG = new Float32Array(ROWS * COLS)
  private gridB = new Float32Array(ROWS * COLS)
  private lineVerts = new Float32Array(MAX_VERTS * FLOATS_PER_VERTEX)

  private lineProgram!: WebGLProgram
  private fadeProgram!: WebGLProgram
  private lineVao!: WebGLVertexArrayObject
  private lineVbo!: WebGLBuffer
  private fadeVao!: WebGLVertexArrayObject
  private fadeLoc!: { uFade: WebGLUniformLocation | null }

  // Code layer (ARCHITECTURE.md §3.3): current source per editable stage,
  // reset to stock every init() so loadSession's dispose+init starts clean.
  private lineSource = LINE_FS
  private fadeSource = FADE_FS

  init(gpu: Gpu, seed: number): void {
    this.gpu = gpu
    this.seedXor = seed >>> 0
    for (const p of this.params) this.values.set(p.name, p.default)

    this.ringNoise = new Float32Array(ROWS * COLS)
    this.ringMusic = new Float32Array(ROWS * COLS)
    this.rowsSpawned = 0
    this.scrollDistance = 0
    this.bobEnv = 0
    this.flashEnv = 0

    // Pre-fill the ring so the very first frame already shows a full grid.
    // Spawned with all-zero signals (init() gets no SignalBus) — the first
    // live-signal-carved rows arrive within the first second of update().
    for (let i = 0; i < ROWS; i++) {
      const base = (this.rowsSpawned % ROWS) * COLS
      spawnRow(this.seedXor, this.rowsSpawned, 0, 0, 0, 0, this.ringNoise, this.ringMusic, base)
      this.rowsSpawned++
    }

    this.lineSource = LINE_FS
    this.fadeSource = FADE_FS

    const gl = gpu.gl
    this.lineProgram = gpu.compileProgram(LINE_VS, this.lineSource)
    this.fadeProgram = gpu.compileProgram(FADE_VS, this.fadeSource)
    this.fadeLoc = { uFade: gl.getUniformLocation(this.fadeProgram, 'uFade') }

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
    const bass = signals.get('bass')
    const mid = signals.get('mid')
    const high = signals.get('high')
    const rms = signals.get('rms')
    const beat = signals.get('beat')
    const onset = signals.get('onset')

    // Frame-clocked scroll: a fixed per-call tick times `speed`, never
    // `frame.dt` — see class doc. Spawn every row boundary crossed since the
    // last update(), sampling the CURRENT signals at each spawn.
    this.scrollDistance += this.getParam('speed') * FIXED_STEP
    const target = ROWS + Math.floor(this.scrollDistance)
    while (this.rowsSpawned < target) {
      const base = (this.rowsSpawned % ROWS) * COLS
      spawnRow(this.seedXor, this.rowsSpawned, bass, mid, high, rms, this.ringNoise, this.ringMusic, base)
      this.rowsSpawned++
    }

    // dt-based envelopes (genuinely continuous audio reactions, unlike the
    // frame-clocked scroll above — matches flowfield.ts's onset-pulse pattern).
    this.bobEnv = this.bobEnv * Math.exp(-8 * frame.dt) + beat
    if (this.bobEnv > 1.5) this.bobEnv = 1.5
    this.flashEnv = this.flashEnv * Math.exp(-10 * frame.dt) + onset
    if (this.flashEnv > 1.5) this.flashEnv = 1.5
  }

  render(_ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()

    const relief = this.getParam('relief')
    const ridge = this.getParam('ridge')
    const pitch = this.getParam('pitch')
    const fog = this.getParam('fog')
    const glow = this.getParam('glow')
    const hue = this.getParam('hue')
    const pulseBob = this.getParam('pulseBob')

    const reliefBoost = 1 + this.bobEnv * pulseBob * 0.5
    const camHeight = CAM_HEIGHT + this.bobEnv * pulseBob * 0.6
    const cosP = Math.cos(pitch)
    const sinP = Math.sin(pitch)
    const aspect = surface.width / surface.height
    const halfExtentX = 1.0
    const halfExtentY = halfExtentX / aspect
    const fractionalOffset = this.scrollDistance - Math.floor(this.scrollDistance)
    const center = (COLS - 1) / 2

    // --- Pass 1: project every grid point once (used by up to 4 line segments). ---
    for (let j = 0; j < ROWS; j++) {
      const rowCounter = this.rowsSpawned - 1 - j
      const ringBase = (((rowCounter % ROWS) + ROWS) % ROWS) * COLS
      const depth = j + 1 - fractionalOffset
      const worldZ = depth * ROW_SPACING
      const fogFactor = Math.exp(-fog * 0.12 * depth) * (1 + Math.max(0, (5 - depth) / 5) * 0.6)
      const flashWeight = this.flashEnv * Math.max(0, 1 - depth / 6)

      for (let c = 0; c < COLS; c++) {
        const idx = j * COLS + c
        const cellIdx = ringBase + c
        const raw = this.ringNoise[cellIdx] * (1 - ridge) + this.ringMusic[cellIdx] * ridge
        const height = raw * relief * reliefBoost

        const worldX = (c - center) * COL_SPACING
        const relY = height - camHeight
        const camY = relY * cosP + worldZ * sinP
        const camZ = worldZ * cosP - relY * sinP

        if (camZ < NEAR_EPS) {
          this.gridVisible[idx] = 0
          continue
        }
        this.gridVisible[idx] = 1
        this.gridX[idx] = (worldX / camZ) / halfExtentX
        this.gridY[idx] = (camY / camZ) / halfExtentY

        const heightNorm = clamp(raw / 3, -1, 1)
        const light = clamp(0.32 + heightNorm * 0.28 + fogFactor * 0.18, 0.02, 1)
        const [r, g, b] = hsv2rgb(hue + heightNorm * 0.05, 0.82, light)
        const intensity = glow * fogFactor * (1 + flashWeight * 1.5)
        this.gridR[idx] = r * intensity
        this.gridG[idx] = g * intensity
        this.gridB[idx] = b * intensity
      }
    }

    // --- Pass 2: emit line-list vertices, skipping segments touching a
    // near-plane-clipped point. ---
    let n = 0 // float write cursor into lineVerts
    const push = (idx: number) => {
      this.lineVerts[n++] = this.gridX[idx]
      this.lineVerts[n++] = this.gridY[idx]
      this.lineVerts[n++] = this.gridR[idx]
      this.lineVerts[n++] = this.gridG[idx]
      this.lineVerts[n++] = this.gridB[idx]
      this.lineVerts[n++] = 1.0
    }
    for (let j = 0; j < ROWS; j++) {
      for (let c = 0; c < COLS - 1; c++) {
        const a = j * COLS + c
        const b = a + 1
        if (this.gridVisible[a] && this.gridVisible[b]) {
          push(a)
          push(b)
        }
      }
    }
    for (let c = 0; c < COLS; c++) {
      for (let j = 0; j < ROWS - 1; j++) {
        const a = j * COLS + c
        const b = a + COLS
        if (this.gridVisible[a] && this.gridVisible[b]) {
          push(a)
          push(b)
        }
      }
    }
    const vertCount = n / FLOATS_PER_VERTEX

    gl.enable(gl.BLEND)

    // Fade pass: translucent black quad — leaves the wireframe a faint motion
    // wake, matching lissajous/glyphlattice's trail-persistence convention.
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(this.fadeProgram)
    gl.uniform1f(this.fadeLoc.uFade, 0.35)
    gl.bindVertexArray(this.fadeVao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // Grid pass: additive for the neon-glow look (overlapping wires brighten).
    gl.blendFunc(gl.ONE, gl.ONE)
    gl.useProgram(this.lineProgram)
    gl.bindVertexArray(this.lineVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo)
    if (n > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.lineVerts, 0, n)
    gl.drawArrays(gl.LINES, 0, vertCount)
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
      { key: 'line-fs', label: 'Grid line color (line-fs)', source: this.lineSource },
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
