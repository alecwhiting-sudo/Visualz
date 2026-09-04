import { expect, test } from '@playwright/test'

/**
 * Swarmalators — a particles-family scene built to the SCENE CONTRACT
 * (docs/SCENE_CONTRACT.md), following neuralweb3d.ts's idiom (CPU orbit
 * camera, additive point sprites, edge-quad trails). Covers goldens +
 * non-blank + replay, plus the contract properties: render() is pure, and
 * the sim advances at the same rate per wall-second at any frame rate.
 */

const GOLDEN_FRAME = 150

async function boot(page: import('@playwright/test').Page, extra?: string) {
  await page.goto(`/?test=1&seed=42&scene=swarmalators${extra ?? ''}`)
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
    scene: { id: 'swarmalators', params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames,
    events: [],
  }
}

// --- Goldens ----------------------------------------------------------------

test('swarmalators renders deterministically at frame 150', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('swarmalators-seed42-f150.png')
})

test('swarmalators composes correctly at 9:16', async ({ page }) => {
  await boot(page, '&w=360&h=640')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('swarmalators-9x16-f150.png')
})

test('swarmalators composes correctly at 1:1', async ({ page }) => {
  await boot(page, '&w=480&h=480')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('swarmalators-1x1-f150.png')
})

// --- Non-blank ----------------------------------------------------------------
// 'bounded' framing (a composed swarm, not a full-bleed field): just assert
// some ink is on screen at every aspect, not band coverage.

test('swarmalators is non-blank at 16:9, 9:16, and 1:1', async ({ page }) => {
  for (const size of ['', '&w=360&h=640', '&w=480&h=480']) {
    await boot(page, size)
    await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
    expect(await litPixelCount(page)).toBeGreaterThan(100)
  }
})

// --- Contract: render() is pure ---------------------------------------------

test('swarmalators render() is pure: re-rendering the same frame is byte-identical', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  const a = await page.evaluate(() => { window.__viz!.rerender(); return window.__viz!.pixelHash() })
  const b = await page.evaluate(() => { window.__viz!.rerender(); return window.__viz!.pixelHash() })
  expect(b).toBe(a)
})

// --- Contract: frame-rate independence (preview == export) ------------------
// Advanced to the same wall-clock time, the model state (#modelTime, #kicks,
// #energy, #K) lands at the same value at 30/60/120fps. Pixel-level equality
// is NOT asserted here — kick timing quantizes to frame boundaries (a bass
// hit or the keep-alive timer crosses its threshold on whichever frame
// boundary lands after it, same class of imprecision as neuralweb3d's own
// fps-equivalence test), so #kicks/#modelTime/#energy/#K are the
// state-invariant proxies instead.

async function stateAtFps(page: import('@playwright/test').Page, fps: number, seconds: number) {
  await boot(page, `&fps=${fps}`)
  await page.evaluate((n) => window.__viz!.renderFrames(n), Math.round(seconds * fps))
  return page.evaluate(() => {
    const v = window.__viz as { getParam(n: string): number }
    return {
      modelTime: v.getParam('#modelTime'),
      kicks: v.getParam('#kicks'),
      energy: v.getParam('#energy'),
      K: v.getParam('#K'),
    }
  })
}

test('swarmalators advances at the same rate at 30/60/120fps', async ({ page }) => {
  const seconds = 4
  const a = await stateAtFps(page, 30, seconds)
  const b = await stateAtFps(page, 60, seconds)
  const c = await stateAtFps(page, 120, seconds)

  expect(b.kicks).toBe(a.kicks)
  expect(c.kicks).toBe(a.kicks)

  expect(Math.abs(b.modelTime - a.modelTime)).toBeLessThanOrEqual(0.11)
  expect(Math.abs(c.modelTime - a.modelTime)).toBeLessThanOrEqual(0.11)

  expect(b.energy).toBeCloseTo(a.energy, 2)
  expect(c.energy).toBeCloseTo(a.energy, 2)
  expect(b.K).toBeCloseTo(a.K, 2)
  expect(c.K).toBeCloseTo(a.K, 2)
})

// --- Determinism: byte-identical replay via loadSession ---------------------

test('swarmalators replays byte-identically via loadSession', async ({ page }) => {
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
