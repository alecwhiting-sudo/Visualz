import { mulberry32, type Prng } from '../../core/prng'
import type { Gpu } from '../../gpu/context'
import type { RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'
import { RepulsionOctree } from './neuralweb3dForces'

/**
 * Geometry family: "Neural Web 3D" — a redesign of neuralweb.ts as a 3D graph
 * viewed through an orbiting perspective camera, built to the SCENE CONTRACT
 * (docs/SCENE_CONTRACT.md) from the ground up rather than patched onto it.
 *
 * PARAM SURFACE (post-cull — see task spec): several original knobs turned
 * out to be dead weight for performance and were hard-coded rather than
 * exposed: seed cluster size (8), beat-growth additions (6/beat), orbit rate
 * (0.12 rad/s), connectivity (3, see the constant's comment), and roam
 * (always forward-only now — see below). Master `glow` was removed too
 * (pulseGlow/edgeBright already carry brightness; treat glow as constant 1).
 * `hueBase` + `hue` (spread) were merged into a single `colour` param — see
 * `injectBass` for the mapping. Performable order: splits, colour, hueDrive,
 * hitDrive, pulseGlow, edgeBright, maxNodes, reach, then zoom, streak,
 * sensitivity, pulseSpeed.
 *
 * DIFFERENCES FROM neuralweb.ts (all deliberate — see task spec):
 *  - No node fade/lifetime. Nodes never die of age; growth just stalls once
 *    the active count reaches `maxNodes` (a knob, hard-capped at MAX_NODES).
 *    The only removal path left is the boundary safety cull.
 *  - 3D layout: springs + repulsion (Barnes-Hut octree approximation, see
 *    `neuralweb3dForces.ts`) + centering gravity + a soft spherical
 *    boundary, projected through a slowly orbiting perspective camera
 *    (CPU-side projection into NDC, same vertex format as the 2D scene).
 *    Depth cues: point size ~ 1/depth, brightness dims with depth.
 *  - Pulses split: a pulse arriving at a node re-emits along up to `splits`
 *    OTHER edges (never back the way it came), hash-chosen and hash-counted
 *    so replay stays deterministic. Candidate edges are always restricted to
 *    FORWARD ones — toward a strictly higher node id, i.e. younger nodes,
 *    matching legacy neuralweb.ts's forward rule — at both injection and
 *    every split, so pulses read as travelling outward through the growing
 *    web rather than buzzing in place (the old `roam` knob that relaxed this
 *    has been removed).
 *  - New nodes spawn already at rest length from their parent (not a small
 *    jitter) with zero velocity, and ease in over ~0.5s via a `ramp` factor
 *    that scales both the forces they take part in and their rendered
 *    brightness — a glow-in instead of a spring-loaded pop.
 *  - Audio-reactive pulses: at injection (`injectBass`) a per-hit `power`
 *    (0..1, saturating at 3x the trigger threshold) is stamped on the pulse
 *    and inherited through every re-emission of its cascade — convergence at
 *    a node takes the max power among the winning bucket's arrivals. `hitDrive`
 *    (0 = today's exact behaviour) blends `power` into pulse/streak
 *    brightness, pulse point size, and a per-pulse hop cap (`maxHops`,
 *    computed once at injection from `reach`) so weak hits die shallow and
 *    strong hits run deep. Separately, `hueDrive` (default 0, no-op) blends
 *    each injection's base hue toward one driven by the `centroid` signal
 *    (dark/bassy -> warm, bright -> cool); `centroid` defaults to 0 via
 *    SignalBus's missing-signal fallback when nothing publishes it.
 *  - Repulsion at up to `maxNodes` = 2000 uses a Barnes-Hut octree (opening
 *    criterion s/d < 0.6) instead of all-pairs summation — an approximation
 *    of the same force law, not an exact match; goldens reflect this.
 *
 * SCENE CONTRACT compliance:
 *  - render() is PURE: full opaque clear + redraw from state every call, no
 *    trail/fade quad, no framebuffer feedback (unlike neuralweb.ts, which
 *    still carries one). Two renders with no update() between are byte-
 *    identical.
 *  - The force sim advances via a FIXED virtual sub-step accumulated against
 *    frame.dt (R4) — never a fixed amount per update() call — so 30/60/120fps
 *    land on the same simulated state at the same wall-clock time. Node ramp
 *    advances inside that same fixed sub-step so its trajectory doesn't
 *    depend on display rate. Pulse travel, edge-heat decay, the bass envelope
 *    and the camera's orbit angle are all paced directly by frame.dt (R2).
 *  - Determinism (R3): the spawn PRNG only advances at init()/seed-cluster/
 *    beat-spawn (discrete events); pulse injection and splitting draw from a
 *    pure hash of monotonic counters, independent of the PRNG stream and of
 *    real time.
 *
 * meta.framing = 'bounded': the web is a composed object (like orrery.ts's
 * drawing machine), not a full-bleed field — portrait composition is a
 * per-scene call, not F1/F2's domain-extension rule.
 */

// --- Shaders (unchanged vertex format from neuralweb.ts; no fade stage) -----

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
  // Soft round dot, premultiplied for the additive (ONE,ONE) blend so
  // overlapping light brightens.
  float d = length(gl_PointCoord - vec2(0.5));
  float a = smoothstep(0.5, 0.0, d);
  outColor = vec4(vColor.rgb * a * vColor.a, 1.0);
}`

// --- Model constants ---------------------------------------------------------

const MAX_NODES = 2000
const MAX_EDGES = MAX_NODES * 8
const MAX_PULSES = 4096
const REACH_MAX = 40

// Hard-coded former knobs (see class doc's PARAM SURFACE note).
const SEED_CLUSTER_SIZE = 8
const BEAT_ADDITIONS = 6
const ORBIT_RATE = 0.12 // rad/s
// Reserved tuning lever: user wants to be reminded of this if emerging
// shapes disappoint — raising/lowering wiring density changes web character
// (stringy vs meshy).
const CONNECTIVITY = 3

// Barnes-Hut opening criterion: cells with s/d < THETA are approximated as
// a single body at their centre of mass (see neuralweb3dForces.ts). 0.55
// keeps a safety margin under the 1/sqrt(3)~=0.577 bound past which a
// cell's own bounding cube could contain the query point.
const THETA = 0.55

const BOUND_RADIUS = 3.0 // world half-extent nodes are softly contained within
const SAFETY_CULL = 2.2 // × BOUND_RADIUS: escaped nodes past this are culled

// Force-directed layout — fixed virtual sub-step, accumulated against
// frame.dt (R4), never a fixed amount per update() call.
const FIXED_DT = 1 / 120
const MAX_STEPS_PER_FRAME = 8
const REST_LEN = 0.5
const SPRING = 0.9
const REPULSE = 0.5
const REPULSE_SOFT = 0.05
const MAX_FORCE = 6
const DAMP_PER_SEC = 3.6 // velocity decays as exp(-DAMP_PER_SEC * dt) — higher than the 2D scene, deliberately calmer
const GRAVITY = 0.35
const BOUND_K = 2.2

const SPAWN_RAMP_TIME = 0.5 // seconds for a new node's `ramp` to ease 0 -> 1
const BASS_ENV_RATE = 5.0 // 1/s, dt-paced low-pass on bass; matches old 0.08/frame @ 60fps

// Camera.
const BASE_VIEW = 2.6 // world half-extent reference (matches neuralweb.ts's convention)
const CAM_DIST_K = 2.6 // camera distance = BASE_VIEW * CAM_DIST_K / zoom
const CAM_ELEV = 0.35 // fixed gentle elevation, radians
const FOCAL = 1.6 // pinhole focal length
const NEAR_EPS = 0.15 // clip a point once its view-space depth drops below this

const PULSE_SPEED_PER_SEC = 1.0 // edge-fractions per second at pulseSpeed = 1

// Hue-drive endpoints: dark/bassy -> warm red-orange, bright/high-centroid -> cyan-violet.
const HUE_DARK = 0.02
const HUE_BRIGHT = 0.58

const NODE_R = 0.5
const NODE_G = 0.58
const NODE_B = 0.72

// --- Pure hash (pulse injection/splitting; see class doc) -------------------

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

/** hitDrive=0 -> 1 (today's exact behaviour); hitDrive=1 -> 0.5 at power=0
 *  (dim) up to 2.0 at power=1 (bright). */
function hitBrightness(power: number, hitDrive: number): number {
  return 1 + hitDrive * (0.5 + 1.5 * power - 1)
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
 *  near-white/desaturated pulses. */
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
  z: number
  vx: number
  vy: number
  vz: number
  ramp: number // 0..1, eases in after spawn
}

interface Edge {
  a: number
  b: number
  heat: number // Streak trail warmth, decays per second
  hr: number
  hg: number
  hb: number
}

interface Pulse {
  active: boolean
  a: number // from-node slot
  b: number // to-node slot
  edge: Edge | null
  pos: number // 0..1 along edge a->b
  r: number
  g: number
  bl: number
  hops: number
  power: number // 0..1 hit strength from injection, inherited through re-emission
  maxHops: number // per-pulse hop cap, derived from `reach` and `power` at injection
}

interface Arrival {
  r: number
  g: number
  bl: number
  hops: number
  edge: Edge // the edge this arrival rode in on — excluded from re-emission
  overshoot: number // how far pos ran past 1.0 this step — carried to re-emitted pulses
  power: number
  maxHops: number
}

export class NeuralWeb3DScene implements SceneRuntime {
  meta = { id: 'neuralweb3d', name: 'Neural Web 3D', family: 'geometry' as const, framing: 'bounded' as const }

  params: ParamSchema[] = [
    { name: 'splits', label: 'Splits', min: 1, max: 6, default: 3, step: 1 },
    { name: 'colour', label: 'Colour', min: 0, max: 1, default: 0.6 },
    { name: 'hueDrive', label: 'Hue drive', min: 0, max: 1, default: 0 },
    { name: 'hitDrive', label: 'Hit drive', min: 0, max: 1, default: 0.6 },
    { name: 'pulseGlow', label: 'Pulse glow', min: 0, max: 2.5, default: 1.1 },
    { name: 'edgeBright', label: 'Edge bright', min: 0, max: 1, default: 0.2 },
    { name: 'maxNodes', label: 'Max nodes', min: 100, max: 2000, default: 600, step: 50 },
    { name: 'reach', label: 'Reach', min: 0, max: REACH_MAX, default: 14, step: 1 },
    { name: 'zoom', label: 'Zoom', min: 0.4, max: 3, default: 1 },
    { name: 'streak', label: 'Streak', min: 0, max: 1, default: 0.35 },
    { name: 'sensitivity', label: 'Sensitivity', min: 0, max: 1, default: 0.5 },
    { name: 'pulseSpeed', label: 'Pulse speed', min: 0.3, max: 3, default: 1 },
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
  private activeCount = 0
  private seeded = false
  private bassEnv = 0
  private bassArmed = true
  private injectCounter = 0
  private eventCounter = 0

  // Simulation accumulator (R4: fixed virtual sub-step, paced by frame.dt).
  private simAccum = 0
  // Camera orbit angle — state, advanced only in update() (R2/R3).
  private orbitAngle = 0

  // Pooled Barnes-Hut octree + body buffers, reused across sub-steps (see
  // neuralweb3dForces.ts) — no per-substep object/array allocation once
  // these have grown to MAX_NODES once.
  private repulsionTree = new RepulsionOctree()
  private repulsionSlots = new Int32Array(MAX_NODES)
  private repulsionBX = new Float64Array(MAX_NODES)
  private repulsionBY = new Float64Array(MAX_NODES)
  private repulsionBZ = new Float64Array(MAX_NODES)
  private repulsionBRamp = new Float64Array(MAX_NODES)
  private repulsionForces = new Float64Array(MAX_NODES * 3)

  private lineProgram!: WebGLProgram
  private pointProgram!: WebGLProgram
  private lineVao!: WebGLVertexArrayObject
  private lineVbo!: WebGLBuffer
  private pointVao!: WebGLVertexArrayObject
  private pointVbo!: WebGLBuffer

  // Edges render as camera-facing screen-space quads (2 triangles = 6 verts)
  // rather than gl.LINES, since gl.LINES lineWidth is clamped to 1px on most
  // GPUs — edgeBright's thickness lever (render()) needs real width.
  private lineVerts = new Float32Array(MAX_EDGES * 6 * 6)
  private pointVerts = new Float32Array((MAX_NODES + MAX_PULSES) * 7)

  private lineSource = LINE_FS
  private pointSource = POINT_FS

  init(gpu: Gpu, seed: number): void {
    this.gpu = gpu
    this.random = mulberry32(seed >>> 0)
    for (const p of this.params) this.values.set(p.name, p.default)

    this.nodes = []
    this.freeSlots = []
    for (let i = 0; i < MAX_NODES; i++) {
      this.nodes.push({ active: false, id: -1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ramp: 1 })
      this.freeSlots.push(MAX_NODES - 1 - i)
    }
    this.edges = []
    this.pulses = []
    this.freePulses = []
    for (let i = 0; i < MAX_PULSES; i++) {
      this.pulses.push({ active: false, a: 0, b: 0, edge: null, pos: 0, r: 0, g: 0, bl: 0, hops: 0, power: 0, maxHops: REACH_MAX })
      this.freePulses.push(MAX_PULSES - 1 - i)
    }
    this.nextId = 0
    this.activeCount = 0
    this.seeded = false
    this.bassEnv = 0
    this.bassArmed = true
    this.injectCounter = 0
    this.eventCounter = 0
    this.simAccum = 0
    this.orbitAngle = 0

    this.lineSource = LINE_FS
    this.pointSource = POINT_FS

    const gl = gpu.gl
    this.lineProgram = gpu.compileProgram(LINE_VS, this.lineSource)
    this.pointProgram = gpu.compileProgram(POINT_VS, this.pointSource)

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
    gl.bindVertexArray(null)

    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  setParam(name: string, value: number): void {
    this.values.set(name, value)
  }
  getParam(name: string): number {
    // Debug probes (terrain.ts convention): '#'-prefixed names bypass the
    // params map and expose internal dt-paced state directly, for the
    // fps-equivalence test's state-invariant assertion (not part of the
    // public param schema).
    if (name === '#orbitAngle') return this.orbitAngle
    if (name === '#injections') return this.injectCounter
    if (name === '#activePulses') {
      let n = 0
      for (const pu of this.pulses) if (pu.active) n++
      return n
    }
    return this.values.get(name) ?? 0
  }

  // --- Spawning -----------------------------------------------------------

  private allocNode(x: number, y: number, z: number): number {
    const slot = this.freeSlots.pop()
    if (slot === undefined) return -1
    const n = this.nodes[slot]
    n.active = true
    n.id = this.nextId++
    n.x = x
    n.y = y
    n.z = z
    n.vx = 0
    n.vy = 0
    n.vz = 0
    n.ramp = 0
    this.activeCount++
    return slot
  }

  private addEdge(a: number, b: number): void {
    if (a === b || this.edges.length >= MAX_EDGES) return
    for (const e of this.edges) {
      if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) return
    }
    this.edges.push({ a, b, heat: 0, hr: 0, hg: 0, hb: 0 })
  }

  private edgesOf(slot: number): Edge[] {
    const out: Edge[] = []
    for (const e of this.edges) if (e.a === slot || e.b === slot) out.push(e)
    return out
  }

  private other(e: Edge, slot: number): number {
    return e.a === slot ? e.b : e.a
  }

  /** Forward-only filter (always applied — roam knob removed): keep edges
   *  whose other endpoint has a strictly higher node id than `slot` — toward
   *  younger nodes, matching the legacy neuralweb.ts forward rule. Applied
   *  on top of any no-U-turn exclusion the caller has already done. */
  private forwardOnly(edges: Edge[], slot: number): Edge[] {
    const myId = this.nodes[slot].id
    return edges.filter((e) => this.nodes[this.other(e, slot)].id > myId)
  }

  private wireNearest(slot: number, count: number): void {
    const me = this.nodes[slot]
    const cand: { s: number; d: number }[] = []
    for (let s = 0; s < MAX_NODES; s++) {
      const o = this.nodes[s]
      if (!o.active || s === slot) continue
      const dx = o.x - me.x
      const dy = o.y - me.y
      const dz = o.z - me.z
      cand.push({ s, d: dx * dx + dy * dy + dz * dz })
    }
    cand.sort((p, q) => p.d - q.d)
    let made = 0
    for (const c of cand) {
      if (made >= count) break
      this.addEdge(slot, c.s)
      made++
    }
  }

  /** Uniform-ish direction on the unit sphere from the seeded PRNG. */
  private randomDir(): [number, number, number] {
    const cosT = 2 * this.random() - 1
    const phi = this.random() * Math.PI * 2
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT))
    return [sinT * Math.cos(phi), cosT, sinT * Math.sin(phi)]
  }

  private seedCluster(): void {
    const maxNodes = Math.round(clamp(this.getParam('maxNodes'), 100, MAX_NODES))
    for (let i = 0; i < SEED_CLUSTER_SIZE && this.activeCount < maxNodes; i++) {
      const [dx, dy, dz] = this.randomDir()
      const rad = this.random() * 0.8
      this.allocNode(dx * rad, dy * rad, dz * rad)
    }
    for (let s = 0; s < MAX_NODES; s++) {
      if (this.nodes[s].active) this.wireNearest(s, CONNECTIVITY)
    }
    this.seeded = true
  }

  private spawnBeat(): void {
    const maxNodes = Math.round(clamp(this.getParam('maxNodes'), 100, MAX_NODES))
    for (let k = 0; k < BEAT_ADDITIONS; k++) {
      if (this.activeCount >= maxNodes) return
      const live: number[] = []
      for (let s = 0; s < MAX_NODES; s++) if (this.nodes[s].active) live.push(s)
      if (live.length === 0) {
        const [dx, dy, dz] = this.randomDir()
        this.allocNode(dx * 0.2, dy * 0.2, dz * 0.2)
        continue
      }
      live.sort((p, q) => this.nodes[q].id - this.nodes[p].id) // newest first
      const bias = this.random() * this.random()
      const parent = live[Math.floor(bias * live.length) % live.length]
      const p = this.nodes[parent]
      // Non-springy spawning: place at REST_LEN (not a small jitter), zero
      // velocity — the `ramp` factor (not distance) gives the gentle glow-in.
      const [dx, dy, dz] = this.randomDir()
      const slot = this.allocNode(p.x + dx * REST_LEN, p.y + dy * REST_LEN, p.z + dz * REST_LEN)
      if (slot < 0) return
      this.addEdge(slot, parent)
      this.wireNearest(slot, CONNECTIVITY - 1)
    }
  }

  private cull(): void {
    const bound = BOUND_RADIUS * SAFETY_CULL
    for (let s = 0; s < MAX_NODES; s++) {
      const n = this.nodes[s]
      if (!n.active) continue
      const r2 = n.x * n.x + n.y * n.y + n.z * n.z
      if (r2 > bound * bound) this.killNode(s)
    }
  }

  private killNode(slot: number): void {
    this.nodes[slot].active = false
    this.activeCount--
    this.freeSlots.push(slot)
    this.edges = this.edges.filter((e) => e.a !== slot && e.b !== slot)
    for (let i = 0; i < this.pulses.length; i++) {
      const pu = this.pulses[i]
      if (pu.active && (pu.a === slot || pu.b === slot)) this.freePulse(i)
    }
  }

  // --- Pulses ---------------------------------------------------------------

  private allocPulse(a: number, b: number, edge: Edge, r: number, g: number, bl: number, hops: number, power: number, maxHops: number, startPos = 0): void {
    const i = this.freePulses.pop()
    if (i === undefined) return
    const pu = this.pulses[i]
    pu.active = true
    pu.a = a
    pu.b = b
    pu.edge = edge
    pu.pos = startPos
    pu.r = r
    pu.g = g
    pu.bl = bl
    pu.hops = hops
    pu.power = power
    pu.maxHops = maxHops
  }
  private freePulse(i: number): void {
    if (!this.pulses[i].active) return
    this.pulses[i].active = false
    this.freePulses.push(i)
  }

  /** Hash-deterministic pick of up to `count` edges from `available`, keyed by
   *  `seed` (a pure function of counters — see class doc). */
  private pickEdges(available: Edge[], count: number, seed: number): Edge[] {
    if (available.length === 0) return []
    const scored = available.map((e, i) => ({ e, s: hash32(seed ^ Math.imul(i + 1, 0x2545f491)) }))
    scored.sort((p, q) => p.s - q.s)
    return scored.slice(0, Math.min(count, scored.length)).map((x) => x.e)
  }

  /** A bass hit: inject a pulse into 2-4 living nodes, each leaving along ONE
   *  hash-chosen edge. Node picks + hues + edge choice are a pure hash of the
   *  injection counter (deterministic, decoupled from the spawn PRNG). */
  private injectBass(jump: number, rise: number, centroid: number): void {
    const live: number[] = []
    for (let s = 0; s < MAX_NODES; s++) if (this.nodes[s].active) live.push(s)
    if (live.length === 0) return
    // `colour` combines the old hueBase (0) + hue spread into one knob:
    // saturation and hue-jitter span both scale with it, so colour=0 gives
    // white pulses, mid gives a narrow tinted palette, 1 gives full rainbow.
    const colour = clamp(this.getParam('colour'), 0, 1)
    const hueSpread = colour
    const saturation = clamp(colour * 1.4, 0, 1)
    const hueBase = 0
    const hueDrive = clamp(this.getParam('hueDrive'), 0, 1)
    const hitDrive = clamp(this.getParam('hitDrive'), 0, 1)
    const reach = Math.round(clamp(this.getParam('reach'), 0, REACH_MAX))
    // 0 at the trigger threshold, saturating (1) at 3x threshold.
    const power = clamp((jump - rise) / (rise * 2), 0, 1)
    const hueMixed = hueBase + hueDrive * (HUE_DARK + centroid * (HUE_BRIGHT - HUE_DARK) - hueBase)
    const maxHops = clamp(Math.round(reach * (1 + hitDrive * (0.35 + 0.9 * power - 1))), 1, REACH_MAX)
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
      const edges = this.forwardOnly(this.edgesOf(slot), slot)
      if (edges.length > 0) {
        const chosen = this.pickEdges(edges, 1, hash32(this.injectCounter * 613 + slot * 31 + k * 7))[0]
        const hh = hash32(this.injectCounter * 977 + k * 49297) / 4294967296
        const [r, g, b] = hsv2rgb(hueMixed + hh * hueSpread, saturation, 1) // colour 0 -> white
        this.allocPulse(slot, this.other(chosen, slot), chosen, r, g, b, 0, power, maxHops)
      }
      k++
    }
    this.injectCounter++
  }

  /** Advance pulses by `speed * dt` edge-fraction; at each node they converge
   *  on this frame, resolve the dominant incoming colour and re-emit along up
   *  to `splits` OTHER edges (never back along the edge a winning arrival
   *  came in on), if within `reach`. */
  private updatePulses(dt: number, reach: number, splitsParam: number): void {
    const speed = PULSE_SPEED_PER_SEC * clamp(this.getParam('pulseSpeed'), 0.3, 3) * dt
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
        // Carry the overshoot into the arrival so re-emitted pulses start
        // ahead of 0 — otherwise a hop cascade lags further behind real time
        // at every low-fps step (each hop losing up to a whole `speed` worth
        // of travel).
        const overshoot = clamp(pu.pos - 1, 0, 0.999)
        if (pu.edge) list.push({ r: pu.r, g: pu.g, bl: pu.bl, hops: pu.hops, edge: pu.edge, overshoot, power: pu.power, maxHops: pu.maxHops })
        this.freePulse(i)
      }
    }
    for (const [slot, list] of arrivals) {
      if (!this.nodes[slot].active || list.length === 0) continue
      const counts = new Array(9).fill(0)
      const sumR = new Array(9).fill(0)
      const sumG = new Array(9).fill(0)
      const sumB = new Array(9).fill(0)
      let minHops = Infinity
      let firstOfBucket: Arrival[] = []
      const byBucket: Arrival[][] = Array.from({ length: 9 }, () => [])
      for (const a of list) {
        const bkt = hueBucket(a.r, a.g, a.bl)
        counts[bkt]++
        sumR[bkt] += a.r
        sumG[bkt] += a.g
        sumB[bkt] += a.bl
        byBucket[bkt].push(a)
        if (a.hops < minHops) minHops = a.hops
      }
      let win = 0
      for (let b = 1; b < 9; b++) if (counts[b] > counts[win]) win = b // ties -> lowest bucket
      const n = counts[win]
      const r = sumR[win] / n
      const g = sumG[win] / n
      const bl = sumB[win] / n
      const depth = minHops + 1
      firstOfBucket = byBucket[win]
      const arrivedEdge = firstOfBucket[0].edge
      let overshoot = 0
      let power = 0
      let maxHops = 0
      for (const a of firstOfBucket) {
        if (a.overshoot > overshoot) overshoot = a.overshoot
        if (a.power > power) power = a.power
        if (a.maxHops > maxHops) maxHops = a.maxHops
      }
      if (depth > reach || depth > maxHops) continue

      let available = this.edgesOf(slot).filter((e) => e !== arrivedEdge)
      available = this.forwardOnly(available, slot)
      if (available.length === 0) continue
      this.eventCounter++
      const seed = hash32(slot * 92821 + this.eventCounter * 977 + depth * 131)
      // count each split event varies hash-deterministically around `splits`.
      const jitter = (hash32(seed ^ 0x1234567) % 3) - 1 // -1, 0, +1
      const count = clamp(Math.round(splitsParam + jitter), 1, available.length)
      const chosen = this.pickEdges(available, count, seed)
      for (const e of chosen) {
        this.allocPulse(slot, this.other(e, slot), e, r, g, bl, depth, power, maxHops, overshoot)
      }
    }
  }

  private warmEdges(dt: number): void {
    const streak = clamp(this.getParam('streak'), 0, 1)
    const hitDrive = clamp(this.getParam('hitDrive'), 0, 1)
    const decayPerSec = 0.15 + streak * 0.8 // streak 0 -> fast decay, 1 -> long trail
    const decay = Math.pow(decayPerSec, dt)
    for (const e of this.edges) e.heat *= decay
    for (const pu of this.pulses) {
      if (!pu.active || !pu.edge) continue
      const e = pu.edge
      const k = hitBrightness(pu.power, hitDrive)
      e.heat = 1
      e.hr = pu.r * k
      e.hg = pu.g * k
      e.hb = pu.bl * k
    }
  }

  private simulateStep(dt: number): void {
    // Node ramp: eases 0 -> 1 over SPAWN_RAMP_TIME seconds. Advanced inside the
    // fixed sub-step (not once per update()) so its trajectory is identical at
    // any display rate, matching the force sim it gates.
    for (let s = 0; s < MAX_NODES; s++) {
      const n = this.nodes[s]
      if (n.active && n.ramp < 1) n.ramp = Math.min(1, n.ramp + dt / SPAWN_RAMP_TIME)
    }
    // Barnes-Hut repulsion: build a fresh tree over active nodes (ascending
    // slot order, fixed insertion order — deterministic), then walk it once
    // per node with the s/d < THETA opening criterion. Replaces the old
    // O(N^2) all-pairs sum so maxNodes can reach MAX_NODES (2000) at
    // interactive cost — see neuralweb3dForces.ts.
    let activeN = 0
    for (let i = 0; i < MAX_NODES; i++) {
      const a = this.nodes[i]
      if (!a.active) continue
      this.repulsionSlots[activeN] = i
      this.repulsionBX[activeN] = a.x
      this.repulsionBY[activeN] = a.y
      this.repulsionBZ[activeN] = a.z
      this.repulsionBRamp[activeN] = a.ramp
      activeN++
    }
    this.repulsionTree.build(this.repulsionBX, this.repulsionBY, this.repulsionBZ, this.repulsionBRamp, activeN)
    const repParams = { repulse: REPULSE, repulseSoft: REPULSE_SOFT, maxForce: MAX_FORCE, theta: THETA }
    for (let bi = 0; bi < activeN; bi++) {
      this.repulsionForces[bi * 3] = 0
      this.repulsionForces[bi * 3 + 1] = 0
      this.repulsionForces[bi * 3 + 2] = 0
      this.repulsionTree.forceOn(bi, repParams, this.repulsionForces, bi * 3)
    }

    for (let bi = 0; bi < activeN; bi++) {
      const i = this.repulsionSlots[bi]
      const a = this.nodes[i]
      let fx = -a.x * GRAVITY
      let fy = -a.y * GRAVITY
      let fz = -a.z * GRAVITY
      const rr = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z)
      if (rr > BOUND_RADIUS) {
        const over = (rr - BOUND_RADIUS) * BOUND_K
        fx -= (a.x / rr) * over
        fy -= (a.y / rr) * over
        fz -= (a.z / rr) * over
      }
      fx += this.repulsionForces[bi * 3]
      fy += this.repulsionForces[bi * 3 + 1]
      fz += this.repulsionForces[bi * 3 + 2]
      a.vx += fx * a.ramp * dt
      a.vy += fy * a.ramp * dt
      a.vz += fz * a.ramp * dt
    }
    for (const e of this.edges) {
      const a = this.nodes[e.a]
      const b = this.nodes[e.b]
      if (!a.active || !b.active) continue
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dz = b.z - a.z
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-6
      const effRamp = Math.min(a.ramp, b.ramp)
      const f = SPRING * (dist - REST_LEN) * effRamp
      const ux = dx / dist
      const uy = dy / dist
      const uz = dz / dist
      a.vx += ux * f * dt
      a.vy += uy * f * dt
      a.vz += uz * f * dt
      b.vx -= ux * f * dt
      b.vy -= uy * f * dt
      b.vz -= uz * f * dt
    }
    const dampMul = Math.exp(-DAMP_PER_SEC * dt)
    for (let i = 0; i < MAX_NODES; i++) {
      const a = this.nodes[i]
      if (!a.active) continue
      a.vx *= dampMul
      a.vy *= dampMul
      a.vz *= dampMul
      a.x += a.vx * dt
      a.y += a.vy * dt
      a.z += a.vz * dt
    }
  }

  update(ctx: FrameContext): void {
    const { frame, signals } = ctx
    const dt = frame.dt

    if (!this.seeded) this.seedCluster()

    if (signals.get('beat') > 0.5) this.spawnBeat()

    const sens = clamp(this.getParam('sensitivity'), 0, 1)
    const rise = 0.2 - sens * 0.16
    const bass = signals.get('bass')
    this.bassEnv += (bass - this.bassEnv) * (1 - Math.exp(-BASS_ENV_RATE * dt))
    const jump = bass - this.bassEnv
    if (this.bassArmed && jump > rise) {
      const centroid = clamp(signals.get('centroid'), 0, 1)
      this.injectBass(jump, rise, centroid)
      this.bassArmed = false
    } else if (!this.bassArmed && jump < rise * 0.4) {
      this.bassArmed = true
    }

    // Fixed virtual sub-step accumulator (R4): identical simulated state at
    // the same wall-clock time regardless of how often update() was called.
    // Clamped so a slow/stalled live frame can't build an unbounded backlog
    // that later fast-forwards several seconds' worth of steps at once.
    this.simAccum = Math.min(this.simAccum + dt, MAX_STEPS_PER_FRAME * FIXED_DT)
    let steps = 0
    while (this.simAccum >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      this.simulateStep(FIXED_DT)
      this.simAccum -= FIXED_DT
      steps++
    }

    const reach = Math.round(clamp(this.getParam('reach'), 0, REACH_MAX))
    const splits = clamp(this.getParam('splits'), 1, 6)
    this.updatePulses(dt, reach, splits)
    this.warmEdges(dt)

    this.orbitAngle += ORBIT_RATE * dt

    this.cull()
  }

  // --- Camera / projection ---------------------------------------------------

  private camera(): { eye: [number, number, number]; right: [number, number, number]; up: [number, number, number]; fwd: [number, number, number]; dist: number } {
    const zoom = clamp(this.getParam('zoom'), 0.4, 3)
    const dist = (BASE_VIEW * CAM_DIST_K) / zoom
    const az = this.orbitAngle
    const cosE = Math.cos(CAM_ELEV)
    const sinE = Math.sin(CAM_ELEV)
    const eye: [number, number, number] = [dist * cosE * Math.cos(az), dist * sinE, dist * cosE * Math.sin(az)]
    // forward = normalize(target(origin) - eye)
    const fl = Math.sqrt(eye[0] * eye[0] + eye[1] * eye[1] + eye[2] * eye[2]) || 1
    const fwd: [number, number, number] = [-eye[0] / fl, -eye[1] / fl, -eye[2] / fl]
    const worldUp: [number, number, number] = [0, 1, 0]
    // right = normalize(cross(fwd, worldUp))
    let rx = fwd[1] * worldUp[2] - fwd[2] * worldUp[1]
    let ry = fwd[2] * worldUp[0] - fwd[0] * worldUp[2]
    let rz = fwd[0] * worldUp[1] - fwd[1] * worldUp[0]
    const rl = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1
    rx /= rl
    ry /= rl
    rz /= rl
    // up = cross(right, fwd)
    const ux = ry * fwd[2] - rz * fwd[1]
    const uy = rz * fwd[0] - rx * fwd[2]
    const uz = rx * fwd[1] - ry * fwd[0]
    return { eye, right: [rx, ry, rz], up: [ux, uy, uz], fwd, dist }
  }

  // --- Render -----------------------------------------------------------------

  render(_ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    const streak = clamp(this.getParam('streak'), 0, 1)
    const edgeBright = clamp(this.getParam('edgeBright'), 0, 1)
    const pulseGlow = clamp(this.getParam('pulseGlow'), 0, 2.5)
    const hitDrive = clamp(this.getParam('hitDrive'), 0, 1)
    const aspect = surface.width / surface.height
    const ax = 1 / Math.max(aspect, 1)
    const ay = Math.min(aspect, 1)
    const resScale = Math.max(Math.min(surface.width, surface.height) / 720, 0.5)

    // edgeBright thickens edges in the top half of its range (bottom half is
    // a hairline, matching the old fixed-1px look): up to 3px at max.
    const edgeThicknessPx = edgeBright <= 0.5 ? 1 : 1 + (edgeBright - 0.5) * 2 * 2
    const halfThickPx = edgeThicknessPx / 2
    // pulseGlow scales pulse point SIZE in the top half of its range (bottom
    // half leaves size untouched, only brightness): up to 2x at max (2.5).
    const pulseGlowSizeK = pulseGlow <= 1.25 ? 1 : 1 + (pulseGlow - 1.25) / 1.25

    const cam = this.camera()
    const { eye, right, up, fwd, dist } = cam

    // Project world (x,y,z) -> { ndcX, ndcY, depthNorm, visible }.
    const proj = (x: number, y: number, z: number) => {
      const rx = x - eye[0]
      const ry = y - eye[1]
      const rz = z - eye[2]
      const vx = rx * right[0] + ry * right[1] + rz * right[2]
      const vy = rx * up[0] + ry * up[1] + rz * up[2]
      const vz = rx * fwd[0] + ry * fwd[1] + rz * fwd[2]
      if (vz < NEAR_EPS) return null
      const ndcX = ((FOCAL * vx) / vz) * ax
      const ndcY = ((FOCAL * vy) / vz) * ay
      const depthNorm = clamp((vz - dist * 0.4) / (dist * 1.8), 0, 1)
      return { ndcX, ndcY, vz, depthNorm }
    }

    // --- Edges (screen-space quads, 2 triangles / 6 verts each) ---
    const halfW = surface.width / 2
    const halfH = surface.height / 2
    let ln = 0
    const pushVert = (x: number, y: number, r: number, g: number, b: number) => {
      this.lineVerts[ln++] = x
      this.lineVerts[ln++] = y
      this.lineVerts[ln++] = r
      this.lineVerts[ln++] = g
      this.lineVerts[ln++] = b
      this.lineVerts[ln++] = 1
    }
    for (const e of this.edges) {
      const a = this.nodes[e.a]
      const b = this.nodes[e.b]
      if (!a.active || !b.active) continue
      const pa = proj(a.x, a.y, a.z)
      const pb = proj(b.x, b.y, b.z)
      if (!pa || !pb) continue
      const rampDim = Math.min(a.ramp, b.ramp)
      const depthDim = 1 - 0.65 * Math.max(pa.depthNorm, pb.depthNorm)
      const dim = rampDim * depthDim * edgeBright
      // 1.3 was the legacy heat/pulse-glow ratio at the old fixed pulseGlow=1.1;
      // scale by the same ratio so the trail dims/brightens along with pulseGlow.
      const heat = e.heat * streak * (pulseGlow * (1.3 / 1.1)) * depthDim
      const r = NODE_R * dim + e.hr * heat
      const g = NODE_G * dim + e.hg * heat
      const bb = NODE_B * dim + e.hb * heat

      // Perpendicular offset, computed in device-pixel space so thickness is
      // isotropic regardless of canvas aspect, then converted back to this
      // scene's (aspect-scaled) NDC-like space.
      const dxPix = (pb.ndcX - pa.ndcX) * halfW
      const dyPix = (pb.ndcY - pa.ndcY) * halfH
      const segLen = Math.sqrt(dxPix * dxPix + dyPix * dyPix) || 1
      const nx = (-dyPix / segLen) * halfThickPx
      const ny = (dxPix / segLen) * halfThickPx
      const offX = nx / halfW
      const offY = ny / halfH

      const ax0 = pa.ndcX + offX
      const ay0 = pa.ndcY + offY
      const ax1 = pa.ndcX - offX
      const ay1 = pa.ndcY - offY
      const bx0 = pb.ndcX + offX
      const by0 = pb.ndcY + offY
      const bx1 = pb.ndcX - offX
      const by1 = pb.ndcY - offY

      pushVert(ax0, ay0, r, g, bb)
      pushVert(ax1, ay1, r, g, bb)
      pushVert(bx0, by0, r, g, bb)
      pushVert(ax1, ay1, r, g, bb)
      pushVert(bx1, by1, r, g, bb)
      pushVert(bx0, by0, r, g, bb)
    }
    const lineVertCount = ln / 6

    // --- Points (nodes + travelling pulses) ---
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
    for (let s = 0; s < MAX_NODES; s++) {
      const nd = this.nodes[s]
      if (!nd.active) continue
      const p = proj(nd.x, nd.y, nd.z)
      if (!p) continue
      const depthDim = 1 - 0.65 * p.depthNorm
      const k = 0.6 * nd.ramp * depthDim
      const size = clamp((5 / p.vz) * resScale + 1.5, 1.5, 14)
      pushPoint(p.ndcX, p.ndcY, NODE_R * k, NODE_G * k, NODE_B * k, size)
    }
    for (const pu of this.pulses) {
      if (!pu.active) continue
      const a = this.nodes[pu.a]
      const b = this.nodes[pu.b]
      if (!a.active || !b.active) continue
      const x = a.x + (b.x - a.x) * pu.pos
      const y = a.y + (b.y - a.y) * pu.pos
      const z = a.z + (b.z - a.z) * pu.pos
      const p = proj(x, y, z)
      if (!p) continue
      const depthDim = 1 - 0.65 * p.depthNorm
      const hitK = hitBrightness(pu.power, hitDrive)
      const k = pulseGlow * depthDim * hitK
      const sizeK = 1 + hitDrive * (0.7 + 0.8 * pu.power - 1)
      const size = clamp((8 / p.vz) * resScale + 2, 2, 20) * sizeK * pulseGlowSizeK
      pushPoint(p.ndcX, p.ndcY, pu.r * k, pu.g * k, pu.bl * k, size)
    }
    const pointCount = pn / 7

    gl.enable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)
    gl.blendFunc(gl.ONE, gl.ONE) // additive: overlapping light brightens

    if (lineVertCount > 0) {
      gl.useProgram(this.lineProgram)
      gl.bindVertexArray(this.lineVao)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.lineVerts, 0, ln)
      gl.drawArrays(gl.TRIANGLES, 0, lineVertCount)
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
    gl.deleteVertexArray(this.lineVao)
    gl.deleteBuffer(this.lineVbo)
    gl.deleteVertexArray(this.pointVao)
    gl.deleteBuffer(this.pointVbo)
  }

  getShaderSources(): ShaderStage[] {
    return [
      { key: 'line-fs', label: 'Edge color (line-fs)', source: this.lineSource },
      { key: 'point-fs', label: 'Node/pulse dot (point-fs)', source: this.pointSource },
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
      default:
        throw new Error(`Unknown shader stage "${key}" for scene "${this.meta.id}"`)
    }
  }
}
