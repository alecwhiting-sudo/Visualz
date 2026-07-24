import { mulberry32, type Prng } from '../../core/prng'
import type { Gpu } from '../../gpu/context'
import type { RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'

/**
 * Geometry family: "Neural Web" — a graph that BUILDS itself to the beat. It
 * starts as a small seed cluster; every beat spawns `additions` new nodes, each
 * springing from a (frontier-biased) living node and wiring to that parent plus
 * its next-nearest neighbours (`connectivity` edges total). A force-directed
 * layout (edges are springs, all nodes repel) spreads the web; a soft boundary
 * keeps it framed on screen (so population is set by `fade`/lifetime, not by
 * nodes escaping), and `zoom` enlarges that boundary for more room to grow.
 * `fade` sets node lifetime: 0 = never fade (the web grows without limit until
 * the O(N^2) sim bogs the CPU), rising toward 1 = ever more rapid death.
 *
 * PULSES OF LIGHT (redesigned): the bass is the single driver. On each bass hit
 * a pulse is injected into 2-4 nodes and travels FORWARD ONLY — along edges
 * toward YOUNGER nodes (higher spawn id) — re-emitting at each node it reaches,
 * so a wavefront ripples through the part of the graph that grew after it.
 * `reach` caps how many nodes deep it propagates (0-40). Any node more than 50%
 * un-faded can host/emit a pulse (so pulses appear in older nodes too, not just
 * fresh ones). `streak` leaves a fading warmth on each edge a pulse rides.
 *
 * COLOUR: `hue` randomises each injected pulse's initial hue (0 = white). When
 * pulses CONVERGE on a node, the re-emitted pulse adopts the DOMINANT incoming
 * colour — the majority by hue, not an additive blend (three arrivals, two blue
 * one red -> blue continues). So colour propagates by consensus through the web.
 *
 * DETERMINISM (ARCHITECTURE.md §1):
 *  - Spawn randomness (seed layout, parent choice, jitter) comes only from the
 *    seeded `random` PRNG, advanced ONLY at init() and on each beat-spawn — a
 *    discrete event (resonance.ts's rule), never per-frame.
 *  - Pulse injection (which nodes fire, their random hue) uses a PURE HASH of
 *    an injection counter, independent of the spawn PRNG, so node layout never
 *    depends on audio loudness history.
 *  - The force sim and pulse travel advance a FIXED amount per update() call
 *    (frame-clocked, like whipline.ts), not scaled by frame.dt; node lifetime is
 *    real seconds off frame.time. So frame N is identical in live and render
 *    mode — verified by a byte-identical loadSession replay test.
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
  // light brightens (the LOGICAL colour of a pulse is resolved by the dominant-
  // colour rule at nodes; this blend is just how the glow accumulates on screen).
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

// With Fade at 0 (no fading) the web grows without an age limit — the O(N^2)
// force sim is what eventually bogs the CPU (the "processor limit" the user
// wants at that extreme). This is the hard ceiling so a runaway can't take the
// whole tab down: growth stalls here rather than crashing.
const MAX_NODES = 1000
const MAX_EDGES = MAX_NODES * 8
const MAX_PULSES = 1600
const REACH_MAX = 40 // the Reach param's ceiling — how many nodes deep a pulse runs

const BASE_VIEW = 2.6 // world half-extent shown on screen at zoom = 1

// Force-directed layout (frame-clocked; contained by a soft boundary).
const SUBSTEPS = 2
const SIM_DT = 0.45
const REST_LEN = 0.5
const SPRING = 0.05
const REPULSE = 0.09
const REPULSE_SOFT = 0.04
const MAX_FORCE = 0.5
const DAMP = 0.9
const GRAVITY = 0.015
const BOUND_K = 0.09
const BOUND_FRAC = 0.9
const SAFETY_CULL = 2.2
const SPAWN_JITTER = 0.24

const PULSE_BASE_SPEED = 0.018 // edge-fraction per frame at pulseSpeed = 1

// The dim neutral colour of the structural web (nodes + edges) — the pulses
// carry all the hue now that nodes are no longer band-typed.
const NODE_R = 0.5
const NODE_G = 0.58
const NODE_B = 0.72

// --- Pure hash (pulse injection; see class doc) -----------------------------

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

function hsv2rgb(h: number, s: number, v: number): [number, number, number] {
  const hp = (((h % 1) + 1) % 1) * 6
  const c = v * s
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hp < 1) { r = c; g = x } else if (hp < 2) { r = x; g = c } else if (hp < 3) { g = c; b = x } else if (hp < 4) { g = x; b = c } else if (hp < 5) { r = x; b = c } else { r = c; b = x }
  const m = v - c
  return [r + m, g + m, b + m]
}

/** Hue bucket for the dominant-colour vote: 8 hue wedges, plus bucket 8 for
 *  near-white/desaturated pulses (so all-white pulses vote together). */
function hueBucket(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const sat = mx <= 1e-6 ? 0 : (mx - mn) / mx
  if (sat < 0.22) return 8
  const d = mx - mn
  let h: number
  if (mx === r) h = ((g - b) / d + 6) % 6
  else if (mx === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h = (((h / 6) % 1) + 1) % 1
  return Math.floor(h * 8) % 8
}

interface Node {
  active: boolean
  id: number
  x: number
  y: number
  vx: number
  vy: number
  spawnT: number
}

interface Edge {
  a: number
  b: number
  // "Warmth" a passing pulse leaves behind (the Streak trail): set toward 1 as a
  // pulse rides the edge, decays each frame, and tints the edge its colour.
  heat: number
  hr: number
  hg: number
  hb: number
}

interface Pulse {
  active: boolean
  a: number // from-node slot
  b: number // to-node slot (always the YOUNGER of the pair)
  edge: Edge | null // the edge this pulse rides (for depositing streak warmth)
  pos: number // 0..1 along edge a->b
  r: number
  g: number
  bl: number
  hops: number // nodes passed through so far
}

interface Arrival {
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
    // Fade: 0 = no fading at all (nodes never die -> the web grows until the
    // sim bogs the CPU), rising toward 1 = ever more aggressive (rapid death).
    { name: 'fade', label: 'Fade', min: 0, max: 1, default: 0.3 },
    { name: 'connectivity', label: 'Connectivity', min: 1, max: 8, default: 3, step: 1 },
    { name: 'zoom', label: 'Zoom', min: 0.5, max: 4, default: 1 },
    { name: 'reach', label: 'Reach', min: 0, max: REACH_MAX, default: 14, step: 1 },
    { name: 'streak', label: 'Streak', min: 0, max: 1, default: 0.35 },
    { name: 'hue', label: 'Hue spread', min: 0, max: 1, default: 0.6 },
    { name: 'sensitivity', label: 'Sensitivity', min: 0, max: 1, default: 0.5 },
    { name: 'pulseSpeed', label: 'Pulse speed', min: 0.3, max: 3, default: 1 },
    { name: 'glow', label: 'Glow', min: 0.3, max: 2, default: 1 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu
  private random: Prng = mulberry32(1)

  private nodes: Node[] = []
  private freeSlots: number[] = []
  private edges: Edge[] = []
  private pulses: Pulse[] = []
  private freePulses: number[] = []

  private nextId = 0
  private seeded = false
  private bassEnv = 0
  private bassArmed = true
  private injectCounter = 0

  private lineProgram!: WebGLProgram
  private pointProgram!: WebGLProgram
  private fadeProgram!: WebGLProgram
  private fadeLoc!: { uFade: WebGLUniformLocation | null }
  private lineVao!: WebGLVertexArrayObject
  private lineVbo!: WebGLBuffer
  private pointVao!: WebGLVertexArrayObject
  private pointVbo!: WebGLBuffer
  private fadeVao!: WebGLVertexArrayObject

  private lineVerts = new Float32Array(MAX_EDGES * 2 * 6)
  private pointVerts = new Float32Array((MAX_NODES + MAX_PULSES) * 7)

  private lineSource = LINE_FS
  private pointSource = POINT_FS
  private fadeSource = FADE_FS

  init(gpu: Gpu, seed: number): void {
    this.gpu = gpu
    this.random = mulberry32(seed >>> 0)
    for (const p of this.params) this.values.set(p.name, p.default)

    this.nodes = []
    this.freeSlots = []
    for (let i = 0; i < MAX_NODES; i++) {
      this.nodes.push({ active: false, id: -1, x: 0, y: 0, vx: 0, vy: 0, spawnT: 0 })
      this.freeSlots.push(MAX_NODES - 1 - i)
    }
    this.edges = []
    this.pulses = []
    this.freePulses = []
    for (let i = 0; i < MAX_PULSES; i++) {
      this.pulses.push({ active: false, a: 0, b: 0, edge: null, pos: 0, r: 0, g: 0, bl: 0, hops: 0 })
      this.freePulses.push(MAX_PULSES - 1 - i)
    }
    this.nextId = 0
    this.seeded = false
    this.bassEnv = 0
    this.bassArmed = true
    this.injectCounter = 0

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
    {
      const stride = 6 * 4
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0)
      gl.enableVertexAttribArray(1)
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 2 * 4)
    }

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

  private allocNode(x: number, y: number, t: number): number {
    const slot = this.freeSlots.pop()
    if (slot === undefined) return -1
    const n = this.nodes[slot]
    n.active = true
    n.id = this.nextId++
    n.x = x
    n.y = y
    n.vx = 0
    n.vy = 0
    n.spawnT = t
    return slot
  }

  private addEdge(a: number, b: number): void {
    if (a === b || this.edges.length >= MAX_EDGES) return
    for (const e of this.edges) {
      if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) return
    }
    this.edges.push({ a, b, heat: 0, hr: 0, hg: 0, hb: 0 })
  }

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

  private seedCluster(t: number): void {
    const target = Math.round(clamp(this.getParam('nodes'), 1, 40))
    const conn = Math.round(clamp(this.getParam('connectivity'), 1, 8))
    for (let i = 0; i < target; i++) {
      const ang = this.random() * Math.PI * 2
      const rad = this.random() * 0.8
      this.allocNode(Math.cos(ang) * rad, Math.sin(ang) * rad, t)
    }
    for (let s = 0; s < MAX_NODES; s++) {
      if (this.nodes[s].active) this.wireNearest(s, conn)
    }
    this.seeded = true
  }

  private spawnBeat(t: number): void {
    const additions = Math.round(clamp(this.getParam('additions'), 1, 6))
    const conn = Math.round(clamp(this.getParam('connectivity'), 1, 8))
    for (let k = 0; k < additions; k++) {
      const live: number[] = []
      for (let s = 0; s < MAX_NODES; s++) if (this.nodes[s].active && !this.isFading(s, t)) live.push(s)
      if (live.length === 0) {
        this.allocNode((this.random() - 0.5) * 0.4, (this.random() - 0.5) * 0.4, t)
        continue
      }
      live.sort((p, q) => this.nodes[q].id - this.nodes[p].id) // newest first
      const bias = this.random() * this.random()
      const parent = live[Math.floor(bias * live.length) % live.length]
      const p = this.nodes[parent]
      const ang = this.random() * Math.PI * 2
      const slot = this.allocNode(p.x + Math.cos(ang) * SPAWN_JITTER, p.y + Math.sin(ang) * SPAWN_JITTER, t)
      if (slot < 0) return
      this.addEdge(slot, parent)
      this.wireNearest(slot, conn - 1)
    }
  }

  // --- Lifetime ---------------------------------------------------------------

  /** Node lifetime in seconds before it starts fading. Fade=0 -> Infinity (no
   *  fading, unbounded growth); rising Fade -> shorter life via a 1/fade curve
   *  (fade=1 -> ~3s rapid death, 0.3 -> 10s, 0.1 -> 30s). */
  private lifetime(): number {
    const f = clamp(this.getParam('fade'), 0, 1)
    if (f < 0.02) return Infinity
    return 3 / f
  }
  private isFading(slot: number, t: number): boolean {
    return t - this.nodes[slot].spawnT > this.lifetime()
  }
  private fadeAlpha(slot: number, t: number): number {
    const age = t - this.nodes[slot].spawnT
    const life = this.lifetime()
    if (age <= life) return 1 // covers life === Infinity (never fades)
    const fadeDur = Math.max(1.5, life * 0.35)
    return clamp(1 - (age - life) / fadeDur, 0, 1)
  }
  /** A node can host / emit a pulse while it is more than 50% un-faded — so
   *  pulses appear in OLDER nodes too, not just fresh ones, right up until a
   *  node is halfway to black. */
  private canEmit(slot: number, t: number): boolean {
    return this.nodes[slot].active && this.fadeAlpha(slot, t) > 0.5
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
    this.edges = this.edges.filter((e) => e.a !== slot && e.b !== slot)
    for (let i = 0; i < this.pulses.length; i++) {
      const pu = this.pulses[i]
      if (pu.active && (pu.a === slot || pu.b === slot)) this.freePulse(i)
    }
  }

  // --- Pulses -----------------------------------------------------------------

  private allocPulse(a: number, b: number, edge: Edge, r: number, g: number, bl: number, hops: number): void {
    const i = this.freePulses.pop()
    if (i === undefined) return
    const pu = this.pulses[i]
    pu.active = true
    pu.a = a
    pu.b = b
    pu.edge = edge
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
   *  a strictly younger node). Only nodes >50% un-faded emit (see canEmit). */
  private emitForward(slot: number, r: number, g: number, bl: number, hops: number, t: number): void {
    if (!this.canEmit(slot, t)) return
    const myId = this.nodes[slot].id
    for (const e of this.edges) {
      let other = -1
      if (e.a === slot) other = e.b
      else if (e.b === slot) other = e.a
      else continue
      if (this.nodes[other].active && this.nodes[other].id > myId) {
        this.allocPulse(slot, other, e, r, g, bl, hops)
      }
    }
  }

  /** A bass hit: inject a pulse into 2-4 living nodes, each with a hue-randomised
   *  (or white) colour, emitting forward. Node picks + hues are a pure hash of
   *  the injection counter (deterministic, decoupled from the spawn PRNG). */
  private injectBass(t: number): void {
    const live: number[] = []
    for (let s = 0; s < MAX_NODES; s++) if (this.canEmit(s, t)) live.push(s)
    if (live.length === 0) return
    const hueSpread = clamp(this.getParam('hue'), 0, 1)
    const count = Math.min(live.length, 2 + (hash32(this.injectCounter * 7 + 13) % 3)) // 2..4
    const picked = new Set<number>()
    let attempts = 0
    while (picked.size < count && attempts < count * 5) {
      const h = hash32(this.injectCounter * 101 + picked.size * 331 + attempts * 17)
      picked.add(live[h % live.length])
      attempts++
    }
    let k = 0
    for (const slot of picked) {
      const hh = hash32(this.injectCounter * 977 + k * 49297) / 4294967296
      const [r, g, b] = hsv2rgb(hh, hueSpread, 1) // hueSpread 0 -> white
      this.emitForward(slot, r, g, b, 0, t)
      k++
    }
    this.injectCounter++
  }

  /** Advance pulses; at each node they CONVERGE on this frame, resolve the
   *  dominant incoming colour and re-emit forward (if within `reach`). */
  private updatePulses(reach: number, t: number): void {
    const speed = PULSE_BASE_SPEED * clamp(this.getParam('pulseSpeed'), 0.3, 3)
    const arrivals = new Map<number, Arrival[]>()
    for (let i = 0; i < this.pulses.length; i++) {
      const pu = this.pulses[i]
      if (!pu.active) continue
      pu.pos += speed
      if (pu.pos >= 1) {
        let list = arrivals.get(pu.b)
        if (!list) {
          list = []
          arrivals.set(pu.b, list)
        }
        list.push({ r: pu.r, g: pu.g, bl: pu.bl, hops: pu.hops })
        this.freePulse(i)
      }
    }
    // Resolve each convergence node: dominant colour by hue-bucket majority.
    for (const [slot, list] of arrivals) {
      if (!this.canEmit(slot, t)) continue
      const counts = new Array(9).fill(0)
      const sumR = new Array(9).fill(0)
      const sumG = new Array(9).fill(0)
      const sumB = new Array(9).fill(0)
      let minHops = Infinity
      for (const a of list) {
        const bkt = hueBucket(a.r, a.g, a.bl)
        counts[bkt]++
        sumR[bkt] += a.r
        sumG[bkt] += a.g
        sumB[bkt] += a.bl
        if (a.hops < minHops) minHops = a.hops
      }
      let win = 0
      for (let b = 1; b < 9; b++) if (counts[b] > counts[win]) win = b // ties -> lowest bucket
      const n = counts[win]
      const r = sumR[win] / n
      const g = sumG[win] / n
      const bl = sumB[win] / n
      const depth = minHops + 1
      if (depth <= reach) this.emitForward(slot, r, g, bl, depth, t)
    }
  }

  update(ctx: FrameContext): void {
    const { frame, signals } = ctx
    const t = frame.time

    if (!this.seeded) this.seedCluster(t)

    if (signals.get('beat') > 0.5) this.spawnBeat(t)

    // Bass hit -> pulse injection (transient detector: bass jumping above its
    // own moving baseline; sensitivity lowers the jump needed).
    const sens = clamp(this.getParam('sensitivity'), 0, 1)
    const rise = 0.2 - sens * 0.16
    const bass = signals.get('bass')
    this.bassEnv += (bass - this.bassEnv) * 0.08
    const jump = bass - this.bassEnv
    if (this.bassArmed && jump > rise) {
      this.injectBass(t)
      this.bassArmed = false
    } else if (!this.bassArmed && jump < rise * 0.4) {
      this.bassArmed = true
    }

    const viewHalfSim = BASE_VIEW * clamp(this.getParam('zoom'), 0.5, 4)
    this.simulate(viewHalfSim * BOUND_FRAC)

    const reach = Math.round(clamp(this.getParam('reach'), 0, REACH_MAX))
    this.updatePulses(reach, t)
    this.warmEdges()

    const viewHalf = BASE_VIEW * clamp(this.getParam('zoom'), 0.5, 4)
    this.cull(t, viewHalf * SAFETY_CULL)
  }

  /** The Streak trail: pulses "warm" the edge they ride. Each frame every edge's
   *  heat decays (slower decay = longer streak), then active pulses re-stamp
   *  their current edge to full heat in their colour. Streak=0 -> heat never
   *  contributes (see render()). Deterministic per-frame float state, reset with
   *  the edges at init(). */
  private warmEdges(): void {
    const streak = clamp(this.getParam('streak'), 0, 1)
    const decay = 0.8 + streak * 0.185 // streak 0 -> 0.80 (fast), 1 -> ~0.985 (long trail)
    for (const e of this.edges) e.heat *= decay
    for (const pu of this.pulses) {
      if (!pu.active || !pu.edge) continue
      const e = pu.edge
      e.heat = 1
      e.hr = pu.r
      e.hg = pu.g
      e.hb = pu.bl
    }
  }

  private simulate(softR: number): void {
    for (let step = 0; step < SUBSTEPS; step++) {
      for (let i = 0; i < MAX_NODES; i++) {
        const a = this.nodes[i]
        if (!a.active) continue
        let fx = -a.x * GRAVITY
        let fy = -a.y * GRAVITY
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
        a.vx += fx * SIM_DT
        a.vy += fy * SIM_DT
      }
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

    const viewHalf = BASE_VIEW * clamp(this.getParam('zoom'), 0.5, 4)
    const glow = clamp(this.getParam('glow'), 0.3, 2)
    const aspect = surface.width / surface.height
    const ax = 1 / Math.max(aspect, 1)
    const ay = Math.min(aspect, 1)
    const inv = 1 / viewHalf
    const toNdcX = (x: number) => x * inv * ax
    const toNdcY = (y: number) => y * inv * ay

    // Edges: dim neutral structural web (brightness = min endpoint fade), plus
    // the Streak trail — a pulse's leftover warmth glows the edge in its colour.
    const streak = clamp(this.getParam('streak'), 0, 1)
    let ln = 0
    for (const e of this.edges) {
      const a = this.nodes[e.a]
      const b = this.nodes[e.b]
      if (!a.active || !b.active) continue
      const dim = Math.min(this.fadeAlpha(e.a, t), this.fadeAlpha(e.b, t)) * 0.2 * glow
      const heat = e.heat * streak * 1.3 * glow // warmed-pathway contribution
      const r = NODE_R * dim + e.hr * heat
      const g = NODE_G * dim + e.hg * heat
      const bb = NODE_B * dim + e.hb * heat
      this.lineVerts[ln++] = toNdcX(a.x)
      this.lineVerts[ln++] = toNdcY(a.y)
      this.lineVerts[ln++] = r
      this.lineVerts[ln++] = g
      this.lineVerts[ln++] = bb
      this.lineVerts[ln++] = 1
      this.lineVerts[ln++] = toNdcX(b.x)
      this.lineVerts[ln++] = toNdcY(b.y)
      this.lineVerts[ln++] = r
      this.lineVerts[ln++] = g
      this.lineVerts[ln++] = bb
      this.lineVerts[ln++] = 1
    }
    const lineVertCount = ln / 6

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
      const nd = this.nodes[s]
      if (!nd.active) continue
      const k = 0.6 * this.fadeAlpha(s, t) * glow
      pushPoint(toNdcX(nd.x), toNdcY(nd.y), NODE_R * k, NODE_G * k, NODE_B * k, nodeSize)
    }
    const pulseSize = nodeSize * 1.7
    for (const pu of this.pulses) {
      if (!pu.active) continue
      const a = this.nodes[pu.a]
      const b = this.nodes[pu.b]
      if (!a.active || !b.active) continue
      const x = a.x + (b.x - a.x) * pu.pos
      const y = a.y + (b.y - a.y) * pu.pos
      const k = 1.1 * glow
      pushPoint(toNdcX(x), toNdcY(y), pu.r * k, pu.g * k, pu.bl * k, pulseSize)
    }
    const pointCount = pn / 7

    gl.enable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)

    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(this.fadeProgram)
    gl.uniform1f(this.fadeLoc.uFade, 0.45)
    gl.bindVertexArray(this.fadeVao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    gl.blendFunc(gl.ONE, gl.ONE)
    if (lineVertCount > 0) {
      gl.useProgram(this.lineProgram)
      gl.bindVertexArray(this.lineVao)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.lineVerts, 0, ln)
      gl.drawArrays(gl.LINES, 0, lineVertCount)
    }
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
