import { expect, test } from '@playwright/test'

/**
 * Physarum (simulation family wildcard) golden/behavioral tests. Same
 * render-mode harness as grayscott.spec.ts/particles.spec.ts, parameterized
 * by `?scene=physarum&count=`.
 *
 * Perf/frame-count notes:
 * - `?count=16384` bakes the "128²" particle-ladder rung (same test-hook
 *   convention as particles.spec.ts's `TEST_COUNT`, reused here because
 *   physarum shares one square grid for agent count AND trail resolution —
 *   see physarum.ts's class doc) instead of the 65536 ("256²") desktop
 *   default, keeping SwiftShader runtime bounded. Each `update()` is only 3
 *   fixed passes (agent step, deposit, diffuse+decay) — cheaper per frame
 *   than grayscott's 16 Euler substeps — but goldens still run several
 *   hundred simulated frames to let the trail network resolve into visible
 *   filaments, so screenshot assertions use a 60s timeout and the golden
 *   tests are marked `test.slow()`.
 * - Golden frame is 200, not the usual 90: this scene needs real simulated
 *   time for agent sensing's positive feedback to carve the initially near-
 *   uniform deposit field into distinct veins (visually confirmed during
 *   tuning — by frame ~60 the field is still a dense, barely-resolved maze;
 *   by frame ~200 clear branching filaments with a dark body / bright glowing
 *   core have separated out, and the network keeps visibly reforming past
 *   that). Empirically checked locally: pattern at f200 and f450 differ
 *   substantially (the "continuously reforms" aesthetic requirement) but f200
 *   alone is already unambiguously organic/filamentary, not noise.
 */

const TEST_COUNT = 16384
const GOLDEN_FRAME = 200

async function boot(
  page: import('@playwright/test').Page,
  opts: { size?: string; seed?: number; count?: number } = {},
) {
  const seed = opts.seed ?? 42
  const count = opts.count ?? TEST_COUNT
  const size = opts.size ?? ''
  await page.goto(`/?test=1&seed=${seed}&scene=physarum&count=${count}${size}`)
  await page.waitForFunction(() => window.__viz !== undefined)
}

async function litPixelCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas')!
    const gl = canvas.getContext('webgl2')!
    const pixels = new Uint8Array(canvas.width * canvas.height * 4)
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    let lit = 0
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 30) lit++
    }
    return lit
  })
}

