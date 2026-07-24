import type { Gpu } from '../../gpu/context'
import type { RenderSurface } from '../../gpu/targets'
import { mulberry32 } from '../../core/prng'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'

/**
 * Geometry family: "Star Flight" — a warp-speed starfield flythrough. A pool of
 * ~1200 stars sits in a 2D-projected 3D field (world x,y in [-1,1], depth z);
 * the camera flies forward by advancing a shared `travel` distance every
 * update(). At rest each star reads as a near-point; at warp speed the same
 * geometry becomes a radial streak, because the streak is drawn as a literal
 * short line segment between two projections of the star at two nearby depths
 * (the depth gap scales with speed), not a shader trick.
 *
 * PRNG discipline (see core/prng.ts + CLAUDE.md hard rules): the pool's
 * INITIAL (x, y, z) is drawn once from the seeded `mulberry32` PRNG in init() —
 * a proper stream read is fine there since it happens exactly once, in a fixed
 * order, and never again. Respawns (a star crossing the near plane) must NOT
 * reuse that stream: how many stars have recycled by a given moment depends on
 * frame rate / playback history, so a stream read there would make a star's
 * post-respawn position depend on incidental timing rather than its own
 * identity. Respawns instead read a pure hash of (starIndex, wrapCount) —
 * `hashUnit()` below, terrain.ts's `hash32`-lineage — where `wrapCount` (how
 * many times THIS star has already wrapped) is itself derived arithmetically
 * from `travel` (see `computeWrap()`), not from an incrementing counter. That
 * makes a star's exact (x, y, effZ) at any moment a pure function of
 * (starIndex, travel) — recomputable from scratch every render() with no
 * mutable per-star state at all, which is what makes "frozen control ticks"
 * (render() called without a preceding update()) and session replay safe.
 *
 * Frame-clocked travel (CLAUDE.md/terrain.ts/whipline.ts convention):
 * `travel` advances in update() by `instSpeed * FIXED_STEP`, a fixed per-call
 * step — never `frame.dt` — so the wrap cadence depends only on the *count* of
 * update() calls, matching replay exactly regardless of timing jitter.
 * `instSpeed` (base `speed` plus a bass-driven `warpPulse` boost) is stored so
 * render() can also grow the streak length/brightness with the same
 * instantaneous speed that just advanced the camera — "bass hits give warp
 * bursts" reads as both a longer streak and a faster flythrough in the same
 * frame. Twinkle shimmer is the one continuous (non-frame-clocked) term: it is
 * plain trig over `ctx.frame.time` (glyphlattice.ts/lissajous.ts's "plain
 * maths over ctx.frame.time" convention), safe because it depends only on the
 * Transport's own time value, not on any call-count state this scene owns.
 */

const NUM_STARS = 1200
const Z_NEAR = 0.06
const Z_FAR = 3.0
const Z_RANGE = Z_FAR - Z_NEAR
const FIXED_STEP = 1 / 60 // frame-clocked travel tick (see class doc)

const BRIGHT_K = 0.16 // brightness = clamp(BRIGHT_K / effZ, 0, BRIGHT_MAX)
const BRIGHT_MAX = 3.2
const POINT_PX_K = 0.55 // point size (px) = clamp(POINT_PX_K / effZ, POINT_MIN_PX, POINT_MAX_PX)
const POINT_MIN_PX = 1.0
const POINT_MAX_PX = 7.5
const TWINKLE_RATE = 6.0 // rad/s
const STREAK_SCALE = 0.9 // streakDepth = streak * STREAK_SCALE * (STREAK_SPEED_BASE + instSpeed)
const STREAK_SPEED_BASE = 0.15

const FLOATS_PER_LINE_VERTEX = 6 // pos.xy + color.rgba
const FLOATS_PER_POINT_VERTEX = 7 // pos.xy + color.rgba + size

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

