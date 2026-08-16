import type { Gpu } from '../../gpu/context'
import type { RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'

/**
 * Terrain — a flat perspective grid ("the matrix floor"). A completely flat
 * wireframe plane recedes to a vanishing point on the screen's centre line and
 * scrolls toward the viewer, the lateral rungs spreading apart as they rush down
 * out of the horizon. First-built exemplar of the SCENE CONTRACT (see
 * docs/SCENE_CONTRACT.md + ARCHITECTURE.md §"Preview = export"); every rule the
 * old Terrain broke is designed out here rather than patched:
 *
 *  1. render() is PURE. It clears the surface and redraws the whole grid from
 *     `scrollPhase` every call — no fade quad, no framebuffer feedback, no scene
 *     state touched. Calling render() twice with no update() between produces
 *     byte-identical pixels (the frozen-control-tick case is free, not special).
 *     There are NO trails: a trail is history, and history that lives in the
 *     draw step is exactly what made the old scene render differently at
 *     different frame rates.
 *
 *  2. All motion lives in update(), paced by ELAPSED SECONDS. `scrollPhase`
 *     advances by `speed * SCROLL_PER_SEC * frame.dt`, so the floor covers the
 *     same ground per wall-second at 30, 60, or 120 fps — what you preview is
 *     what you export. (Determinism is intact: export/replay step a fixed dt.)
 *
 *  3. No real clock, no randomness. The grid is a pure function of integer
 *     row/column indices and `scrollPhase`; it needs no PRNG at all.
 *
 * Deliberately flat and non-reactive for now: audio-driven relief and the
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
const CAM_HEIGHT = 1.0 // camera height above the flat plane
const FOCAL = 1.3 // pinhole focal length (vertical FOV)
const NEAR_EPS = 0.08 // clip a point once its depth drops below this
const SCROLL_PER_SEC = 3 // rungs crossed per second at speed 1 (wall-clock paced)

const FLOATS_PER_VERTEX = 6 // pos.xy + color.rgba
// Worst case: every rung segment + every rail segment, all points unclipped.
const MAX_VERTS = (ROWS * (COLS - 1) + COLS * (ROWS - 1)) * 2

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
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
    { name: 'spread', label: 'Spread', min: 0.6, max: 2, default: 1 },
    { name: 'fog', label: 'Fog', min: 0.2, max: 1.2, default: 0.6 },
    { name: 'glow', label: 'Glow', min: 0.3, max: 2, default: 1 },
    { name: 'hue', label: 'Hue', min: 0, max: 1, default: 0.55 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu

  // The one piece of scene state: fractional scroll position in [0,1), advanced
  // ONLY in update(). render() reads it and nothing else. This is what keeps
  // render() pure and the whole scene frame-rate independent.
  private scrollPhase = 0

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

  init(gpu: Gpu, _seed: number): void {
    this.gpu = gpu
    for (const p of this.params) this.values.set(p.name, p.default)
    this.scrollPhase = 0
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
    // the frame-rate-independence spec read the accumulated scroll position and
    // assert it lands the same per wall-second at any fps — the direct probe of
    // dt-paced scroll, which the flat grid's lit-pixel count is too phase-
    // invariant to reveal.
    if (name === '#scrollPhase') return this.scrollPhase
    return this.values.get(name) ?? 0
  }

  update(ctx: FrameContext): void {
    // The ONLY state change in the scene. Wall-clock paced (× frame.dt), so the
    // floor advances the same distance per second at any frame rate. Wrapped to
    // [0,1): because every row is identical on a flat grid, wrapping recycles the
    // nearest rung seamlessly.
    const step = this.getParam('speed') * SCROLL_PER_SEC * ctx.frame.dt
    this.scrollPhase = (this.scrollPhase + step) % 1
    if (this.scrollPhase < 0) this.scrollPhase += 1
  }

  render(_ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()

    // Pure clear-and-draw: the frame is fully determined by scrollPhase + size,
    // so render() has no dependence on what was on the surface before it.
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    const spread = this.getParam('spread')
    const fog = this.getParam('fog')
    const glow = this.getParam('glow')
    const hue = this.getParam('hue')
    const aspect = surface.width / surface.height
    const centerCol = (COLS - 1) / 2
    const phase = this.scrollPhase

    // --- Pass 1: project every grid intersection of the flat plane. ---
    for (let j = 0; j < ROWS; j++) {
      // Nearest rung at j=0; (1 - phase) slides the whole field toward the
      // camera as phase grows, so rungs flow down out of the horizon.
      const depth = (j + (1 - phase)) * ROW_SPACING
      const fogFactor = Math.exp(-fog * 0.12 * depth)
      for (let c = 0; c < COLS; c++) {
        const idx = j * COLS + c
        if (depth < NEAR_EPS) {
          this.gridVisible[idx] = 0
          continue
        }
        const worldX = (c - centerCol) * COL_SPACING * spread
        // Pinhole projection of the flat plane (worldY = -CAM_HEIGHT). As depth
        // grows both axes collapse toward (0,0) — the vanishing point on the
        // screen's centre line.
        this.gridX[idx] = (FOCAL * (worldX / depth)) / aspect
        this.gridY[idx] = FOCAL * (-CAM_HEIGHT / depth)
        this.gridVisible[idx] = 1

        const light = clamp01(0.25 + fogFactor * 0.75)
        const [r, g, b] = hsv2rgb(hue, 0.75, light)
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
