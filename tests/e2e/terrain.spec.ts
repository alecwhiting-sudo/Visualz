import { expect, test } from '@playwright/test'

/**
 * Terrain (flat perspective grid) — the first scene built to the SCENE CONTRACT
 * (docs/SCENE_CONTRACT.md). Beyond the usual golden + non-blank + replay checks,
 * this spec asserts the two contract properties that the old Terrain violated:
 *
 *   - render() is PURE — rendering the same frame twice with no update() between
 *     is byte-identical (no trail/framebuffer feedback);
 *   - the scene is FRAME-RATE INDEPENDENT — advanced to the same wall-clock time
 *     at 30/60/120fps it lands in the same place and looks the same, so the
 *     preview matches the export.
 */

const GOLDEN_FRAME = 120

async function boot(page: import('@playwright/test').Page, extra?: string) {
  await page.goto(`/?test=1&seed=42&scene=terrain${extra ?? ''}`)
  await page.waitForFunction(() => window.__viz !== undefined)
}

async function litPixelCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas')!
    const gl = canvas.getContext('webgl2')!
    const px = new Uint8Array(canvas.width * canvas.height * 4)
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px)
    let lit = 0
    for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 30) lit++
    return lit
  })
}

function minimalDoc(durationFrames: number) {
  return {
    version: 1,
    seed: 42,
    fps: 30,
    scene: { id: 'terrain', params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames,
    events: [],
  }
}

// --- Goldens ----------------------------------------------------------------

test('terrain renders deterministically at frame 120', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('terrain-seed42-f120.png')
})

test('terrain composes correctly at 9:16', async ({ page }) => {
  await boot(page, '&w=360&h=640')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('terrain-9x16-f120.png')
})

test('terrain composes correctly at 1:1', async ({ page }) => {
  await boot(page, '&w=480&h=480')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('terrain-1x1-f120.png')
})

// --- Non-blank guards --------------------------------------------------------

test('terrain at 16:9, 9:16, and 1:1 are all non-blank', async ({ page }) => {
  for (const size of ['', '&w=360&h=640', '&w=480&h=480']) {
    await boot(page, size)
    await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
    expect(await litPixelCount(page)).toBeGreaterThan(500)
  }
})

// --- Contract: render() is pure ---------------------------------------------
// Re-rendering the same frame with no update() between must not change a pixel.
// A scene with a trail/fade pass (the old Terrain) fails this: each extra render
// darkens the wake and re-deposits the wires. `rerender()` re-runs render() on
// the current frame without advancing the transport (the frozen-control-tick path).

test('terrain render() is pure: re-rendering the same frame is byte-identical', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  const hashA = await page.evaluate(() => {
    window.__viz!.rerender()
    return window.__viz!.pixelHash()
  })
  const hashB = await page.evaluate(() => {
    window.__viz!.rerender()
    return window.__viz!.pixelHash()
  })
  expect(hashB).toBe(hashA)
})

// --- Contract: frame-rate independence (preview == export) ------------------

async function probeAtFps(page: import('@playwright/test').Page, fps: number, seconds: number) {
  await boot(page, `&fps=${fps}`)
  await page.evaluate((n) => window.__viz!.renderFrames(n), Math.round(seconds * fps))
  return page.evaluate(() => ({
    lit: (() => {
      const canvas = document.querySelector('canvas')!
      const gl = canvas.getContext('webgl2')!
      const px = new Uint8Array(canvas.width * canvas.height * 4)
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px)
      let n = 0
      for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 30) n++
      return n
    })(),
    phase: (window.__viz as { getParam(n: string): number }).getParam('#scrollPhase'),
  }))
}

test('terrain scroll is dt-paced: same position + look at 30/60/120fps at equal wall-clock time', async ({ page }) => {
  // 3.5s × speed 1 × SCROLL_PER_SEC(3) = 10.5 → scrollPhase = 0.5 (mid-cell, NOT
  // a whole number of cycles — so a per-call scroll would land somewhere else and
  // this would catch it, unlike an integer-cycle time).
  const seconds = 3.5
  const a = await probeAtFps(page, 30, seconds)
  const b = await probeAtFps(page, 60, seconds)
  const c = await probeAtFps(page, 120, seconds)
  for (const p of [a, b, c]) expect(p.phase).toBeCloseTo(0.5, 4) // dt-paced position invariant
  for (const p of [a, b, c]) expect(p.lit).toBeGreaterThan(500) // non-blank, no wash-out
  const hi = Math.max(a.lit, b.lit, c.lit)
  const lo = Math.min(a.lit, b.lit, c.lit)
  expect(hi / lo).toBeLessThan(1.1) // same grid, same brightness at every rate
})

// --- Determinism: byte-identical replay via loadSession ---------------------

test('terrain replays byte-identically via loadSession', async ({ page }) => {
  await boot(page)
  const doc = minimalDoc(240)
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
