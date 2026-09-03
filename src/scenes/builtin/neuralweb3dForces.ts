/**
 * Barnes-Hut octree repulsion for neuralweb3d.ts's fixed sub-step force sim.
 *
 * Pure, deterministic, allocation-pooled for the hot path (`build()` +
 * `forceOn()` called once per active body per sub-step, up to MAX_NODES=2000
 * bodies x MAX_STEPS_PER_FRAME sub-steps): node storage is flat typed
 * arrays grown by capacity-doubling (never per-node `push`), leaves bucket
 * up to LEAF_CAPACITY bodies with exact direct summation inside the bucket
 * (cheaper and more accurate than subdividing down to single-occupant
 * leaves), and the traversal stack is a pooled typed array reused across
 * calls — no per-call array/object allocation once capacities settle.
 * Insertion is always ascending body index (the caller's array order) and
 * all accumulation is plain arithmetic — no Maps, no randomness, no
 * wall-clock reads — so two runs over the same input produce bit-identical
 * output.
 *
 * Force law (must match the direct pairwise law it replaces):
 *   fmag = REPULSE / (d^2 + REPULSE_SOFT), clamped to MAX_FORCE per unit,
 *   scaled by min(ramp_a, ramp_b). An approximated cell (opening criterion
 *   s/d < THETA) contributes that same law evaluated once at the cell's
 *   centre of mass, multiplied by the cell's body count — i.e. "one felt
 *   force, N times", not N individually-clamped forces summed. THETA=0.55
 *   keeps a safety margin under the 1/sqrt(3)~=0.577 bound past which a
 *   cell's bounding cube can itself contain the query point.
 */

export interface ForceBody {
  x: number
  y: number
  z: number
  ramp: number
}

export interface RepulsionParams {
  repulse: number
  repulseSoft: number
  maxForce: number
  theta: number
}

const MAX_DEPTH = 24 // guards against runaway recursion on (near-)coincident points
const LEAF_CAPACITY = 12 // bodies per leaf before it splits into 8 children

/**
 * Flat, pooled octree. `build()` inserts `x/y/z/ramp[0..count)` (ascending
 * index order) and reuses prior node-storage arrays, growing them only when
 * a larger tree is needed. `forceOn()` walks the tree for a single query
 * body with the Barnes-Hut opening criterion, using a pooled traversal
 * stack (no allocation per call).
 */
export class RepulsionOctree {
  // Node storage: flat typed arrays, grown by capacity-doubling.
  private nodeCapacity = 0
  private cx = new Float64Array(0)
  private cy = new Float64Array(0)
  private cz = new Float64Array(0)
  private half = new Float64Array(0)
  private mass = new Float64Array(0)
  private comX = new Float64Array(0)
  private comY = new Float64Array(0)
  private comZ = new Float64Array(0)
  private rampSum = new Float64Array(0)
  private child = new Int32Array(0) // 8 slots per node, -1 if absent
  // leafCount[i] >= 0: leaf holding that many bodies in leafBody[i*LEAF_CAPACITY..].
  // leafCount[i] === -1: internal node (subdivided into `child`).
  // leafCount[i] === -2: leaf whose bucket overflowed LEAF_CAPACITY at
  //   MAX_DEPTH (near-coincident points) — bodies live in `leafOverflow[i]`.
  private leafCount = new Int32Array(0)
  private leafBody = new Int32Array(0) // flat, LEAF_CAPACITY slots per node
  private leafOverflow: (number[] | undefined)[] = []
  private nodeCount = 0

  // Body storage: flat typed arrays, sized to the largest build so far.
  private bx = new Float64Array(0)
  private by = new Float64Array(0)
  private bz = new Float64Array(0)
  private bramp = new Float64Array(0)
  private count = 0

  // Pooled traversal stack for forceOn().
  private stack = new Int32Array(64)
  private stackTop = 0

  private ensureNodeCapacity(minCap: number): void {
    if (minCap <= this.nodeCapacity) return
    let cap = Math.max(this.nodeCapacity, 16)
    while (cap < minCap) cap *= 2
    const grow = (arr: Float64Array) => {
      const next = new Float64Array(cap)
      next.set(arr)
      return next
    }
    this.cx = grow(this.cx)
    this.cy = grow(this.cy)
    this.cz = grow(this.cz)
    this.half = grow(this.half)
    this.mass = grow(this.mass)
    this.comX = grow(this.comX)
    this.comY = grow(this.comY)
    this.comZ = grow(this.comZ)
    this.rampSum = grow(this.rampSum)
    const nextChild = new Int32Array(cap * 8).fill(-1)
    nextChild.set(this.child)
    this.child = nextChild
    const nextLeafCount = new Int32Array(cap)
    nextLeafCount.set(this.leafCount)
    this.leafCount = nextLeafCount
    const nextLeafBody = new Int32Array(cap * LEAF_CAPACITY)
    nextLeafBody.set(this.leafBody)
    this.leafBody = nextLeafBody
    this.nodeCapacity = cap
  }