const POINT_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec4 aColor;
layout(location = 2) in float aSize;
out vec4 vColor;
void main() {
  vColor = aColor;
  gl_Position = vec4(aPos, 0.0, 1.0);
  gl_PointSize = aSize;
}`

const POINT_FS = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d) * 2.0;
  float falloff = smoothstep(1.0, 0.0, r);
  outColor = vec4(vColor.rgb * falloff, vColor.a * falloff);
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
  return v < lo ? lo : v > hi ? hi : v
}

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

/** Pure function of (starIndex, wrapCount, salt) -> [0, 1). No stream. */
function hashUnit(i: number, k: number, salt: number): number {
  const combined = (Math.imul(i | 0, 0x1000193) ^ Math.imul(k | 0, 0x9e3779b9) ^ (salt >>> 0)) >>> 0
  return hash32(combined) / 4294967296
}

function hsv2rgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s
  const hp = (((h % 1) + 1) % 1) * 6
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

/**
 * How many times has star `i` (initial depth `z0`) wrapped past the near
 * plane by the time `travel` has accumulated to this value, and what is its
 * current effective depth? Both are pure functions of (z0, travel) — see
 * class doc: this is what lets every star's state be recomputed from scratch
 * every render() with no mutable per-star field at all.
 *
 * Derivation: wrapping `v = z0 - travel` into (Z_NEAR, Z_FAR] with period
 * Z_RANGE is `effZ = Z_FAR - mod(Z_FAR - v, Z_RANGE)`; `wrapCount` is the
 * number of full periods `mod` folded away, i.e. `floor((Z_FAR - v) / Z_RANGE)`.
 */
function computeWrap(z0: number, travel: number): { k: number; effZ: number } {
  const v = z0 - travel
  const k = Math.floor((Z_FAR - v) / Z_RANGE)
  let effZ = v + k * Z_RANGE
  if (effZ < Z_NEAR) effZ = Z_NEAR // defensive; the formula keeps this in (Z_NEAR, Z_FAR] by construction
  return { k, effZ }
}

export class StarFlightScene implements SceneRuntime {
  meta = { id: 'starflight', name: 'Star Flight', family: 'geometry' as const }

  params: ParamSchema[] = [
    { name: 'speed', label: 'Speed', min: 0.1, max: 4, default: 1.2 },
    { name: 'warpPulse', label: 'Warp pulse', min: 0, max: 4, default: 1.0 },
    { name: 'density', label: 'Density', min: 0.05, max: 1, default: 0.7 },
    { name: 'streak', label: 'Streak', min: 0, max: 1, default: 0.45 },
    { name: 'spread', label: 'Spread', min: 0.4, max: 2.5, default: 1.0 },
    { name: 'hue', label: 'Hue', min: 0, max: 1, default: 0 },
    { name: 'twinkle', label: 'Twinkle', min: 0, max: 1, default: 0.3 },
    { name: 'glow', label: 'Glow', min: 0.3, max: 2.5, default: 1.0 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu
  private seedXor = 0

  // Star pool: initial (x, y, z) from the seeded PRNG at init() (class doc).
  // Immutable after init — all subsequent motion/respawn is derived on the
  // fly in render() from (this field, travel), never mutated in place.
  private starX0 = new Float32Array(NUM_STARS)
  private starY0 = new Float32Array(NUM_STARS)
  private starZ0 = new Float32Array(NUM_STARS)

  // Frame-clocked flight state (see class doc) — advanced only in update().
  private travel = 0
  private instSpeed = 0

  private lineProgram!: WebGLProgram
  private pointProgram!: WebGLProgram
  private fadeProgram!: WebGLProgram
  private lineVao!: WebGLVertexArrayObject
  private lineVbo!: WebGLBuffer
  private pointVao!: WebGLVertexArrayObject
  private pointVbo!: WebGLBuffer
  private fadeVao!: WebGLVertexArrayObject
  private fadeLoc!: { uFade: WebGLUniformLocation | null }

  // Code layer (ARCHITECTURE.md §3.3): current source per editable stage,
  // reset to stock every init() so loadSession's dispose+init starts clean.
  private lineSource = LINE_FS
  private pointSource = POINT_FS
  private fadeSource = FADE_FS

  // Scratch vertex buffers, sized once, reused every render() — no per-frame
  // allocation in the hot loop.
  private lineVerts = new Float32Array(NUM_STARS * 2 * FLOATS_PER_LINE_VERTEX)
  private pointVerts = new Float32Array(NUM_STARS * FLOATS_PER_POINT_VERTEX)

  init(gpu: Gpu, seed: number): void {
    this.gpu = gpu
    this.seedXor = seed >>> 0
    for (const p of this.params) this.values.set(p.name, p.default)

    const rand = mulberry32(seed)
    for (let i = 0; i < NUM_STARS; i++) {
      this.starX0[i] = rand() * 2 - 1
      this.starY0[i] = rand() * 2 - 1
      this.starZ0[i] = Z_NEAR + rand() * Z_RANGE
    }

    this.travel = 0
    this.instSpeed = 0

    this.lineSource = LINE_FS
    this.pointSource = POINT_FS
    this.fadeSource = FADE_FS

    const gl = gpu.gl
    this.lineProgram = gpu.compileProgram(LINE_VS, this.lineSource)
    this.pointProgram = gpu.compileProgram(POINT_VS, this.pointSource)
    this.fadeProgram = gpu.compileProgram(FADE_VS, this.fadeSource)
    this.fadeLoc = { uFade: gl.getUniformLocation(this.fadeProgram, 'uFade') }

    this.lineVao = gl.createVertexArray()!
    this.lineVbo = gl.createBuffer()!
    gl.bindVertexArray(this.lineVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo)
    gl.bufferData(gl.ARRAY_BUFFER, this.lineVerts.byteLength, gl.DYNAMIC_DRAW)
    const lineStride = FLOATS_PER_LINE_VERTEX * 4
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, lineStride, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, lineStride, 2 * 4)

    this.pointVao = gl.createVertexArray()!
    this.pointVbo = gl.createBuffer()!
    gl.bindVertexArray(this.pointVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointVbo)
    gl.bufferData(gl.ARRAY_BUFFER, this.pointVerts.byteLength, gl.DYNAMIC_DRAW)
    const pointStride = FLOATS_PER_POINT_VERTEX * 4
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, pointStride, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, pointStride, 2 * 4)
    gl.enableVertexAttribArray(2)
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, pointStride, 6 * 4)

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
    const { signals } = ctx
    const bass = signals.get('bass')
    const speed = this.getParam('speed')
    const warpPulse = this.getParam('warpPulse')

    // Instantaneous speed = base speed + bass-driven warp burst. Stored so
    // render() can grow the streak with the exact speed that moved the
    // camera this tick (see class doc).
    this.instSpeed = Math.max(0, speed + warpPulse * bass)

    // Frame-clocked travel: a fixed per-call tick times instSpeed, never
    // `frame.dt` — see class doc.
    this.travel += this.instSpeed * FIXED_STEP
  }

  render(ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()

    const aspect = surface.width / surface.height
    const ax = 1 / Math.max(aspect, 1)
    const ay = Math.min(aspect, 1)

    const density = clamp(this.getParam('density'), 0.05, 1)
    const streak = clamp(this.getParam('streak'), 0, 1)
    const fov = clamp(this.getParam('spread'), 0.4, 2.5)
    const hue = clamp(this.getParam('hue'), 0, 1)
    const twinkle = clamp(this.getParam('twinkle'), 0, 1)
    const glow = clamp(this.getParam('glow'), 0.3, 2.5)
    const t = ctx.frame.time

    // Tint: 0 = white (saturation ramps to full over the first quarter of the
    // range), then sweeps the hue wheel at full saturation (class doc / spec).
    const sat = clamp(hue * 4, 0, 1)
    const [tr, tg, tb] = hsv2rgb(hue, sat, 1)

    // Streak segment depth: grows with both the `streak` knob and the current
    // instantaneous speed ("bass hits give warp bursts" reads as longer
    // streaks). At streak=0 this is exactly 0 — lines are skipped entirely
    // and stars read as plain points, matching the spec's "0 = points".
    const streakDepth = streak * STREAK_SCALE * (STREAK_SPEED_BASE + this.instSpeed)
    const drawLines = streakDepth > 1e-4

    const count = clamp(Math.floor(NUM_STARS * density), 0, NUM_STARS)

    let lp = 0 // point-vertex float cursor
    let ll = 0 // line-vertex float cursor
    for (let i = 0; i < count; i++) {
      const { k, effZ } = computeWrap(this.starZ0[i], this.travel)

      // Fresh (x, y) on every respawn from a pure hash of (index, wrapCount) —
      // never the init PRNG stream (class doc). Wrap 0 (never respawned) uses
      // the original PRNG-seeded position.
      let x: number
      let y: number
      if (k === 0) {
        x = this.starX0[i]
        y = this.starY0[i]
      } else {
        x = hashUnit(i, k, this.seedXor) * 2 - 1
        y = hashUnit(i, k, this.seedXor ^ 0x2545f491) * 2 - 1
      }

      // Per-star shimmer: plain trig over ctx.frame.time (class doc) — safe
      // and replay-deterministic since it depends only on Transport time.
      const twinklePhase = hashUnit(i, 0, this.seedXor ^ 0x1234567)
      const shimmer = 1 + twinkle * 0.6 * Math.sin(t * TWINKLE_RATE + twinklePhase * Math.PI * 2)

      const headBright = clamp(BRIGHT_K / effZ, 0, BRIGHT_MAX) * glow * shimmer
      const hx = (x / effZ) * fov * ax
      const hy = (y / effZ) * fov * ay

      this.pointVerts[lp++] = hx
      this.pointVerts[lp++] = hy
      this.pointVerts[lp++] = tr * headBright
      this.pointVerts[lp++] = tg * headBright
      this.pointVerts[lp++] = tb * headBright
      this.pointVerts[lp++] = 1.0
      this.pointVerts[lp++] = clamp(POINT_PX_K / effZ, POINT_MIN_PX, POINT_MAX_PX)

      if (drawLines) {
        const tailZ = effZ + streakDepth
        const tailBright = clamp(BRIGHT_K / tailZ, 0, BRIGHT_MAX) * glow * shimmer
        const tx = (x / tailZ) * fov * ax
        const ty = (y / tailZ) * fov * ay

        this.lineVerts[ll++] = hx
        this.lineVerts[ll++] = hy
        this.lineVerts[ll++] = tr * headBright
        this.lineVerts[ll++] = tg * headBright
        this.lineVerts[ll++] = tb * headBright
        this.lineVerts[ll++] = 1.0

        this.lineVerts[ll++] = tx
        this.lineVerts[ll++] = ty
        this.lineVerts[ll++] = tr * tailBright
        this.lineVerts[ll++] = tg * tailBright
        this.lineVerts[ll++] = tb * tailBright
        this.lineVerts[ll++] = 1.0
      }
    }

    gl.enable(gl.BLEND)

    // Fade pass: translucent black quad, more persistence (smaller uFade) as
    // `streak` rises — "streak also feeds its persistence" (spec).
    const uFade = clamp(0.5 - streak * 0.42, 0.08, 0.5)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(this.fadeProgram)
    gl.uniform1f(this.fadeLoc.uFade, uFade)
    gl.bindVertexArray(this.fadeVao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // Star passes: additive, so overlapping streaks/heads brighten (neon look).
    gl.blendFunc(gl.ONE, gl.ONE)

    if (drawLines && ll > 0) {
      gl.useProgram(this.lineProgram)
      gl.bindVertexArray(this.lineVao)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.lineVerts, 0, ll)
      gl.drawArrays(gl.LINES, 0, ll / FLOATS_PER_LINE_VERTEX)
    }

    if (lp > 0) {
      gl.useProgram(this.pointProgram)
      gl.bindVertexArray(this.pointVao)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pointVbo)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.pointVerts, 0, lp)
      gl.drawArrays(gl.POINTS, 0, lp / FLOATS_PER_POINT_VERTEX)
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
    gl.deleteProgram(this.lineProgram)
    gl.deleteProgram(this.pointProgram)
    gl.deleteProgram(this.fadeProgram)
    gl.deleteVertexArray(this.lineVao)
    gl.deleteBuffer(this.lineVbo)
    gl.deleteVertexArray(this.pointVao)
    gl.deleteBuffer(this.pointVbo)
    gl.deleteVertexArray(this.fadeVao)
  }

  getShaderSources(): ShaderStage[] {
    return [
      { key: 'line-fs', label: 'Streak color (line-fs)', source: this.lineSource },
      { key: 'point-fs', label: 'Star head color (point-fs)', source: this.pointSource },
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
      case 'point-fs': {
        const program = this.gpu.compileProgram(POINT_VS, source)
        gl.deleteProgram(this.pointProgram)
        this.pointProgram = program
        this.pointSource = source
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
