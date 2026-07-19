import { expect, test } from '@playwright/test'

/**
 * Golden/behavioral tests for Orbit Dive (geometry family): "another
 * Mandelbrot dive, controlled differently" — a continuous Mandelbrot/Burning
 * Ship/Tricorn family morph whose escape orbits are tested each iteration
 * against a geometric orbit trap (point/cross/circle/rotating-line, also
 * continuously morphed), so the minimum orbit-to-trap distance paints
 * luminous filigree veins through the escape bands and interior — the star
 * of the scene, and the thing that visually distinguishes it from
 * mandeldive.ts's plain escape-count banding. GPU-stateless single
 * fullscreen-fragment scene, same pattern as mandeldive.spec.ts/
 * fractallab.spec.ts.
 *
 * Frame choice: frame 150 (per the task brief's "~frame-150" note) was
 * checked against mandeldive.spec.ts's caution about "boring near-1x"
 * frames. Orbit Dive's default diveSpeed (0.35) is ~4x mandeldive's default
 * (0.09) and isn't bass-modulated, so divePhase = diveSpeed * t already
 * reaches 0.35 * 5s = 1.75 rad by frame 150 (30fps) — solidly past the
 * pi/2 (~1.57 rad) mid-breath point, well into zoomed territory (zoomLog
 * fraction (0.5 - 0.5*cos(1.75)) ~= 0.59 of the log range, i.e. tens-of-x
 * magnification), so frame 150 is not a boring unzoomed frame here the way
 * it would be for mandeldive at its own default. Confirmed visually (see
 * the checked-in golden PNGs) that frame 150 shows clear zoomed boundary
 * detail with the orbit-trap filigree woven through both the escape bands
 * and the interior.
 */

const GOLDEN_FRAME = 150

async function boot(page: import('@playwright/test').Page, size?: string) {
  await page.goto(`/?test=1&seed=42&scene=orbitdive${size ?? ''}`)
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
    scene: { id: 'orbitdive', params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames,
    events: [],
  }
}

// --- Goldens ------------------------------------------------------------

test('orbitdive renders deterministically at frame 150', async ({ page }) => {
  test.slow()
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('orbitdive-seed42-f150.png', {
    timeout: 60_000,
  })
})

test('orbitdive composes correctly at 9:16', async ({ page }) => {
  test.slow()
  await boot(page, '&w=360&h=640')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('orbitdive-9x16-f150.png', {
    timeout: 60_000,
  })
})

test('orbitdive composes correctly at 1:1', async ({ page }) => {
  test.slow()
  await boot(page, '&w=480&h=480')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('orbitdive-1x1-f150.png', {
    timeout: 60_000,
  })
})

// --- Non-blank guard ------------------------------------------------------

test('orbitdive canvas is not blank', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

// --- Determinism: loadSession re-init, two runs, byte-identical pixelHash --

test('orbitdive replays byte-identically via loadSession', async ({ page }) => {
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

// --- Param-motion sanity: the two headline knobs actually do something ----

test('changing family alters the rendered image', async ({ page }) => {
  await boot(page)
  const { hashBefore, hashAfter } = await page.evaluate((n) => {
    window.__viz!.renderFrames(n)
    const hashBefore = window.__viz!.pixelHash()
    window.__viz!.setParam('family', 1.7)
    window.__viz!.renderFrames(10)
    const hashAfter = window.__viz!.pixelHash()
    return { hashBefore, hashAfter }
  }, GOLDEN_FRAME)
  expect(hashAfter).not.toBe(hashBefore)
})

test('changing trapShape alters the rendered image', async ({ page }) => {
  await boot(page)
  const { hashBefore, hashAfter } = await page.evaluate((n) => {
    window.__viz!.renderFrames(n)
    const hashBefore = window.__viz!.pixelHash()
    window.__viz!.setParam('trapShape', 2.5)
    window.__viz!.renderFrames(10)
    const hashAfter = window.__viz!.pixelHash()
    return { hashBefore, hashAfter }
  }, GOLDEN_FRAME)
  expect(hashAfter).not.toBe(hashBefore)
})

// --- Shader-edit smoke on render-fs --------------------------------------

test('orbitdive render-fs is editable; bad GLSL keeps last good program', async ({ page }) => {
  await boot(page)

  const hashA = await page.evaluate((n) => {
    window.__viz!.renderFrames(n)
    return window.__viz!.pixelHash()
  }, 30)

  // Text-replace edit of the live stock source: force pure-red output.
  const { err: err1, matched } = await page.evaluate(() => {
    const stage = window.__viz!.getShaderSources().find((s) => s.key === 'render-fs')!
    const edited = stage.source.replace(
      'outColor = vec4(col, 1.0);',
      'outColor = vec4(1.0, 0.0, 0.0, 1.0);',
    )
    return { err: window.__viz!.setShaderSource('render-fs', edited), matched: edited !== stage.source }
  })
  expect(matched).toBe(true)
  expect(err1).toBeNull()

  const hashB = await page.evaluate((n) => {
    window.__viz!.renderFrames(n)
    return window.__viz!.pixelHash()
  }, 30)
  expect(hashB).not.toBe(hashA)
  expect(await litPixelCount(page)).toBeGreaterThan(2000)

  // Garbage GLSL: setShaderSource must throw (non-null error string) and the
  // previous (red) program must keep rendering.
  const err2 = await page.evaluate(() => window.__viz!.setShaderSource('render-fs', 'void main() { syntax'))
  expect(err2).not.toBeNull()
  expect(err2!.toLowerCase()).toContain('error')

  await page.evaluate(() => window.__viz!.renderFrames(10))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})