  private ensureBodyCapacity(n: number): void {
    if (n <= this.bx.length) return
    this.bx = new Float64Array(n)
    this.by = new Float64Array(n)
    this.bz = new Float64Array(n)
    this.bramp = new Float64Array(n)
  }

  private ensureStackCapacity(n: number): void {
    if (n <= this.stack.length) return
    let cap = this.stack.length || 64
    while (cap < n) cap *= 2
    const next = new Int32Array(cap)
    next.set(this.stack)
    this.stack = next
  }

  private allocNode(cx: number, cy: number, cz: number, half: number): number {
    const i = this.nodeCount++
    this.ensureNodeCapacity(this.nodeCount)
    this.cx[i] = cx
    this.cy[i] = cy
    this.cz[i] = cz
    this.half[i] = half
    this.mass[i] = 0
    this.comX[i] = 0
    this.comY[i] = 0
    this.comZ[i] = 0
    this.rampSum[i] = 0
    this.leafCount[i] = 0
    const base = i * 8
    for (let k = 0; k < 8; k++) this.child[base + k] = -1
    this.leafOverflow[i] = undefined
    return i
  }

  private octant(nodeIdx: number, px: number, py: number, pz: number): number {
    let k = 0
    if (px >= this.cx[nodeIdx]) k |= 1
    if (py >= this.cy[nodeIdx]) k |= 2
    if (pz >= this.cz[nodeIdx]) k |= 4
    return k
  }

  private childCenter(nodeIdx: number, k: number): [number, number, number, number] {
    const h2 = this.half[nodeIdx] / 2
    const cx = this.cx[nodeIdx] + (k & 1 ? h2 : -h2)
    const cy = this.cy[nodeIdx] + (k & 2 ? h2 : -h2)
    const cz = this.cz[nodeIdx] + (k & 4 ? h2 : -h2)
    return [cx, cy, cz, h2]
  }

  private insertIntoChild(nodeIdx: number, bi: number, depth: number): void {
    const k = this.octant(nodeIdx, this.bx[bi], this.by[bi], this.bz[bi])
    const base = nodeIdx * 8
    let c = this.child[base + k]
    if (c === -1) {
      const [ccx, ccy, ccz, ch] = this.childCenter(nodeIdx, k)
      c = this.allocNode(ccx, ccy, ccz, ch)
      this.child[base + k] = c
    }
    this.insert(c, bi, depth + 1)
  }

  private insert(nodeIdx: number, bi: number, depth: number): void {
    this.mass[nodeIdx] += 1
    this.comX[nodeIdx] += this.bx[bi]
    this.comY[nodeIdx] += this.by[bi]
    this.comZ[nodeIdx] += this.bz[bi]
    this.rampSum[nodeIdx] += this.bramp[bi]

    const lc = this.leafCount[nodeIdx]
    if (lc === -1) {
      // Already internal: descend.
      this.insertIntoChild(nodeIdx, bi, depth)
      return
    }
    if (lc === -2) {
      // Already overflowed at MAX_DEPTH: keep appending here.
      this.leafOverflow[nodeIdx]!.push(bi)
      return
    }
    if (depth >= MAX_DEPTH) {
      // Can't subdivide further — fold everything into an overflow bucket
      // (rare: only (near-)coincident points reach this).
      const bucket = this.leafBody.slice(nodeIdx * LEAF_CAPACITY, nodeIdx * LEAF_CAPACITY + lc)
      const list: number[] = Array.from(bucket)
      list.push(bi)
      this.leafOverflow[nodeIdx] = list
      this.leafCount[nodeIdx] = -2
      return
    }
    if (lc < LEAF_CAPACITY) {
      this.leafBody[nodeIdx * LEAF_CAPACITY + lc] = bi
      this.leafCount[nodeIdx] = lc + 1
      return
    }
    // Bucket full: split into an internal node and redistribute.
    const base = nodeIdx * LEAF_CAPACITY
    this.leafCount[nodeIdx] = -1
    for (let s = 0; s < lc; s++) this.insertIntoChild(nodeIdx, this.leafBody[base + s], depth)
    this.insertIntoChild(nodeIdx, bi, depth)
  }

  /** Build the tree over `x/y/z/ramp[0..count)`, ascending index order. */
  build(x: Float64Array, y: Float64Array, z: Float64Array, ramp: Float64Array, count: number): void {
    this.ensureBodyCapacity(count)
    let minX = Infinity
    let minY = Infinity
    let minZ = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    let maxZ = -Infinity
    for (let i = 0; i < count; i++) {
      const px = x[i]
      const py = y[i]
      const pz = z[i]
      this.bx[i] = px
      this.by[i] = py
      this.bz[i] = pz
      this.bramp[i] = ramp[i]
      if (px < minX) minX = px
      if (px > maxX) maxX = px
      if (py < minY) minY = py
      if (py > maxY) maxY = py
      if (pz < minZ) minZ = pz
      if (pz > maxZ) maxZ = pz
    }
    this.count = count
    this.nodeCount = 0
    if (count === 0) return
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const cz = (minZ + maxZ) / 2
    let half = Math.max(maxX - minX, maxY - minY, maxZ - minZ) / 2
    half = half * 1.001 + 1e-6 // small margin so boundary points never sit exactly on a face
    this.allocNode(cx, cy, cz, half)
    for (let i = 0; i < count; i++) this.insert(0, i, 0)
  }

