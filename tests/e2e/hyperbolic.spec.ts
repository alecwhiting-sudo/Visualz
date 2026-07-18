import { expect, test } from '@playwright/test'

/**
 * Golden/behavioral tests for Hyperbolic (geometry family wildcard): a
 * Poincare-disk {p,q} tiling rendered by iterated (2,p,q) triangle-group
 * folding (angular mirror + edge-circle inversion) in a single fullscreen
 * fragment pass. GPU-stateless, same pattern as fractallab.spec.ts/
 * resonance.spec.ts.
 *
 * Frame choice: frame 120, per the task's own suggested screenshot frame —
 * eyeballed against 60/90/120/180/300 at stock params (seed 42): by frame 120
 * the rotation/drift phases and the bass-breath zoom have moved well past the
 * frame-0 starting pose (still legible, not yet cycled into a degenerate
 * near-repeat), giving a clearly non-trivial, structured tiling. See the
 * PNGs under hyperbolic.spec.ts-snapshots/.
 */

const GOLDEN_FRAME = 120

async function boot(page: import('@playwright/test').Page, size?: string) {
  await page.goto(`/?test=1&seed=42&scene=hyperbolic${size ?? ''}`)
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
    scene: { id: 'hyperbolic', params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames,
    events: [],
  }
}

// --- Goldens ------------------------------------------------------------

// timeout: 60_000 on every toHaveScreenshot below, same as grayscott.spec.ts/
// composite.spec.ts's heavier-compute goldens — the 28-iteration fold loop
// makes this scene slower than a trivial fullscreen pass under SwiftShader,
// and the default 5s expect-timeout has proven too tight under CI-like load.

test('hyperbolic renders deterministically at frame 120', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('hyperbolic-seed42-f120.png', { timeout: 60_000 })
})

test('hyperbolic composes correctly at 9:16', async ({ page }) => {
  await boot(page, '&w=360&h=640')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('hyperbolic-9x16-f120.png', { timeout: 60_000 })
})

test('hyperbolic composes correctly at 1:1', async ({ page }) => {
  await boot(page, '&w=480&h=480')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('hyperbolic-1x1-f120.png', { timeout: 60_000 })
})

// --- Non-blank guard (all three aspects) -----------------------------------

test('hyperbolic canvas is not blank at 16:9', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

test('hyperbolic canvas is not blank at 9:16', async ({ page }) => {
  await boot(page, '&w=360&h=640')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

test('hyperbolic canvas is not blank at 1:1', async ({ page }) => {
  await boot(page, '&w=480&h=480')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

// --- Determinism: two runs, byte-identical pixelHash ----------------------

test('hyperbolic renders byte-identically across two runs', async ({ page }) => {
  await boot(page)
  const hash1 = await page.evaluate((n) => {
    window.__viz!.renderFrames(n)
    return window.__viz!.pixelHash()
  }, GOLDEN_FRAME)

  await boot(page)
  const hash2 = await page.evaluate((n) => {
    window.__viz!.renderFrames(n)
    return window.__viz!.pixelHash()
  }, GOLDEN_FRAME)

  expect(hash2).toBe(hash1)
})

// --- Determinism: loadSession re-init, two runs, byte-identical pixelHash --

test('hyperbolic replays byte-identically via loadSession', async ({ page }) => {
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

// --- Param-motion sanity: equation knobs actually do something ------------

test('changing p alters the rendered image', async ({ page }) => {
  await boot(page)
  const hashDefault = await page.evaluate((n) => {
    window.__viz!.renderFrames(n)
    return window.__viz!.pixelHash()
  }, GOLDEN_FRAME)

  await boot(page)
  const hashP = await page.evaluate((n) => {
    window.__viz!.setParam('p', 5)
    window.__viz!.renderFrames(n)
    return window.__viz!.pixelHash()
  }, GOLDEN_FRAME)

  expect(hashP).not.toBe(hashDefault)
})

test('a non-hyperbolic {p,q} combo (4,4) renders without NaN/crash', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => {
    window.__viz!.setParam('p', 4)
    window.__viz!.setParam('q', 4)
  })
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

// --- Shader-edit smoke on render-fs --------------------------------------

test('hyperbolic render-fs is editable; bad GLSL keeps last good program', async ({ page }) => {
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
