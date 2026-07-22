import { expect, test } from '@playwright/test'

/**
 * Golden/behavioral tests for Terrain Mirror (geometry family): Terrain Flight
 * plus a horizon mirror — every terrain line is also drawn reflected across the
 * horizon into the upper half of the screen. See terrain.ts's TerrainMirrorScene
 * (and the base render()'s Pass 2 mirror branch) for the reflection maths.
 *
 * Frame choice: 150 (seed 42), same as Terrain Flight — enough scroll for real
 * relief, so the reflection has actual ridges to mirror rather than a flat field.
 */

const GOLDEN_FRAME = 150

async function boot(page: import('@playwright/test').Page, size?: string) {
  await page.goto(`/?test=1&seed=42&scene=terrainmirror${size ?? ''}`)
  await page.waitForFunction(() => window.__viz !== undefined)
}

async function litInUpperHalf(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas')!
    const gl = canvas.getContext('webgl2')!
    const pixels = new Uint8Array(canvas.width * canvas.height * 4)
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    // WebGL readPixels is bottom-up: rows [height/2 .. height) are the TOP half
    // of the screen — where a horizon reflection must put lit pixels and plain
    // Terrain Flight (terrain sits in the lower half) leaves mostly black.
    let lit = 0
    for (let y = Math.floor(canvas.height / 2); y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4
        if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 30) lit++
      }
    }
    return lit
  })
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
    scene: { id: 'terrainmirror', params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames,
    events: [],
  }
}

// --- Goldens ----------------------------------------------------------------

test('terrainmirror renders deterministically at frame 150', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('terrainmirror-seed42-f150.png')
})

test('terrainmirror composes correctly at 9:16', async ({ page }) => {
  await boot(page, '&w=360&h=640')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('terrainmirror-9x16-f150.png')
})

test('terrainmirror composes correctly at 1:1', async ({ page }) => {
  await boot(page, '&w=480&h=480')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('terrainmirror-1x1-f150.png')
})

// --- The defining behavior: real light in the UPPER half (the reflection) ----

test('terrainmirror lights the upper half (the horizon reflection)', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  // The reflection must put a substantial number of lit pixels above the
  // horizon — the whole point of the scene.
  expect(await litInUpperHalf(page)).toBeGreaterThan(500)
})

test('Reflection=0 removes the upper-half mirror; the lower terrain still renders', async ({
  page,
}) => {
  await boot(page)
  const upperWith = await page.evaluate((n) => {
    window.__viz!.renderFrames(n)
    const canvas = document.querySelector('canvas')!
    const gl = canvas.getContext('webgl2')!
    const px = new Uint8Array(canvas.width * canvas.height * 4)
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px)
    let lit = 0
    for (let y = Math.floor(canvas.height / 2); y < canvas.height; y++)
      for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4
        if (px[i] + px[i + 1] + px[i + 2] > 30) lit++
      }
    return lit
  }, GOLDEN_FRAME)
  expect(upperWith).toBeGreaterThan(500)

  // Turn the reflection off: a fresh boot with reflect=0 from frame 0 (the
  // dimmed mirror verts are all black, so the upper half goes dark) while the
  // whole frame still has the lower terrain lit.
  await boot(page)
  const { upper, total } = await page.evaluate((n) => {
    window.__viz!.setParam('reflect', 0)
    window.__viz!.renderFrames(n)
    const canvas = document.querySelector('canvas')!
    const gl = canvas.getContext('webgl2')!
    const px = new Uint8Array(canvas.width * canvas.height * 4)
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px)
    let upper = 0
    let total = 0
    for (let y = 0; y < canvas.height; y++)
      for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4
        if (px[i] + px[i + 1] + px[i + 2] > 30) {
          total++
          if (y >= Math.floor(canvas.height / 2)) upper++
        }
      }
    return { upper, total }
  }, GOLDEN_FRAME)
  // Reflection off: far less light up top than with it on, and the terrain
  // (lower half) still lit.
  expect(upper).toBeLessThan(upperWith / 2)
  expect(total).toBeGreaterThan(500)
})

// --- Non-blank guards --------------------------------------------------------

test('terrainmirror at 16:9, 9:16, and 1:1 are all non-blank', async ({ page }) => {
  for (const size of ['', '&w=360&h=640', '&w=480&h=480']) {
    await boot(page, size)
    await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
    expect(await litPixelCount(page)).toBeGreaterThan(500)
  }
})

// --- Determinism: loadSession re-init, two runs, byte-identical pixelHash -----

test('terrainmirror replays byte-identically via loadSession across a long scroll', async ({
  page,
}) => {
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
