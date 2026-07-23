import { mulberry32, type Prng } from '../../core/prng'
import type { Gpu } from '../../gpu/context'
import type { RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'

/**
 * Geometry family: "Neural Web" — a graph that BUILDS itself to the beat. It
 * starts as a small seed cluster; every beat spawns `additions` new nodes, each
 * springing from a randomly chosen living node and wiring itself to that parent
 * plus its next-nearest neighbours (`connectivity` edges total). A force-
 * directed layout (edges are springs, all nodes repel) makes the web spread
 * and rearrange organically as it grows. Nodes live for `fade` seconds then
 * dim to black and are culled; their edges go with them.
 *
 * Each node is randomly a BASS (red), MID (blue) or TREBLE (green) node. When a
 * band gets loud, a few of that band's living nodes fire a light PULSE that
 * travels FORWARD ONLY — along edges toward YOUNGER nodes (higher spawn id) —
 * re-emitting at each node it reaches, so a wavefront ripples out through the
 * part of the graph that grew after the emitter. A node that has begun fading
 * can neither emit nor re-emit. Pulses are drawn additively, so where a red and
 * a blue pulse cross you get magenta, all three give white — real light mixing,
 * for free from the ONE,ONE blend (see class doc's "colour" note).
 *
 * DETERMINISM (ARCHITECTURE.md §1):
 *  - Randomness (seed-cluster layout, per-node band, parent choice, spawn
 *    jitter) comes only from the seeded `random` PRNG, advanced ONLY at init()
 *    and on each beat-spawn — a discrete event, exactly resonance.ts's rule. It
 *    is NEVER advanced per-frame.
 *  - Which nodes fire a pulse on a loud band uses a PURE HASH of (fireCounter,
 *    node id), not the shared PRNG, so the spawn stream stays independent of how
 *    many pulses happened to fire (pulses are signal-triggered, and coupling the
 *    two streams would make node layout depend on audio loudness history).
 *  - The force sim and pulse travel advance a FIXED amount per update() call
 *    (frame-clocked, like whipline.ts) — NOT scaled by frame.dt — so frame N is
 *    identical in live (60fps) and render (fixed 1/fps) mode. Node lifetime/fade
 *    is measured in real seconds off frame.time (a genuinely continuous quantity
 *    that render mode reproduces exactly by stepping time in fixed increments).
 */

// --- Shaders ----------------------------------------------------------------

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

const POINT_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec4 aColor;
layout(location = 2) in float aSize;
out vec4 vColor;
void main() {
  vColor = aColor;
  gl_PointSize = aSize;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const POINT_FS = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() {
  // Soft round dot: fade from centre so points read as glowing blobs, not
  // squares. Premultiplied for the additive (ONE,ONE) blend, so overlapping
  // pulses ADD their colours (red+green=yellow, all three=white).
  float d = length(gl_PointCoord - vec2(0.5));
  float a = smoothstep(0.5, 0.0, d);
  outColor = vec4(vColor.rgb * a * vColor.a, 1.0);
}`

const FADE_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`

const FADE_FS = `#version 300 es
precision highp float;
uniform float uFade;
out vec4 outColor;
void main() { outColor = vec4(0.0, 0.0, 0.0, uFade); }`

// --- Model constants ---------------------------------------------------------

const MAX_NODES = 260
const MAX_EDGES = MAX_NODES * 8
const MAX_PULSES = 900
const MAX_HOPS = 6 // a pulse re-emits at most this many nodes deep before dying

const BASE_VIEW = 2.6 // world half-extent shown on screen at zoom = 1

// Force-directed layout (frame-clocked; tuned for a contained, calm-but-alive
// web: strong-enough gravity that the cloud fills the view without most nodes
// escaping to the cull edge, so the population is governed by `fade`/lifetime
// — a fuller web — while anything that does reach the edge is still culled).
const SUBSTEPS = 2
const SIM_DT = 0.45
const REST_LEN = 0.5
const SPRING = 0.05
const REPULSE = 0.09
const REPULSE_SOFT = 0.04 // softening so near-coincident nodes don't blow up
const MAX_FORCE = 0.5
const DAMP = 0.9
const GRAVITY = 0.015 // centering pull so the web stays roughly framed (soft boundary contains the spread)
const BOUND_K = 0.09 // inward spring once a node passes the soft boundary (see simulate)
const BOUND_FRAC = 0.9 // soft boundary sits at this fraction of the view half-extent
const SAFETY_CULL = 2.2 // only cull-by-position this far out (× view half) — a stability net
const SPAWN_JITTER = 0.24 // how far a new node starts from its parent

const PULSE_BASE_SPEED = 0.018 // edge-fraction per frame at pulseSpeed = 1

// Band → base colour (user's mapping: bass red, mid blue, treble green).
const BAND_COLOR: ReadonlyArray<readonly [number, number, number]> = [
  [1.0, 0.15, 0.15], // bass  = red
  [0.2, 0.4, 1.0], // mid   = blue
  [0.2, 1.0, 0.35], // treble = green
]
const BAND_SIGNAL = ['bass', 'mid', 'high'] as const

// --- Pure hash (pulse-emitter selection; see class doc) ---------------------

function hash32(x: number): number {
  x = (x + 0x9e3779b9) >>> 0
  x = x ^ (x >>> 16)
  x = Math.imul(x, 0x7feb352d) >>> 0
  x = x ^ (x >>> 15)
  x = Math.imul(x, 0x846ca68b) >>> 0
  x = x ^ (x >>> 16)
  return x >>> 0
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

interface Node {
  active: boolean
  id: number // monotonic spawn counter — age & "forward" ordering
  x: number
  y: number
  vx: number
  vy: number
  band: number // 0 bass, 1 mid, 2 treble
  spawnT: number // frame.time at spawn (for lifetime/fade)
}

interface Edge {
  a: number // node slot
  b: number // node slot
}

interface Pulse {
  active: boolean
  a: number // from-node slot
  b: number // to-node slot (always the YOUNGER of the pair)
  pos: number // 0..1 along the edge a->b
  r: number
  g: number
  bl: number
  hops: number
}

export class NeuralWebScene implements SceneRuntime {
  meta = { id: 'neuralweb', name: 'Neural Web', family: 'geometry' as const }

  params: ParamSchema[] = [
    { name: 'nodes', label: 'Nodes', min: 1, max: 40, default: 8, step: 1 },
    { name: 'additions', label: 'Additions', min: 1, max: 6, default: 2, step: 1 },
    { name: 'fade', label: 'Fade', min: 2, max: 30, default: 12 },
    { name: 'connectivity', label: 'Connectivity', min: 1, max: 8, default: 3, step: 1 },
    { name: 'zoom', label: 'Zoom', min: 0.5, max: 4, default: 1 },
    { name: 'sensitivity', label: 'Sensitivity', min: 0, max: 1, default: 0.5 },
    { name: 'pulseSpeed', label: 'Pulse speed', min: 0.3, max: 3, default: 1 },
    { name: 'glow', label: 'Glow', min: 0.3, max: 2, default: 1 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu
  private random: Prng = mulberry32(1)

  // Node pool (slot-indexed; `active` marks live slots, freed slots reused).
  private nodes: Node[] = []
  private freeSlots: number[] = []
  private edges: Edge[] = []
  private pulses: Pulse[] = []
  private freePulses: number[] = []

  private nextId = 0
  private seeded = false // seed cluster laid down on the first beat (or first update)
  private fireCounter = 0
  private bandArmed = [true, true, true]
  private bandEnv = [0, 0, 0] // slow per-band baseline for transient (hit) detection

  // GL resources
  private lineProgram!: WebGLProgram
  private pointProgram!: WebGLProgram
  private fadeProgram!: WebGLProgram
  private fadeLoc!: { uFade: WebGLUniformLocation | null }
  private lineVao!: WebGLVertexArrayObject
  private lineVbo!: WebGLBuffer
  private pointVao!: WebGLVertexArrayObject
  private pointVbo!: WebGLBuffer
  private fadeVao!: WebGLVertexArrayObject

  // Scratch CPU buffers (sized once).
  private lineVerts = new Float32Array(MAX_EDGES * 2 * 6) // 2 verts/edge, pos.xy+color.rgba
  private pointVerts = new Float32Array((MAX_NODES + MAX_PULSES) * 7) // pos.xy+color.rgba+size

  // Code layer: editable source per stage.
  private lineSource = LINE_FS
  private pointSource = POINT_FS
  private fadeSource = FADE_FS

  init(gpu: Gpu, seed: number): void {
    this.gpu = gpu
    this.random = mulberry32(seed >>> 0)
    for (const p of this.params) this.values.set(p.name, p.default)

    // Fresh pools.
    this.nodes = []
    this.freeSlots = []
    for (let i = 0; i < MAX_NODES; i++) {
      this.nodes.push({ active: false, id: -1, x: 0, y: 0, vx: 0, vy: 0, band: 0, spawnT: 0 })
      this.freeSlots.push(MAX_NODES - 1 - i) // pop() hands out 0,1,2,... in order
    }
    this.edges = []
    this.pulses = []
    this.freePulses = []
    for (let i = 0; i < MAX_PULSES; i++) {
      this.pulses.push({ active: false, a: 0, b: 0, pos: 0, r: 0, g: 0, bl: 0, hops: 0 })
      this.freePulses.push(MAX_PULSES - 1 - i)
    }
    this.nextId = 0
    this.seeded = false
    this.fireCounter = 0
    this.bandArmed = [true, true, true]
    this.bandEnv = [0, 0, 0]

    this.lineSource = LINE_FS
    this.pointSource = POINT_FS
    this.fadeSource = FADE_FS

    const gl = gpu.gl
    this.lineProgram = gpu.compileProgram(LINE_VS, this.lineSource)
    this.pointProgram = gpu.compileProgram(POINT_VS, this.pointSource)
    this.fadeProgram = gpu.compileProgram(FADE_VS, this.fadeSource)
    this.fadeLoc = { uFade: gl.getUniformLocation(this.fadeProgram, 'uFade') }

    // Line VAO/VBO (edges).
    this.lineVao = gl.createVertexArray()!
    this.lineVbo = gl.createBuffer()!
    gl.bindVertexArray(this.lineVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo)
    gl.bufferData(gl.ARRAY_BUFFER, this.lineVerts.byteLength, gl.DYNAMIC_DRAW)
    {
      const stride = 6 * 4
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0)
      gl.enableVertexAttribArray(1)
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 2 * 4)
    }

    // Point VAO/VBO (nodes + pulses).
    this.pointVao = gl.createVertexArray()!
    this.pointVbo = gl.createBuffer()!
    gl.bindVertexArray(this.pointVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointVbo)
    gl.bufferData(gl.ARRAY_BUFFER, this.pointVerts.byteLength, gl.DYNAMIC_DRAW)
    {
      const stride = 7 * 4
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0)
      gl.enableVertexAttribArray(1)
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 2 * 4)
      gl.enableVertexAttribArray(2)
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 6 * 4)
    }

    // Fade quad (fullscreen triangle).
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

  // --- Spawning ---------------------------------------------------------------

  private allocNode(x: number, y: number, band: number, t: number): number {
    const slot = this.freeSlots.pop()
    if (slot === undefined) return -1
    const n = this.nodes[slot]
    n.active = true
    n.id = this.nextId++
    n.x = x
    n.y = y
    n.vx = 0
    n.vy = 0
    n.band = band
    n.spawnT = t
    return slot
  }

  private addEdge(a: number, b: number): void {
    if (a === b || this.edges.length >= MAX_EDGES) return
    // Dedup (small degree, linear scan is fine).
    for (const e of this.edges) {
      if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) return
    }
    this.edges.push({ a, b })
  }

  /** Connect `slot` to its nearest `count-1` active nodes (excluding itself and
   *  any already-connected), plus it is assumed already wired to its parent by
   *  the caller. Nearest-neighbour scan over the live nodes. */
  private wireNearest(slot: number, count: number): void {
    const me = this.nodes[slot]
    const cand: { s: number; d: number }[] = []
    for (let s = 0; s < MAX_NODES; s++) {
      const o = this.nodes[s]
      if (!o.active || s === slot) continue
      const dx = o.x - me.x
      const dy = o.y - me.y
      cand.push({ s, d: dx * dx + dy * dy })
    }
    cand.sort((p, q) => p.d - q.d)
    let made = 0
    for (const c of cand) {
      if (made >= count) break
      this.addEdge(slot, c.s)
      made++
    }
  }

  /** Lay down the seed cluster near the origin (once). */
  private seedCluster(t: number): void {
    const target = Math.round(clamp(this.getParam('nodes'), 1, 40))
    const conn = Math.round(clamp(this.getParam('connectivity'), 1, 8))
    for (let i = 0; i < target; i++) {
      const ang = this.random() * Math.PI * 2
      const rad = this.random() * 0.8
      const band = Math.floor(this.random() * 3) % 3
      this.allocNode(Math.cos(ang) * rad, Math.sin(ang) * rad, band, t)
    }
    // Wire each seed node to its nearest neighbours.
    for (let s = 0; s < MAX_NODES; s++) {
      if (this.nodes[s].active) this.wireNearest(s, conn - 1 + 1) // parent-less: use `conn` nearest
    }
    this.seeded = true
  }

  /** One beat: spawn `additions` new nodes, each from a random living parent. */
  private spawnBeat(t: number): void {
    const additions = Math.round(clamp(this.getParam('additions'), 1, 6))
    const conn = Math.round(clamp(this.getParam('connectivity'), 1, 8))
    for (let k = 0; k < additions; k++) {
      // Choose a living parent, biased toward the NEWEST nodes so the web grows
      // outward at its frontier (a branching mesh) instead of every node wiring
      // back to the old central core (a star). random()² biases the pick toward
      // index 0 of the id-sorted list = the youngest live node.
      const live: number[] = []
      for (let s = 0; s < MAX_NODES; s++) if (this.nodes[s].active && !this.isFading(s, t)) live.push(s)
      if (live.length === 0) {
        // Everything faded — reseed a lone node at origin so the web can restart.
        this.allocNode((this.random() - 0.5) * 0.4, (this.random() - 0.5) * 0.4, Math.floor(this.random() * 3) % 3, t)
        continue
      }
      live.sort((p, q) => this.nodes[q].id - this.nodes[p].id) // newest first
      const bias = this.random() * this.random()
      const parent = live[Math.floor(bias * live.length) % live.length]
      const p = this.nodes[parent]
      const ang = this.random() * Math.PI * 2
      const band = Math.floor(this.random() * 3) % 3
      const slot = this.allocNode(
        p.x + Math.cos(ang) * SPAWN_JITTER,
        p.y + Math.sin(ang) * SPAWN_JITTER,
        band,
        t,
      )
      if (slot < 0) return // pool full
      this.addEdge(slot, parent) // the node it sprang from
      this.wireNearest(slot, conn - 1) // + the next-nearest neighbours
    }
  }

  // --- Lifetime ---------------------------------------------------------------

  private lifetime(): number {
    return clamp(this.getParam('fade'), 2, 30)
  }
  private isFading(slot: number, t: number): boolean {
    return t - this.nodes[slot].spawnT > this.lifetime()
  }
  /** 1 while alive, ramps 1→0 over FADE_DURATION after lifetime, then culled. */
  private fadeAlpha(slot: number, t: number): number {
    const age = t - this.nodes[slot].spawnT
    const life = this.lifetime()
    if (age <= life) return 1
    const fadeDur = Math.max(1.5, life * 0.35)
    return clamp(1 - (age - life) / fadeDur, 0, 1)
  }

  private cull(t: number, bound: number): void {
    for (let s = 0; s < MAX_NODES; s++) {
      const n = this.nodes[s]
      if (!n.active) continue
      const dead = this.fadeAlpha(s, t) <= 0 || Math.abs(n.x) > bound || Math.abs(n.y) > bound
      if (dead) this.killNode(s)
    }
  }

  private killNode(slot: number): void {
    this.nodes[slot].active = false
    this.freeSlots.push(slot)
    // Remove edges touching this slot, and pulses on them.
    this.edges = this.edges.filter((e) => e.a !== slot && e.b !== slot)
    for (let i = 0; i < this.pulses.length; i++) {
      const pu = this.pulses[i]
      if (pu.active && (pu.a === slot || pu.b === slot)) this.freePulse(i)
    }
  }

  // --- Pulses -----------------------------------------------------------------

  private allocPulse(a: number, b: number, r: number, g: number, bl: number, hops: number): void {
    const i = this.freePulses.pop()
    if (i === undefined) return
    const pu = this.pulses[i]
    pu.active = true
    pu.a = a
    pu.b = b
    pu.pos = 0
    pu.r = r
    pu.g = g
    pu.bl = bl
    pu.hops = hops
  }
  private freePulse(i: number): void {
    if (!this.pulses[i].active) return
    this.pulses[i].active = false
    this.freePulses.push(i)
  }

  /** Emit a pulse of `color` from node `slot` along every FORWARD edge (toward
   *  a strictly younger node). Only living, non-fading nodes emit. */
  private emitForward(slot: number, r: number, g: number, bl: number, hops: number, t: number): void {
    if (!this.nodes[slot].active || this.isFading(slot, t)) return
    const myId = this.nodes[slot].id
    for (const e of this.edges) {
      let other = -1
      if (e.a === slot) other = e.b
      else if (e.b === slot) other = e.a
      else continue
      if (this.nodes[other].active && this.nodes[other].id > myId) {
        this.allocPulse(slot, other, r, g, bl, hops)
      }
    }
  }

  /** A band went loud: fire a few of its living nodes (newest + a hashed
   *  subset), each emitting a forward pulse of the band colour. */
  private fireBand(band: number, t: number): void {
    const [r, g, bl] = BAND_COLOR[band]
    const live: number[] = []
    for (let s = 0; s < MAX_NODES; s++) {
      const n = this.nodes[s]
      if (n.active && n.band === band && !this.isFading(s, t)) live.push(s)
    }
    if (live.length === 0) return
    // Newest of the band always fires; plus up to 2 hashed picks (deterministic,
    // independent of the spawn PRNG — see class doc).
    live.sort((p, q) => this.nodes[q].id - this.nodes[p].id)
    const fired = new Set<number>()
    fired.add(live[0])
    const picks = Math.min(2, live.length - 1)
    for (let k = 0; k < picks; k++) {
      const h = hash32(this.fireCounter * 131 + band * 977 + k * 31)
      fired.add(live[1 + (h % Math.max(1, live.length - 1))])
    }
    this.fireCounter++
    for (const s of fired) this.emitForward(s, r, g, bl, 0, t)
  }

  private updatePulses(): void {
    const speed = PULSE_BASE_SPEED * clamp(this.getParam('pulseSpeed'), 0.3, 3)
    // Snapshot count: children are appended to free slots but we don't want to
    // advance a freshly-emitted child within the same frame (it starts at 0).
    for (let i = 0; i < this.pulses.length; i++) {
      const pu = this.pulses[i]
      if (!pu.active) continue
      pu.pos += speed
      if (pu.pos >= 1) {
        // Arrived at `b`: re-emit forward from there (if it's still a living,
        // non-fading node — checked inside emitForward), then retire.
        this.freePulse(i)
        if (pu.hops + 1 < MAX_HOPS) {
          this.emitForward(pu.b, pu.r, pu.g, pu.bl, pu.hops + 1, this._nowT)
        }
      }
    }
  }

  private _nowT = 0

  update(ctx: FrameContext): void {
    const { frame, signals } = ctx
    const t = frame.time
    this._nowT = t

    if (!this.seeded) this.seedCluster(t)

    // Beat: build the web.
    if (signals.get('beat') > 0.5) this.spawnBeat(t)

    // Band-loudness → pulses. A per-band TRANSIENT detector: each band keeps a
    // slow baseline (bandEnv), and a "hit" is the level jumping above that
    // baseline by more than `rise`. This works across bands with very different
    // resting levels (bass sits high, treble low) where a fixed threshold can't,
    // and fires on musical hits/onsets rather than steady loudness. Sensitivity
    // lowers the jump needed. Armed/disarmed so one swell fires once.
    const sens = clamp(this.getParam('sensitivity'), 0, 1)
    const rise = 0.2 - sens * 0.16 // sens 0..1 -> 0.20..0.04 jump-above-baseline
    for (let band = 0; band < 3; band++) {
      const level = signals.get(BAND_SIGNAL[band])
      this.bandEnv[band] += (level - this.bandEnv[band]) * 0.08 // slow follower
      const jump = level - this.bandEnv[band]
      if (this.bandArmed[band] && jump > rise) {
        this.fireBand(band, t)
        this.bandArmed[band] = false
      } else if (!this.bandArmed[band] && jump < rise * 0.4) {
        this.bandArmed[band] = true
      }
    }

    // Force-directed relaxation (frame-clocked substeps).
    const viewHalfSim = BASE_VIEW * clamp(this.getParam('zoom'), 0.5, 4)
    this.simulate(viewHalfSim * BOUND_FRAC)

    // Advance travelling pulses (re-emit at nodes, forward only).
    this.updatePulses()

    // Cull nodes that faded out (lifetime) — plus a far safety net for anything
    // that somehow escaped the soft boundary. Normal operation culls only by
    // fade, so the web fills the contained area.
    const viewHalf = BASE_VIEW * clamp(this.getParam('zoom'), 0.5, 4)
    this.cull(t, viewHalf * SAFETY_CULL)
  }

  private simulate(softR: number): void {
    for (let step = 0; step < SUBSTEPS; step++) {
      // Repulsion (O(N^2) over live nodes; N bounded by MAX_NODES).
      for (let i = 0; i < MAX_NODES; i++) {
        const a = this.nodes[i]
        if (!a.active) continue
        let fx = -a.x * GRAVITY
        let fy = -a.y * GRAVITY
        // Soft boundary: once a node passes softR from the origin, a spring
        // pulls it back — this CONTAINS the web on screen so its population is
        // set by lifetime, not by nodes escaping and being culled. Zooming out
        // enlarges softR (via viewHalf), giving the web genuinely more room.
        const rr = Math.sqrt(a.x * a.x + a.y * a.y)
        if (rr > softR) {
          const over = (rr - softR) * BOUND_K
          fx -= (a.x / rr) * over
          fy -= (a.y / rr) * over
        }
        for (let j = 0; j < MAX_NODES; j++) {
          if (j === i) continue
          const b = this.nodes[j]
          if (!b.active) continue
          const dx = a.x - b.x
          const dy = a.y - b.y
          const d2 = dx * dx + dy * dy + REPULSE_SOFT
          const dist = Math.sqrt(d2)
          let fmag = REPULSE / d2
          if (fmag > MAX_FORCE) fmag = MAX_FORCE
          fx += (dx / dist) * fmag
          fy += (dy / dist) * fmag
        }
        // stash force in velocity accumulator via temporary fields
        a.vx += fx * SIM_DT
        a.vy += fy * SIM_DT
      }
      // Springs along edges.
      for (const e of this.edges) {
        const a = this.nodes[e.a]
        const b = this.nodes[e.b]
        if (!a.active || !b.active) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const dist = Math.sqrt(dx * dx + dy * dy) + 1e-6
        const f = SPRING * (dist - REST_LEN)
        const ux = dx / dist
        const uy = dy / dist
        a.vx += ux * f * SIM_DT
        a.vy += uy * f * SIM_DT
        b.vx -= ux * f * SIM_DT
        b.vy -= uy * f * SIM_DT
      }
      // Integrate + damp.
      for (let i = 0; i < MAX_NODES; i++) {
        const a = this.nodes[i]
        if (!a.active) continue
        a.vx *= DAMP
        a.vy *= DAMP
        a.x += a.vx * SIM_DT
        a.y += a.vy * SIM_DT
      }
    }
  }

  // --- Render -----------------------------------------------------------------

  render(ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()
    const t = ctx.frame.time
    this._nowT = t

    const viewHalf = BASE_VIEW * clamp(this.getParam('zoom'), 0.5, 4)
    const glow = clamp(this.getParam('glow'), 0.3, 2)
    const aspect = surface.width / surface.height
    const ax = 1 / Math.max(aspect, 1)
    const ay = Math.min(aspect, 1)
    const inv = 1 / viewHalf
    const toNdcX = (x: number) => x * inv * ax
    const toNdcY = (y: number) => y * inv * ay

    // --- Build edge line-list. Edge brightness = min of endpoint fades, tinted
    // by the two node bands (a dim structural web that the pulses light up). ---
    let ln = 0
    for (const e of this.edges) {
      const a = this.nodes[e.a]
      const b = this.nodes[e.b]
      if (!a.active || !b.active) continue
      const fa = this.fadeAlpha(e.a, t)
      const fb = this.fadeAlpha(e.b, t)
      const dim = Math.min(fa, fb) * 0.22 * glow
      const [ar, ag, ab] = BAND_COLOR[a.band]
      const [br, bg, bb] = BAND_COLOR[b.band]
      // endpoint A
      this.lineVerts[ln++] = toNdcX(a.x)
      this.lineVerts[ln++] = toNdcY(a.y)
      this.lineVerts[ln++] = ar * dim
      this.lineVerts[ln++] = ag * dim
      this.lineVerts[ln++] = ab * dim
      this.lineVerts[ln++] = 1
      // endpoint B
      this.lineVerts[ln++] = toNdcX(b.x)
      this.lineVerts[ln++] = toNdcY(b.y)
      this.lineVerts[ln++] = br * dim
      this.lineVerts[ln++] = bg * dim
      this.lineVerts[ln++] = bb * dim
      this.lineVerts[ln++] = 1
    }
    const lineVertCount = ln / 6

    // --- Build point list: nodes (dim, band colour) then pulses (bright). ---
    let pn = 0
    const pushPoint = (x: number, y: number, r: number, g: number, b: number, sz: number) => {
      this.pointVerts[pn++] = x
      this.pointVerts[pn++] = y
      this.pointVerts[pn++] = r
      this.pointVerts[pn++] = g
      this.pointVerts[pn++] = b
      this.pointVerts[pn++] = 1
      this.pointVerts[pn++] = sz
    }
    const nodeSize = clamp(6 / clamp(this.getParam('zoom'), 0.5, 4) + 2, 3, 9)
    for (let s = 0; s < MAX_NODES; s++) {
      const n = this.nodes[s]
      if (!n.active) continue
      const f = this.fadeAlpha(s, t)
      const [r, g, b] = BAND_COLOR[n.band]
      const k = 0.5 * f * glow
      pushPoint(toNdcX(n.x), toNdcY(n.y), r * k, g * k, b * k, nodeSize)
    }
    // Pulses: interpolate along their edge, draw bright.
    const pulseSize = nodeSize * 1.7
    for (const pu of this.pulses) {
      if (!pu.active) continue
      const a = this.nodes[pu.a]
      const b = this.nodes[pu.b]
      if (!a.active || !b.active) continue
      const x = a.x + (b.x - a.x) * pu.pos
      const y = a.y + (b.y - a.y) * pu.pos
      const k = 1.4 * glow
      pushPoint(toNdcX(x), toNdcY(y), pu.r * k, pu.g * k, pu.bl * k, pulseSize)
    }
    const pointCount = pn / 7

    gl.enable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)

    // Fade/trail pass: pulses leave comet streaks; static edges/nodes restamp
    // crisply on top each frame.
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(this.fadeProgram)
    gl.uniform1f(this.fadeLoc.uFade, 0.45)
    gl.bindVertexArray(this.fadeVao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // Edges (additive glow).
    gl.blendFunc(gl.ONE, gl.ONE)
    if (lineVertCount > 0) {
      gl.useProgram(this.lineProgram)
      gl.bindVertexArray(this.lineVao)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.lineVerts, 0, ln)
      gl.drawArrays(gl.LINES, 0, lineVertCount)
    }

    // Nodes + pulses (additive points → colours ADD where they overlap).
    if (pointCount > 0) {
      gl.useProgram(this.pointProgram)
      gl.bindVertexArray(this.pointVao)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pointVbo)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.pointVerts, 0, pn)
      gl.drawArrays(gl.POINTS, 0, pointCount)
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
      { key: 'line-fs', label: 'Edge color (line-fs)', source: this.lineSource },
      { key: 'point-fs', label: 'Node/pulse dot (point-fs)', source: this.pointSource },
      { key: 'fade-fs', label: 'Trail fade (fade-fs)', source: this.fadeSource },
    ]
  }

  setShaderSource(key: string, source: string): void {
    const gl = this.gpu.gl
    switch (key) {
      case 'line-fs': {
        const program = this.gpu.compileProgram(LINE_VS, source)
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
        this.fadeLoc = { uFade: gl.getUniformLocation(program, 'uFade') }
        this.fadeSource = source
        return
      }
      default:
        throw new Error(`Unknown shader stage "${key}" for scene "${this.meta.id}"`)
    }
  }
}
