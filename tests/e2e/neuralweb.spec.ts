import { expect, test } from '@playwright/test'

/**
 * Golden/behavioral tests for Neural Web (geometry family): a graph that builds
 * itself to the beat — every beat spawns nodes wired to a parent + nearest
 * neighbours, a force-directed layout spreads them, and band-loudness fires
 * forward-only travelling light pulses that mix additively. See neuralweb.ts's
 * class doc for the determinism discipline (seeded spawns, pure-hash pulse
 * picks, frame-clocked sim).
 *
 * Frame choice: 300 (seed 42, 30fps demo = 120bpm) — ~10s in, past the initial
 * growth so the web is at its dense, contained, pulsing steady state.
 */

const GOLDEN_FRAME = 300

async function boot(page: import('@playwright/test').Page, size?: string) {
  await page.goto(`/?test=1&seed=42&scene=neuralweb${size ?? ''}`)
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
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 40) lit++
    }
    return lit
  })
}

function minimalDoc(durationFrames: number) {
  return {
    version: 1,
    seed: 42,
    fps: 30,
    scene: { id: 'neuralweb', params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames,
    events: [],
  }
}

// --- Goldens ----------------------------------------------------------------

test('neuralweb renders deterministically at frame 300', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('neuralweb-seed42-f300.png')
})

test('neuralweb composes correctly at 9:16', async ({ page }) => {
  await boot(page, '&w=360&h=640')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('neuralweb-9x16-f300.png')
})

test('neuralweb composes correctly at 1:1', async ({ page }) => {
  await boot(page, '&w=480&h=480')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('neuralweb-1x1-f300.png')
})

// --- The web genuinely BUILDS: denser after growth than at the start ---------

test('neuralweb builds up — much denser at frame 300 than frame 20', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => window.__viz!.renderFrames(20))
  const early = await litPixelCount(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n - 20), GOLDEN_FRAME)
  const grown = await litPixelCount(page)
  expect(grown).toBeGreaterThan(early * 2)
  expect(grown).toBeGreaterThan(5000)
})

// --- Non-blank at all three aspects -----------------------------------------

test('neuralweb at 16:9, 9:16, and 1:1 are all non-blank', async ({ page }) => {
  for (const size of ['', '&w=360&h=640', '&w=480&h=480']) {
    await boot(page, size)
    await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
    expect(await litPixelCount(page)).toBeGreaterThan(2000)
  }
})

// --- Determinism: loadSession re-init, two runs, byte-identical pixelHash,
// spanning growth + many spawns + many pulse fires --------------------------

test('neuralweb replays byte-identically via loadSession across 300 frames', async ({ page }) => {
  await boot(page)
  const doc = minimalDoc(300)
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
