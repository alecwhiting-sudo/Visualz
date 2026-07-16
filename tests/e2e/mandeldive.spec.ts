import { expect, test } from '@playwright/test'

/**
 * Golden/behavioral tests for Mandel Dive (geometry family): a warp-free
 * Mandelbrot whose breathing zoom is driven by bass. GPU-stateless single
 * fullscreen-fragment scene, same pattern as julia's tests in newscenes.spec.ts.
 *
 * Frame choice: the scene's default diveSpeed (0.09) breathes very slowly —
 * simulating the exact demo-bass/smoothing/divePhase formulas used by
 * update() shows zoomLog (and thus the rendered magnification) is still
 * within ~20% of 1x at frame 90, 120, AND 150 (demo bass averages ~0.38, so
 * divePhase only reaches ~0.27-0.45 rad by frame 150 — nowhere near the
 * pi/2 "mid-breath" point). All three of those frames render the plain,
 * unzoomed Mandelbrot silhouette, which is exactly the "near-1x boring
 * frame" this suite is told to avoid. Frame 450 (t=15s, scale ~50x into the
 * Seahorse-Valley-family dive point seed 42 picks) was chosen instead after
 * visually spot-checking frames 90/150/300/450/600/800: it lands mid-dive
 * with clearly zoomed boundary detail (a cusp with spiral decorations) and a
 * healthy mix of escape-gradient color and interior — neither boring nor
 * solid-black. Noting this deviation from the 90/120/150 suggestion as asked.
 *
 * Perf note: SwiftShader's cost for this shader is dominated by per-pixel
 * divergence near the (highly serrated, at this depth) fractal boundary, not
 * just the iteration-count uniform — measured first-screenshot-after-render
 * cost rises from <1s at frame 90 to ~11s at frame 450 (`renderFrames` itself
 * stays sub-10ms; the real GPU/software work happens lazily at readback
 * time). The three golden assertions below pass an explicit longer
 * `toHaveScreenshot` timeout so this doesn't flake against the shared 5s
 * default; every other assertion here uses plain `evaluate()` calls, which
 * aren't subject to that 5s ceiling (only the test's own 60s budget).
 */

const GOLDEN_FRAME = 450
const SMOKE_FRAME = 30
// SwiftShader's readback cost at frame 450 is ~11s on an idle machine but has
// been observed to blow past 20s under CPU contention (parallel agent/build
// work on shared sandboxes) — the golden tests mark themselves slow and give
// the screenshot most of that tripled budget.
const SCREENSHOT_TIMEOUT = 60_000

async function boot(page: import('@playwright/test').Page, size?: string) {
  await page.goto(`/?test=1&seed=42&scene=mandeldive${size ?? ''}`)
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
    scene: { id: 'mandeldive', params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames,
    events: [],
  }
}

// --- Goldens ------------------------------------------------------------

test('mandeldive renders deterministically at frame 450', async ({ page }) => {
  test.slow()
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('mandeldive-seed42-f450.png', {
    timeout: SCREENSHOT_TIMEOUT,
  })
})

test('mandeldive composes correctly at 9:16', async ({ page }) => {
  test.slow()
  await boot(page, '&w=360&h=640')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('mandeldive-9x16-f450.png', {
    timeout: SCREENSHOT_TIMEOUT,
  })
})

test('mandeldive composes correctly at 1:1', async ({ page }) => {
  test.slow()
  await boot(page, '&w=480&h=480')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('mandeldive-1x1-f450.png', {
    timeout: SCREENSHOT_TIMEOUT,
  })
})

// --- Non-blank guard ------------------------------------------------------

test('mandeldive canvas is not blank', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

// --- Determinism: loadSession re-init, two runs, byte-identical pixelHash --

test('mandeldive replays byte-identically via loadSession', async ({ page }) => {
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

// --- Shader-edit smoke on render-fs --------------------------------------

test('mandeldive render-fs is editable; bad GLSL keeps last good program', async ({ page }) => {
  await boot(page)

  const hashA = await page.evaluate((n) => {
    window.__viz!.renderFrames(n)
    return window.__viz!.pixelHash()
  }, SMOKE_FRAME)

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
  }, SMOKE_FRAME)
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
