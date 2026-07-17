import { expect, test } from '@playwright/test'

/**
 * Golden/behavioral tests for Fractal Lab (geometry family): "the fractal
 * whose EQUATION is on knobs" — a generalized Julia/Mandelbrot hybrid with
 * complex power, Burning-Ship-style abs-fold, and Julia<->Mandelbrot blend
 * all exposed as macro params. GPU-stateless single fullscreen-fragment
 * scene, same pattern as julia/mandeldive's tests in newscenes.spec.ts /
 * mandeldive.spec.ts.
 *
 * Frame choice: frame 60 was picked after eyeballing 30/60/90/150/300 at the
 * stock params (seed 42) — see the PNGs checked in under
 * fractallab.spec.ts-snapshots/. At frame 60 the audio-reactive effective
 * cRadius/cAngle land the Julia set in a connected configuration: a bold
 * black silhouette with a serrated boundary, ringed by a warm green/yellow/
 * red escape-gradient glow on a dark violet background — exactly the "visible
 * boundary, not boring/black" bar this suite is told to clear. (Frames 90/150
 * happen to drift into a fully-disconnected "dust" configuration — still
 * non-blank and structured, just a different, busier look; 60 was chosen as
 * the more classically legible golden.) Measured SwiftShader cost at frame 60
 * is ~2.3s end to end (render + first screenshot readback), nowhere near the
 * spec's "iterations 100->80 if a golden frame exceeds ~5s" threshold, so
 * ITER stays at 100.
 */

const GOLDEN_FRAME = 60

async function boot(page: import('@playwright/test').Page, size?: string) {
  await page.goto(`/?test=1&seed=42&scene=fractallab${size ?? ''}`)
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
    scene: { id: 'fractallab', params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames,
    events: [],
  }
}

// --- Goldens ------------------------------------------------------------

test('fractallab renders deterministically at frame 60', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('fractallab-seed42-f60.png')
})

test('fractallab composes correctly at 9:16', async ({ page }) => {
  await boot(page, '&w=360&h=640')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('fractallab-9x16-f60.png')
})

test('fractallab composes correctly at 1:1', async ({ page }) => {
  await boot(page, '&w=480&h=480')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('fractallab-1x1-f60.png')
})

// --- Non-blank guard ------------------------------------------------------

test('fractallab canvas is not blank', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

// --- Determinism: two runs, byte-identical pixelHash ----------------------

test('fractallab renders byte-identically across two runs', async ({ page }) => {
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

test('fractallab replays byte-identically via loadSession', async ({ page }) => {
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

test('changing power alters the rendered image', async ({ page }) => {
  await boot(page)
  const { hashBefore, hashAfter } = await page.evaluate((n) => {
    window.__viz!.renderFrames(n)
    const hashBefore = window.__viz!.pixelHash()
    window.__viz!.setParam('power', 3.0)
    window.__viz!.renderFrames(10)
    const hashAfter = window.__viz!.pixelHash()
    return { hashBefore, hashAfter }
  }, GOLDEN_FRAME)

  expect(hashAfter).not.toBe(hashBefore)
})

// --- Shader-edit smoke on render-fs --------------------------------------

test('fractallab render-fs is editable; bad GLSL keeps last good program', async ({ page }) => {
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
