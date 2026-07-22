import { expect, test } from '@playwright/test'

/**
 * Golden/behavioral tests for Orrery (geometry family wildcard): a visible
 * drawing machine — beat-locked geared arms tracing a persistent ornamental
 * curve while the mechanism itself redraws crisply on top every frame. See
 * orrery.ts's class doc for the maths and the beat-lock/phrase-event
 * discipline.
 *
 * Frame choice: 200 (seed 42, 30fps demo signals = 15 frames/beat at the demo
 * detector's 120bpm, so 200 frames ~= 13.3 beats) — past the default
 * `phrase`=8-beat mark (frame 120), so one phrase/gear-change event has
 * already fired and the trace has had time to accumulate real filigree, per
 * the task's own "let a drawing accumulate" framing.
 */

const GOLDEN_FRAME = 200

async function boot(page: import('@playwright/test').Page, size?: string) {
  await page.goto(`/?test=1&seed=42&scene=orrery${size ?? ''}`)
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

function minimalDoc(durationFrames: number) {
  return {
    version: 1,
    seed: 42,
    fps: 30,
    scene: { id: 'orrery', params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames,
    events: [],
  }
}

// --- Goldens ----------------------------------------------------------------

test('orrery renders deterministically at frame 200', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('orrery-seed42-f200.png')
})

test('orrery composes correctly at 9:16', async ({ page }) => {
  await boot(page, '&w=360&h=640')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('orrery-9x16-f200.png')
})

test('orrery composes correctly at 1:1', async ({ page }) => {
  await boot(page, '&w=480&h=480')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('orrery-1x1-f200.png')
})

// --- Non-blank guards --------------------------------------------------------

test('orrery canvas is not blank', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await litPixelCount(page)).toBeGreaterThan(500)
})

test('orrery at 16:9, 9:16, and 1:1 are all non-blank', async ({ page }) => {
  for (const size of ['', '&w=360&h=640', '&w=480&h=480']) {
    await boot(page, size)
    await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
    expect(await litPixelCount(page)).toBeGreaterThan(500)
  }
})

test('orrery with machineGlow=0 is still non-blank (the trace alone)', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => {
    window.__viz!.setParam('machineGlow', 0)
    window.__viz!.renderFrames(n)
  }, GOLDEN_FRAME)
  expect(await litPixelCount(page)).toBeGreaterThan(500)
})

// --- Determinism: loadSession re-init, two runs, byte-identical pixelHash,
// spanning several beats and at least one phrase (gear-change) event --------

test('orrery replays byte-identically via loadSession across several beats and a phrase event', async ({
  page,
}) => {
  await boot(page)
  // 300 frames @30fps = 10s = 20 demo beats (120bpm) = 2 full default
  // `phrase`=8-beat gear-change events — exercises the escapement blend, the
  // beat counter, and the PRNG's count-based ratio-redraw advance.
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
