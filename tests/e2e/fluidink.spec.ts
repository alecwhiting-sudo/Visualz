import { expect, test } from '@playwright/test'

/**
 * Fluid Ink — GPU stable-fluids ink, built to the SCENE CONTRACT
 * (docs/SCENE_CONTRACT.md). Goldens at frame 120 (a few seconds in, so bass
 * hits/keep-alive have had time to bloom ink), non-blank + full-bleed at all
 * three aspects, purity, 30/60/120fps equivalence (exact hit count, tightly
 * bounded simTime drift), and byte-identical loadSession replay.
 */

const GOLDEN_FRAME = 120

async function boot(page: import('@playwright/test').Page, extra?: string) {
  await page.goto(`/?test=1&seed=42&scene=fluidink${extra ?? ''}`)
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
    scene: { id: 'fluidink', params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames,
    events: [],
  }
}

// --- Goldens ----------------------------------------------------------------

test('fluidink renders deterministically at frame 120', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('fluidink-seed42-f120.png', { timeout: 20_000 })
})

test('fluidink composes correctly at 9:16', async ({ page }) => {
  await boot(page, '&w=360&h=640')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('fluidink-9x16-f120.png', { timeout: 20_000 })
})

test('fluidink composes correctly at 1:1', async ({ page }) => {
  await boot(page, '&w=480&h=480')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('fluidink-1x1-f120.png', { timeout: 20_000 })
})

// --- Non-blank / full-bleed --------------------------------------------------

test('fluidink shows ink at 16:9, 9:16, and 1:1 (non-blank floor)', async ({ page }) => {
  for (const size of ['', '&w=360&h=640', '&w=480&h=480'] as const) {
    await boot(page, size)
    await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
    expect(await litPixelCount(page)).toBeGreaterThan(500)
  }
})

// --- Contract: render() is pure ---------------------------------------------

test('fluidink render() is pure: re-rendering the same frame is byte-identical', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  const a = await page.evaluate(() => { window.__viz!.rerender(); return window.__viz!.pixelHash() })
  const b = await page.evaluate(() => { window.__viz!.rerender(); return window.__viz!.pixelHash() })
  expect(b).toBe(a)
})

// --- Contract: frame-rate independence (preview == export) ------------------
// Advanced to the same wall-clock time, the deterministic hit count (#hits)
// must match exactly at every fps, and the model-time clock (#simTime) must
// match wall-clock time within one sub-step's worth of drift.

async function probesAtFps(page: import('@playwright/test').Page, fps: number, seconds: number) {
  await boot(page, `&fps=${fps}`)
  await page.evaluate((n) => window.__viz!.renderFrames(n), Math.round(seconds * fps))
  return page.evaluate(() => {
    const v = window.__viz as { getParam(n: string): number }
    return { hits: v.getParam('#hits'), simTime: v.getParam('#simTime') }
  })
}

test('fluidink is frame-rate independent at 30/60/120fps', async ({ page }) => {
  const seconds = 6
  const a = await probesAtFps(page, 30, seconds)
  const b = await probesAtFps(page, 60, seconds)
  const c = await probesAtFps(page, 120, seconds)
  expect(b.hits).toBe(a.hits)
  expect(c.hits).toBe(a.hits)
  const subStep = 1 / 60
  expect(Math.abs(b.simTime - a.simTime)).toBeLessThanOrEqual(subStep + 1e-6)
  expect(Math.abs(c.simTime - a.simTime)).toBeLessThanOrEqual(subStep + 1e-6)
})

// --- Determinism: byte-identical replay via loadSession ---------------------

test('fluidink replays byte-identically via loadSession', async ({ page }) => {
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
