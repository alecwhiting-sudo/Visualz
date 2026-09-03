import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../../src/core/prng'
import { computeRepulsion, RepulsionOctree, type ForceBody, type RepulsionParams } from '../../src/scenes/builtin/neuralweb3dForces'

const PARAMS: RepulsionParams = { repulse: 0.5, repulseSoft: 0.05, maxForce: 6, theta: 0.55 }

function randomBodies(n: number, seed: number): ForceBody[] {
  const rand = mulberry32(seed)
  const bodies: ForceBody[] = []
  for (let i = 0; i < n; i++) {
    bodies.push({
      x: (rand() * 2 - 1) * 3,
      y: (rand() * 2 - 1) * 3,
      z: (rand() * 2 - 1) * 3,
      ramp: 1,
    })
  }
  return bodies
}

function toTypedArrays(bodies: ForceBody[]) {
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
  return { x, y, z, ramp }
}

function bruteForce(bodies: ForceBody[], params: RepulsionParams): Float64Array {
  const out = new Float64Array(bodies.length * 3)
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i]
    let fx = 0
    let fy = 0
    let fz = 0
    for (let j = 0; j < bodies.length; j++) {
      if (j === i) continue
      const b = bodies[j]
      const dx = a.x - b.x
      const dy = a.y - b.y
      const dz = a.z - b.z
      const d2 = dx * dx + dy * dy + dz * dz + params.repulseSoft
      const dist = Math.sqrt(d2)
      let fmag = (params.repulse / d2) * Math.min(a.ramp, b.ramp)
      if (fmag > params.maxForce) fmag = params.maxForce
      fx += (dx / dist) * fmag
      fy += (dy / dist) * fmag
      fz += (dz / dist) * fmag
    }
    out[i * 3] = fx
    out[i * 3 + 1] = fy
    out[i * 3 + 2] = fz
  }
  return out
}

/** One warmed repulsion pass (build + forceOn for every body) over a pooled
 *  tree + pooled output buffer — mirrors the scene's hot-path call shape. */
function onePass(tree: RepulsionOctree, x: Float64Array, y: Float64Array, z: Float64Array, ramp: Float64Array, out: Float64Array): void {
  tree.build(x, y, z, ramp, x.length)
  for (let i = 0; i < x.length; i++) {
    out[i * 3] = 0
    out[i * 3 + 1] = 0
    out[i * 3 + 2] = 0
    tree.forceOn(i, PARAMS, out, i * 3)
  }
}

/** Median wall-clock ms for `passes` warmed repetitions, after `warmup`
 *  untimed repetitions to let JIT/inline caches settle. */
function medianPassMs(n: number, seed: number, warmup: number, passes: number): number {
  const bodies = randomBodies(n, seed)
  const { x, y, z, ramp } = toTypedArrays(bodies)
  const tree = new RepulsionOctree()
  const out = new Float64Array(n * 3)
  for (let i = 0; i < warmup; i++) onePass(tree, x, y, z, ramp, out)
  const times: number[] = []
  for (let i = 0; i < passes; i++) {
    const t0 = Date.now()
    onePass(tree, x, y, z, ramp, out)
    times.push(Date.now() - t0)
  }
  times.sort((a, b) => a - b)
  return times[Math.floor(times.length / 2)]
}

describe('neuralweb3d Barnes-Hut repulsion', () => {
  it('is deterministic: two runs over the same input match exactly', () => {
    const bodies = randomBodies(300, 7)
    const a = computeRepulsion(bodies, PARAMS)
    const b = computeRepulsion(bodies, PARAMS)
    expect(a).toEqual(b)
  })

  it('matches brute-force pairwise forces within 5% RMS relative error (~200 bodies)', () => {
    const bodies = randomBodies(200, 42)
    const approx = computeRepulsion(bodies, PARAMS)
    const exact = bruteForce(bodies, PARAMS)

    let sumSqErr = 0
    let sumSqRef = 0
    for (let i = 0; i < bodies.length; i++) {
      for (let k = 0; k < 3; k++) {
        const diff = approx[i * 3 + k] - exact[i * 3 + k]
        sumSqErr += diff * diff
        sumSqRef += exact[i * 3 + k] * exact[i * 3 + k]
      }
    }
    const rmsRelError = Math.sqrt(sumSqErr / sumSqRef)
    expect(rmsRelError).toBeLessThan(0.05)
  })

  it('handles 2000 bodies in well under 100ms per repulsion pass (rough perf sanity, cold)', () => {
    const bodies = randomBodies(2000, 99)
    const { x, y, z, ramp } = toTypedArrays(bodies)
    const tree = new RepulsionOctree()
    const out = new Float64Array(bodies.length * 3)
    const start = Date.now()
    onePass(tree, x, y, z, ramp, out)
    const elapsed = Date.now() - start
    // eslint-disable-next-line no-console
    console.log(`[neuralweb3dOctree perf] 2000-body repulsion pass (cold, 1 sample): ${elapsed}ms`)
    expect(elapsed).toBeLessThan(100)
    let nonZero = 0
    for (const v of out) if (v !== 0) nonZero++
    expect(nonZero).toBeGreaterThan(0)
  })

  it('warmed median pass time at 600 and 2000 bodies (pooled tree, reported for the architect)', () => {
    const at600 = medianPassMs(600, 100, 5, 15)
    const at2000 = medianPassMs(2000, 101, 5, 15)
    // eslint-disable-next-line no-console
    console.log(`[neuralweb3dOctree perf] warmed median ms/pass — 600 bodies: ${at600}ms, 2000 bodies: ${at2000}ms`)
    expect(at600).toBeLessThan(50)
    expect(at2000).toBeLessThan(100)
  })

  it('a pooled tree instance produces identical results across repeated builds', () => {
    const bodies = randomBodies(150, 11)
    const { x, y, z, ramp } = toTypedArrays(bodies)
    const tree = new RepulsionOctree()
    const out1 = new Float64Array(bodies.length * 3)
    onePass(tree, x, y, z, ramp, out1)

    // Rebuild with the same bodies (pooled arrays reused).
    const out2 = new Float64Array(bodies.length * 3)
    onePass(tree, x, y, z, ramp, out2)

    expect(out2).toEqual(out1)
  })
})
