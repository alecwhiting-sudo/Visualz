import { expect, test } from '@playwright/test'

/**
 * Golden/behavioral tests for Terrain Flight (geometry family, the app's first
 * true 3D scene): an endless wireframe landscape scrolling toward a pinhole
 * camera, ridges carved from live band energies. See terrain.ts's class doc
 * for the pure-hash noise + frame-clocked scroll determinism discipline.
 *
 * Frame choice: 150 (seed 42) — enough update()s for the scroll to have
 * spawned several fresh music-carved rows past the pre-filled ring, so the
 * grid shows real relief rather than the flat seed-0 startup field.
 */

const GOLDEN_FRAME = 150

async function boot(page: import('@playwright/test').Page, size?: string) {
  await page.goto(`/?test=1&seed=42&scene=terrain${size ?? ''}`)
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
    scene: { id: 'terrain', params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames,
    events: [],
  }
}

// --- Goldens ----------------------------------------------------------------

test('terrain renders deterministically at frame 150', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('terrain-seed42-f150.png')
})

test('terrain composes correctly at 9:16', async ({ page }) => {
  await boot(page, '&w=360&h=640')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('terrain-9x16-f150.png')
})

test('terrain composes correctly at 1:1', async ({ page }) => {
  await boot(page, '&w=480&h=480')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('terrain-1x1-f150.png')
})

// --- Non-blank guards --------------------------------------------------------

test('terrain canvas is not blank', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await litPixelCount(page)).toBeGreaterThan(500)
})

test('terrain at 16:9, 9:16, and 1:1 are all non-blank', async ({ page }) => {
  for (const size of ['', '&w=360&h=640', '&w=480&h=480']) {
    await boot(page, size)
    await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
    expect(await litPixelCount(page)).toBeGreaterThan(500)
  }
})

// --- Determinism: loadSession re-init, two runs, byte-identical pixelHash,
// spanning enough frames that the scroll has spawned many fresh music rows ---

test('terrain replays byte-identically via loadSession across a long scroll', async ({ page }) => {
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
