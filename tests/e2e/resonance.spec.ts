import { expect, test } from '@playwright/test'

/**
 * Golden/behavioral tests for Resonance (geometry family wildcard): a
 * Chladni plate — standing-wave nodal patterns, crossfading between mode
 * pairs (m,n) picked deterministically off the mulberry32 stream on each
 * onset. GPU-stateless single fullscreen-fragment scene, same pattern as
 * julia/mandeldive/fractallab.
 *
 * Frame choice: frame 300 (seed 42) was picked after eyeballing 30/60/90/
 * 150/300/450 at stock params — see the PNGs under
 * resonance.spec.ts-snapshots/. The demo signals fire an onset every 15
 * frames (0.5s @ 30fps, the 120bpm demo grid), so by frame 300 the scene has
 * already cycled through many mode picks; 300 lands on a fully *settled*
 * mode (morph=0.35s finishes crossfading well within each 0.5s onset
 * interval) showing a denser, more intricate nodal grid than the scene's
 * frame-0 starting mode — a clearly-different, clearly-structured "sand
 * pattern" rather than the boring initial frame. (Note: because the demo
 * bass signal is exactly 0.3 at every onset instant — the onset and the
 * demo beat envelope are phase-locked to the same 120bpm grid, so
 * `beat=0` whenever `onset` fires — the `m` half of the picked pair only
 * varies over {2,3} per the spec's formula; `n` varies more since `high`
 * isn't locked to the onset grid. This is a property of the demo signal
 * generator, not a bug in the mode-picking formula, which is implemented
 * exactly as specified.) Measured SwiftShader cost at frame 300 is ~4s end to
 * end, well under any golden-frame budget concern.
 */

const GOLDEN_FRAME = 300

async function boot(page: import('@playwright/test').Page, size?: string) {
  await page.goto(`/?test=1&seed=42&scene=resonance${size ?? ''}`)
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
    scene: { id: 'resonance', params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames,
    events: [],
  }
}

// --- Goldens ------------------------------------------------------------

test('resonance renders deterministically at frame 300', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('resonance-seed42-f300.png')
})

test('resonance composes correctly at 9:16', async ({ page }) => {
  await boot(page, '&w=360&h=640')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('resonance-9x16-f300.png')
})

test('resonance composes correctly at 1:1', async ({ page }) => {
  await boot(page, '&w=480&h=480')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('resonance-1x1-f300.png')
})

// --- Non-blank guard ------------------------------------------------------

test('resonance canvas is not blank', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

// --- Determinism: two runs, byte-identical pixelHash ----------------------

test('resonance renders byte-identically across two runs', async ({ page }) => {
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

test('resonance replays byte-identically via loadSession', async ({ page }) => {
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

test('changing sharpness alters the rendered image', async ({ page }) => {
  await boot(page)
  const hashDefault = await page.evaluate((n) => {
    window.__viz!.renderFrames(n)
    return window.__viz!.pixelHash()
  }, GOLDEN_FRAME)

  await boot(page)
  const hashSharp = await page.evaluate((n) => {
    window.__viz!.setParam('sharpness', 30)
    window.__viz!.renderFrames(n)
    return window.__viz!.pixelHash()
  }, GOLDEN_FRAME)

  expect(hashSharp).not.toBe(hashDefault)
})

// --- Shader-edit smoke on render-fs --------------------------------------

test('resonance render-fs is editable; bad GLSL keeps last good program', async ({ page }) => {
  await boot(page)

  const hashA = await page.evaluate((n) => {
    window.__viz!.renderFrames(n)
    return window.__viz!.pixelHash()
  }, 30)

  // Text-replace edit of the live stock source: force pure-red output.
  const { err: err1, matched } = await page.evaluate(() => {
    const stage = window.__viz!.getShaderSources().find((s) => s.key === 'render-fs')!
    const edited = stage.source.replace(
      'outColor = vec4(clamp(col, 0.0, 1.0), 1.0);',
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