function minimalDoc(durationFrames: number, seed = 42) {
  return {
    version: 1,
    seed,
    fps: 30,
    scene: { id: 'physarum', params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames,
    events: [],
  }
}

// --- Goldens: frame 200, default params, at 3 aspects -----------------------

test('physarum renders deterministically at frame 200', async ({ page }) => {
  test.slow()
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('physarum-seed42-f200.png', { timeout: 60_000 })
})

test('physarum composes correctly at 9:16', async ({ page }) => {
  test.slow()
  await boot(page, { size: '&w=360&h=640' })
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('physarum-9x16-f200.png', { timeout: 60_000 })
})

test('physarum composes correctly at 1:1', async ({ page }) => {
  test.slow()
  await boot(page, { size: '&w=480&h=480' })
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('physarum-1x1-f200.png', { timeout: 60_000 })
})

// --- Non-blank guards (silent all-black regression), all 3 aspects ---------

test('physarum canvas is not blank at 16:9', async ({ page }) => {
  test.slow()
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

test('physarum canvas is not blank at 9:16', async ({ page }) => {
  test.slow()
  await boot(page, { size: '&w=360&h=640' })
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

test('physarum canvas is not blank at 1:1', async ({ page }) => {
  test.slow()
  await boot(page, { size: '&w=480&h=480' })
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

// --- Determinism: loadSession re-init, two runs, byte-identical pixelHash --

test('physarum replays byte-identically via loadSession at f200', async ({ page }) => {
  test.slow()
  await boot(page)
  const doc = minimalDoc(GOLDEN_FRAME)
  const hash1 = await page.evaluate((d) => {
    window.__viz!.loadSession(d)
    window.__viz!.renderFrames(d.durationFrames)
    return window.__viz!.pixelHash()
  }, doc)
  const hash2 = await page.evaluate((d) => {
    window.__viz!.loadSession(d)
    window.__viz!.renderFrames(d.durationFrames)
    return window.__viz!.pixelHash()
  }, doc)
  expect(hash2).toBe(hash1)
})

// --- Behavioral: live animation, onset scatter, silence non-death, ---------
// --- sustained-bass determinism, seed -> layout, capability check ----------

test('physarum keeps animating (hash at f100 differs from f200)', async ({ page }) => {
  test.slow()
  await boot(page)
  const hash100 = await page.evaluate(() => {
    window.__viz!.renderFrames(100)
    return window.__viz!.pixelHash()
  })
  const hash200 = await page.evaluate(() => {
    window.__viz!.renderFrames(100) // now at frame 200
    return window.__viz!.pixelHash()
  })
  expect(hash200).not.toBe(hash100)
})

// Onset scatter (physarum.ts §AGENT_FS/update()): a fraction of agents re-roll
// to a fresh heading, hashed from (agent id, onset counter uniform) — NOT
// per-agent CPU randomness re-issued per event. setInputSignal holds the
// signal high (persists on the bus) from frame 100 on, drawing one fresh
// scatter seed per held frame (resonance.ts's PRNG-advances-on-onset
// discipline) — still fully deterministic, and must diverge the run from an
// unpulsed baseline of the same length.
test('onset scatter diverges the field from the unpulsed baseline', async ({ page }) => {
  test.slow()
  await boot(page)
  const unpulsed = await page.evaluate((n) => {
    window.__viz!.renderFrames(n)
    return window.__viz!.pixelHash()
  }, GOLDEN_FRAME)

  await boot(page)
  const pulsed = await page.evaluate(() => {
    window.__viz!.renderFrames(100)
    window.__viz!.setInputSignal('onset', 1)
    window.__viz!.renderFrames(100)
    return window.__viz!.pixelHash()
  })

  expect(pulsed).not.toBe(unpulsed)
})

// Silence non-death: with every signal pinned to its 0 fallback (no bass
// deposit-boost, no rms speed-boost, no onset scatter), the network must
// still be alive (not decayed to a blank field) at f200.
test('silence does not kill the network at f200', async ({ page }) => {
  test.slow()
  await boot(page)
  await page.evaluate((n) => {
    for (const name of ['rms', 'bass', 'mid', 'high', 'onset', 'beat', 'onsetStrength']) {
      window.__viz!.setInputSignal(name, 0)
    }
    window.__viz!.renderFrames(n)
  }, GOLDEN_FRAME)
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

// Sustained bass=1 permanently boosts deposit (physarum.ts's BASS_DEPOSIT_GAIN)
// for the whole run. Must stay bounded (non-blank, no NaN blowup) and,
// since nothing else is nondeterministic, byte-identical across two runs.
test('sustained bass=1 stays bounded and deterministic over 300 frames', async ({ page }) => {
  test.slow()
  await boot(page)
  const run1 = await page.evaluate(() => {
    window.__viz!.setInputSignal('bass', 1)
    window.__viz!.renderFrames(300)
    return window.__viz!.pixelHash()
  })
  expect(await litPixelCount(page)).toBeGreaterThan(2000)

  await boot(page)
  const run2 = await page.evaluate(() => {
    window.__viz!.setInputSignal('bass', 1)
    window.__viz!.renderFrames(300)
    return window.__viz!.pixelHash()
  })
  expect(run2).toBe(run1)
})

// Seed -> layout: agent seeding (positions/headings/jitter) is drawn from
// mulberry32(seed), so different seeds must produce a visibly different
// network at the golden frame.
test('different seeds produce different layouts at f200', async ({ page }) => {
  test.slow()
  await boot(page, { seed: 42 })
  const hashSeed42 = await page.evaluate((n) => {
    window.__viz!.renderFrames(n)
    return window.__viz!.pixelHash()
  }, GOLDEN_FRAME)

  await boot(page, { seed: 7 })
  const hashSeed7 = await page.evaluate((n) => {
    window.__viz!.renderFrames(n)
    return window.__viz!.pixelHash()
  }, GOLDEN_FRAME)

  expect(hashSeed7).not.toBe(hashSeed42)
})

// --- Code layer: editable stages + hot-recompile smoke ----------------------

test('physarum exposes exactly the 3 editable stages', async ({ page }) => {
  await boot(page)
  const keys = await page.evaluate(() => window.__viz!.getShaderSources().map((s) => s.key))
  expect(keys).toEqual(['agent-fs', 'trail-fs', 'render-fs'])
})

test('physarum render-fs is editable; bad GLSL keeps last good program', async ({ page }) => {
  test.slow()
  await boot(page)

  const hashA = await page.evaluate(() => {
    window.__viz!.renderFrames(60)
    return window.__viz!.pixelHash()
  })

  const { err: err1, matched } = await page.evaluate(() => {
    const stage = window.__viz!.getShaderSources().find((s) => s.key === 'render-fs')!
    const edited = stage.source.replace('outColor = vec4(clamp(bg + col, 0.0, 1.0), 1.0);', 'outColor = vec4(1.0, 0.0, 0.0, 1.0);')
    return { err: window.__viz!.setShaderSource('render-fs', edited), matched: edited !== stage.source }
  })
  expect(matched).toBe(true)
  expect(err1).toBeNull()

  const hashB = await page.evaluate(() => {
    window.__viz!.renderFrames(10)
    return window.__viz!.pixelHash()
  })
  expect(hashB).not.toBe(hashA)
  expect(await litPixelCount(page)).toBeGreaterThan(2000)

  const err2 = await page.evaluate(() => window.__viz!.setShaderSource('render-fs', 'void main() { syntax'))
  expect(err2).not.toBeNull()
  expect(err2!.toLowerCase()).toContain('error')

  await page.evaluate(() => window.__viz!.renderFrames(10))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

// --- Capability check (ARCHITECTURE.md §3.7): init() throws a message ------
// naming EXT_color_buffer_float when the extension is unavailable, same as
// the particle-family scenes and grayscott.

test('physarum capability check throws naming EXT_color_buffer_float when unavailable', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))

  await page.addInitScript(() => {
    const proto = WebGL2RenderingContext.prototype
    const original = proto.getExtension
    proto.getExtension = function (this: WebGL2RenderingContext, name: string) {
      if (name === 'EXT_color_buffer_float') return null
      return original.call(this, name)
    } as typeof proto.getExtension
  })

  await page.goto(`/?test=1&seed=42&scene=physarum&count=${TEST_COUNT}`)
  await page.waitForLoadState('load')

  expect(pageErrors.some((m) => m.includes('EXT_color_buffer_float'))).toBe(true)
  expect(await page.evaluate(() => window.__viz !== undefined)).toBe(false)
})