  private pushStack(v: number): void {
    this.ensureStackCapacity(this.stackTop + 1)
    this.stack[this.stackTop++] = v
  }

  /** Add one body's (index `li` within its leaf list) direct pairwise
   *  contribution onto the running (fx,fy,fz), or return them unmodified if
   *  `bj === bi` (self). */
  private addPairForce(
    px: number,
    py: number,
    pz: number,
    pramp: number,
    bi: number,
    bj: number,
    repulse: number,
    repulseSoft: number,
    maxForce: number,
    acc: [number, number, number],
  ): void {
    if (bj === bi) return
    const dx = px - this.bx[bj]
    const dy = py - this.by[bj]
    const dz = pz - this.bz[bj]
    const d2 = dx * dx + dy * dy + dz * dz + repulseSoft
    const dist = Math.sqrt(d2)
    let fmag = (repulse / d2) * Math.min(pramp, this.bramp[bj])
    if (fmag > maxForce) fmag = maxForce
    acc[0] += (dx / dist) * fmag
    acc[1] += (dy / dist) * fmag
    acc[2] += (dz / dist) * fmag
  }

  /**
   * Accumulate the repulsion force on body `bi` into `out` at
   * `out[outOff]..out[outOff+2]` (fx, fy, fz). `out` is NOT zeroed here —
   * caller owns clearing/accumulating.
   */
  forceOn(bi: number, params: RepulsionParams, out: Float64Array, outOff: number): void {
    if (this.count === 0) return
    const px = this.bx[bi]
    const py = this.by[bi]
    const pz = this.bz[bi]
    const pramp = this.bramp[bi]
    const { repulse, repulseSoft, maxForce, theta } = params

    const acc: [number, number, number] = [0, 0, 0]
    this.stackTop = 0
    this.pushStack(0)
    while (this.stackTop > 0) {
      const nodeIdx = this.stack[--this.stackTop]
      const mass = this.mass[nodeIdx]
      if (mass === 0) continue
      const lc = this.leafCount[nodeIdx]

      if (lc >= 0) {
        // Leaf bucket: exact direct summation over its (<=LEAF_CAPACITY) bodies.
        const base = nodeIdx * LEAF_CAPACITY
        for (let s = 0; s < lc; s++) {
          this.addPairForce(px, py, pz, pramp, bi, this.leafBody[base + s], repulse, repulseSoft, maxForce, acc)
        }
        continue
      }
      if (lc === -2) {
        const list = this.leafOverflow[nodeIdx]!
        for (let s = 0; s < list.length; s++) {
          this.addPairForce(px, py, pz, pramp, bi, list[s], repulse, repulseSoft, maxForce, acc)
        }
        continue
      }

      // Internal node: open (recurse into children) or approximate as one body.
      const comX = this.comX[nodeIdx] / mass
      const comY = this.comY[nodeIdx] / mass
      const comZ = this.comZ[nodeIdx] / mass
      const dx = px - comX
      const dy = py - comY
      const dz = pz - comZ
      const size = this.half[nodeIdx] * 2
      const distRaw2 = dx * dx + dy * dy + dz * dz
      const farEnough = distRaw2 > 1e-12 && size * size < theta * theta * distRaw2

      if (farEnough) {
        const d2 = distRaw2 + repulseSoft
        const dist = Math.sqrt(d2)
        const avgRamp = this.rampSum[nodeIdx] / mass
        let fmag = (repulse / d2) * Math.min(pramp, avgRamp)
        if (fmag > maxForce) fmag = maxForce
        fmag *= mass
        acc[0] += (dx / dist) * fmag
        acc[1] += (dy / dist) * fmag
        acc[2] += (dz / dist) * fmag
        continue
      }
      const base = nodeIdx * 8
      for (let k = 0; k < 8; k++) {
        const c = this.child[base + k]
        if (c !== -1) this.pushStack(c)
      }
    }
    out[outOff] += acc[0]
    out[outOff + 1] += acc[1]
    out[outOff + 2] += acc[2]
  }
}

/**
 * Convenience one-shot entry point (mainly for tests): builds a fresh tree
 * and returns repulsion forces for every body, flattened [fx0,fy0,fz0,fx1,…].
 * Not the hot path — the scene calls `RepulsionOctree` directly with pooled
 * typed arrays; this wrapper allocates for caller convenience.
 */
export function computeRepulsion(bodies: ForceBody[], params: RepulsionParams, tree: RepulsionOctree = new RepulsionOctree()): Float64Array {
  const n = bodies.length
  const x = new Float64Array(n)
  const y = new Float64Array(n)
  const z = new Float64Array(n)
  const ramp = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    x[i] = bodies[i].x
    y[i] = bodies[i].y
    z[i] = bodies[i].z
    ramp[i] = bodies[i].ramp
  }
  tree.build(x, y, z, ramp, n)
  const out = new Float64Array(n * 3)
  for (let i = 0; i < n; i++) tree.forceOn(i, params, out, i * 3)
  return out
}
