import { expect, test } from '@playwright/test'

/**
 * Wave Chamber (simulation family) golden/behavioral tests. Structure copied
 * from wildcards.spec.ts (boot helper, litPixelCount, minimalDoc, per-aspect
 * non-blank loop) and grayscott.spec.ts (the `?grid=` test-mode override +
 * 60s screenshot timeout for a ping-pong GPGPU scene, whose first golden
 * frame pays for many accumulated substeps).
 *
 * Perf note: `?grid=128` (setGridSize, see waves.ts) instead of the 384² ship
 * default keeps 3 substeps x 128² comfortably cheap on SwiftShader CI.
 */

const TEST_GRID = 128

async function boot(page: import('@playwright/test').Page, opts: { size?: string; seed?: number } = {}) {
  const seed = opts.seed ?? 42
  const size = opts.size ?? ''
  await page.goto(`/?test=1&seed=${seed}&scene=waves&grid=${TEST_GRID}${size}`)
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

/** Distinct RGB-sum levels present on the canvas — a degenerate "NaN wash"
 * (everything clamped to one uniform color) collapses this to ~1; a healthy
 * interference field spans many levels. */
async function distinctLevelCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas')!
    const gl = canvas.getContext('webgl2')!
    const pixels = new Uint8Array(canvas.width * canvas.height * 4)
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    const levels = new Set<number>()
    for (let i = 0; i < pixels.length; i += 4) levels.add(pixels[i] + pixels[i + 1] + pixels[i + 2])
    return levels.size
  })
}

function minimalDoc(durationFrames: number, seed = 42) {
  return {
    version: 1,
    seed,
    fps: 30,
    scene: { id: 'waves', params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames,
    events: [],
  }
}

// --- Golden: frame 150 (450 substeps), default params — chosen empirically
// (see final report) as a point where the two default emitters' expanding
// rings have both reached steady state and are visibly interfering with
// each other and with the rotated obstacle geometry. -----------------------

test('waves renders deterministically at frame 150', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => window.__viz!.renderFrames(150))
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(150)
  await expect(page.locator('canvas')).toHaveScreenshot('waves-seed42-f150.png', { timeout: 60_000 })
})

test('waves canvas is not blank at frame 150', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => window.__viz!.renderFrames(150))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

// --- Determinism: loadSession re-init, two runs, byte-identical pixelHash --

test('waves replays byte-identically via loadSession at f150', async ({ page }) => {
  await boot(page)
  const doc = minimalDoc(150)
  const hash1 = await page.evaluate((d) => {
    window.__viz!.loadSession(d)
    window.__viz!.renderFrames(150)
    return window.__viz!.pixelHash()
  }, doc)
  const hash2 = await page.evaluate((d) => {
    window.__viz!.loadSession(d)
    window.__viz!.renderFrames(150)
    return window.__viz!.pixelHash()
  }, doc)
  expect(hash2).toBe(hash1)
})

// --- Aspect-aware composition: non-blank at all three export aspects ------

for (const [label, size] of [
  ['16:9', undefined],
  ['9:16', '&w=360&h=640'],
  ['1:1', '&w=480&h=480'],
] as const) {
  test(`waves canvas is not blank at ${label}`, async ({ page }) => {
    await boot(page, { size })
    await page.evaluate(() => window.__viz!.renderFrames(150))
    expect(await litPixelCount(page)).toBeGreaterThan(2000)
  })
}

// --- Extremes: speed=2, damping=0.999, walls=5 must never blow up. The CFL
// clamp on c^2 (waves.ts's C2_MAX) is what makes this safe regardless of
// `speed`; this test is the executable proof. "No NaN wash" is checked two
// ways the harness can actually observe: the field stays non-blank (a
// saturated/NaN field would read either all-black or all-one-color) AND
// spans many distinct brightness levels (a NaN/Inf wash collapses to ~1
// level) AND two independent runs at the same extreme settings are still
// byte-identical (a NaN would make IEEE754 comparisons/hashing diverge
// between driver runs in ways plain damping/CFL-bounded arithmetic can't).
// ----------------------------------------------------------------------------

test('waves stays bounded and finite at extreme speed/damping/walls over 300 frames', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => {
    window.__viz!.setParam('speed', 2)
    window.__viz!.setParam('damping', 0.999)
    window.__viz!.setParam('walls', 5)
  })
  await page.evaluate(() => window.__viz!.renderFrames(300))
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(300)
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
  expect(await distinctLevelCount(page)).toBeGreaterThan(50)

  const hash1 = await page.evaluate(() => window.__viz!.pixelHash())

  await boot(page)
  await page.evaluate(() => {
    window.__viz!.setParam('speed', 2)
    window.__viz!.setParam('damping', 0.999)
    window.__viz!.setParam('walls', 5)
  })
  await page.evaluate(() => window.__viz!.renderFrames(300))
  const hash2 = await page.evaluate(() => window.__viz!.pixelHash())

  expect(hash2).toBe(hash1)
})
