import { expect, test } from '@playwright/test'

/**
 * Cymatics (Chladni resonance plate) — a GPU-stateless fullscreen scene built to
 * the SCENE CONTRACT (docs/SCENE_CONTRACT.md). Covers the goldens + non-blank +
 * replay, plus the two contract properties: render() is pure, and the plate
 * resonates at the same rate per wall-second at any frame rate.
 */

const GOLDEN_FRAME = 150

async function boot(page: import('@playwright/test').Page, extra?: string) {
  await page.goto(`/?test=1&seed=42&scene=cymatics${extra ?? ''}`)
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
    scene: { id: 'cymatics', params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames,
    events: [],
  }
}

// --- Goldens ----------------------------------------------------------------

test('cymatics renders deterministically at frame 150', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('cymatics-seed42-f150.png')
})

test('cymatics composes correctly at 9:16', async ({ page }) => {
  await boot(page, '&w=360&h=640')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('cymatics-9x16-f150.png')
})

test('cymatics composes correctly at 1:1', async ({ page }) => {
  await boot(page, '&w=480&h=480')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('cymatics-1x1-f150.png')
})

// --- Non-blank / full-bleed --------------------------------------------------
// The plate field is defined everywhere, so it fills the frame at every aspect:
// a large fraction of pixels are lit, not a centred box.

test('cymatics fills the frame at 16:9, 9:16, and 1:1', async ({ page }) => {
  for (const [size, area] of [
    ['', 640 * 360],
    ['&w=360&h=640', 360 * 640],
    ['&w=480&h=480', 480 * 480],
  ] as const) {
    await boot(page, size)
    await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
    expect(await litPixelCount(page)).toBeGreaterThan(area * 0.1) // clearly full-bleed, not a small box
  }
})

// --- Contract: render() is pure ---------------------------------------------

test('cymatics render() is pure: re-rendering the same frame is byte-identical', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  const a = await page.evaluate(() => { window.__viz!.rerender(); return window.__viz!.pixelHash() })
  const b = await page.evaluate(() => { window.__viz!.rerender(); return window.__viz!.pixelHash() })
  expect(b).toBe(a)
})

// --- Contract: frame-rate independence (preview == export) ------------------
// Advanced to the same wall-clock time, the plate's LFO phase (its resonance
// clock) lands at the same value at 30/60/120fps. A per-CALL advance would make
// 120fps run ~4x as far as 30fps and this would catch it.

async function phaseAtFps(page: import('@playwright/test').Page, fps: number, seconds: number) {
  await boot(page, `&fps=${fps}`)
  await page.evaluate((n) => window.__viz!.renderFrames(n), Math.round(seconds * fps))
  return page.evaluate(() => (window.__viz as { getParam(n: string): number }).getParam('#phase0'))
}

test('cymatics resonates at the same rate at 30/60/120fps', async ({ page }) => {
  const seconds = 4
  const a = await phaseAtFps(page, 30, seconds)
  const b = await phaseAtFps(page, 60, seconds)
  const c = await phaseAtFps(page, 120, seconds)
  expect(b).toBeCloseTo(a, 2)
  expect(c).toBeCloseTo(a, 2)
})

// --- Determinism: byte-identical replay via loadSession ---------------------

test('cymatics replays byte-identically via loadSession', async ({ page }) => {
  await boot(page)
  const doc = minimalDoc(200)
  const h1 = await page.evaluate((d) => {
    window.__viz!.loadSession(d)
    window.__viz!.renderFrames(d.durationFrames)
    return window.__viz!.pixelHash()
  }, doc)
  const h2 = await page.evaluate((d) => {
    window.__viz!.loadSession(d)
    window.__viz!.renderFrames(d.durationFrames)
    return window.__viz!.pixelHash()
  }, doc)
  expect(h2).toBe(h1)
})
