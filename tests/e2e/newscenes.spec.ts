import { expect, test } from '@playwright/test'

/**
 * Golden/behavioral tests for the two newest geometry-family scenes: the
 * Julia-set domain-warp fractal (GPU-stateless, one fullscreen fragment pass)
 * and the kaleidoscope frame-feedback scene (two rgba8 ping-ponged targets).
 * Mirrors the patterns in particles.spec.ts and shaders.spec.ts.
 */

async function boot(page: import('@playwright/test').Page, scene: string, size?: string) {
  await page.goto(`/?test=1&seed=42&scene=${scene}${size ?? ''}`)
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

function minimalDoc(sceneId: string, durationFrames: number) {
  return {
    version: 1,
    seed: 42,
    fps: 30,
    scene: { id: sceneId, params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames,
    events: [],
  }
}

// --- Julia Warp -----------------------------------------------------------

test('julia renders deterministically at frame 90', async ({ page }) => {
  await boot(page, 'julia')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(90)
  await expect(page.locator('canvas')).toHaveScreenshot('julia-seed42-f90.png')
})

test('julia composes correctly at 9:16', async ({ page }) => {
  await boot(page, 'julia', '&w=360&h=640')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  await expect(page.locator('canvas')).toHaveScreenshot('julia-9x16-f90.png')
})

test('julia composes correctly at 1:1', async ({ page }) => {
  await boot(page, 'julia', '&w=480&h=480')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  await expect(page.locator('canvas')).toHaveScreenshot('julia-1x1-f90.png')
})

test('julia canvas is not blank', async ({ page }) => {
  await boot(page, 'julia')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

test('julia replays byte-identically via loadSession', async ({ page }) => {
  await boot(page, 'julia')
  const doc = minimalDoc('julia', 90)
  const hash1 = await page.evaluate((d) => {
    window.__viz!.loadSession(d)
    window.__viz!.renderFrames(90)
    return window.__viz!.pixelHash()
  }, doc)
  const hash2 = await page.evaluate((d) => {
    window.__viz!.loadSession(d)
    window.__viz!.renderFrames(90)
    return window.__viz!.pixelHash()
  }, doc)
  expect(hash2).toBe(hash1)
})

test('julia render-fs is editable; bad GLSL keeps last good program', async ({ page }) => {
  await boot(page, 'julia')

  const hashA = await page.evaluate(() => {
    window.__viz!.renderFrames(30)
    return window.__viz!.pixelHash()
  })

  // Text-replace edit from the live stock source, so this stays valid if the
  // shader's exact GLSL evolves: force pure-red output.
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

  const hashB = await page.evaluate(() => {
    window.__viz!.renderFrames(30)
    return window.__viz!.pixelHash()
  })
  expect(hashB).not.toBe(hashA)
  expect(await litPixelCount(page)).toBeGreaterThan(2000)

  // Garbage GLSL: setShaderSource must throw (surfaced as a non-null error
  // string) and the previous (red) program must keep rendering.
  const err2 = await page.evaluate(() => window.__viz!.setShaderSource('render-fs', 'void main() { syntax'))
  expect(err2).not.toBeNull()
  expect(err2!.toLowerCase()).toContain('error')

  await page.evaluate(() => window.__viz!.renderFrames(10))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

// --- Kaleidoscope -----------------------------------------------------------

test('kaleido renders deterministically at frame 90', async ({ page }) => {
  await boot(page, 'kaleido')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(90)
  await expect(page.locator('canvas')).toHaveScreenshot('kaleido-seed42-f90.png')
})

test('kaleido composes correctly at 9:16', async ({ page }) => {
  await boot(page, 'kaleido', '&w=360&h=640')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  await expect(page.locator('canvas')).toHaveScreenshot('kaleido-9x16-f90.png')
})

test('kaleido composes correctly at 1:1', async ({ page }) => {
  await boot(page, 'kaleido', '&w=480&h=480')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  await expect(page.locator('canvas')).toHaveScreenshot('kaleido-1x1-f90.png')
})

test('kaleido canvas is not blank', async ({ page }) => {
  await boot(page, 'kaleido')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

test('kaleido replays byte-identically via loadSession', async ({ page }) => {
  await boot(page, 'kaleido')
  const doc = minimalDoc('kaleido', 90)
  const hash1 = await page.evaluate((d) => {
    window.__viz!.loadSession(d)
    window.__viz!.renderFrames(90)
    return window.__viz!.pixelHash()
  }, doc)
  const hash2 = await page.evaluate((d) => {
    window.__viz!.loadSession(d)
    window.__viz!.renderFrames(90)
    return window.__viz!.pixelHash()
  }, doc)
  expect(hash2).toBe(hash1)
})
