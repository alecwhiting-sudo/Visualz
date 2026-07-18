import { expect, test } from '@playwright/test'

/**
 * Golden/behavioral tests for "Glyph Geometry" — nested parametric outlines
 * (superformula <-> spirograph <-> star/rose, blended by `figure`) drawn
 * with NO line primitive at all: every stroke is a chain of rotated glyph
 * quads sampled off the curve, sharing glyphlattice.ts's baked bitmap font
 * atlas (now factored into src/scenes/families/geometry/glyphFont.ts).
 * Mirrors glyphlattice.spec.ts / wildcards.spec.ts's structure: golden
 * frame + non-blank + aspect coverage + determinism-via-replay + a shader
 * hot-recompile smoke test for both editable stages (glyph-fs, fade-fs).
 *
 * Frame 90 (same convention as every other scene in this repo): by 3s at
 * 30fps the demo signal's onset detector has already fired several times
 * (src/audio/events.ts's spectral-flux detector over the demo bass curve —
 * src/audio/engine.ts's publishDemoSignals), so frame 90 exercises the
 * onset-triggered ring-reroll/rotation-kick path, not just the continuous
 * drift/rotation maths.
 */

async function boot(page: import('@playwright/test').Page, size?: string) {
  await page.goto(`/?test=1&seed=42&scene=glyphgeometry${size ?? ''}`)
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
    scene: { id: 'glyphgeometry', params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames,
    events: [],
  }
}

test('glyphgeometry renders deterministically at frame 90', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => window.__viz!.renderFrames(90))
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(90)
  await expect(page.locator('canvas')).toHaveScreenshot('glyphgeometry-seed42-f90.png')
})

test('glyphgeometry composes correctly at 9:16', async ({ page }) => {
  await boot(page, '&w=360&h=640')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  await expect(page.locator('canvas')).toHaveScreenshot('glyphgeometry-9x16-f90.png')
})

test('glyphgeometry composes correctly at 1:1', async ({ page }) => {
  await boot(page, '&w=480&h=480')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  await expect(page.locator('canvas')).toHaveScreenshot('glyphgeometry-1x1-f90.png')
})

test('glyphgeometry canvas is not blank', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => window.__viz!.renderFrames(90))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

test('glyphgeometry composes non-blank at 9:16 and 1:1', async ({ page }) => {
  for (const size of ['&w=360&h=640', '&w=480&h=480']) {
    await boot(page, size)
    await page.evaluate(() => window.__viz!.renderFrames(90))
    expect(await litPixelCount(page)).toBeGreaterThan(1500)
  }
})

test('glyphgeometry replays byte-identically via loadSession', async ({ page }) => {
  await boot(page)
  const doc = minimalDoc(90)
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

test('glyphgeometry glyph-fs and fade-fs are editable; bad GLSL keeps last good program', async ({ page }) => {
  await boot(page)

  const hashA = await page.evaluate(() => {
    window.__viz!.renderFrames(30)
    return window.__viz!.pixelHash()
  })

  // Text-replace edit from the live stock source: force the glyph mask fully
  // opaque (no bitmap cutout) so the change is visually obvious.
  const { err: err1, matched } = await page.evaluate(() => {
    const stage = window.__viz!.getShaderSources().find((s) => s.key === 'glyph-fs')!
    const edited = stage.source.replace('float mask = texture(uAtlas, vUV).r;', 'float mask = 1.0;')
    return { err: window.__viz!.setShaderSource('glyph-fs', edited), matched: edited !== stage.source }
  })
  expect(matched).toBe(true)
  expect(err1).toBeNull()

  const hashB = await page.evaluate(() => {
    window.__viz!.renderFrames(30)
    return window.__viz!.pixelHash()
  })
  expect(hashB).not.toBe(hashA)
  expect(await litPixelCount(page)).toBeGreaterThan(2000)

  // Garbage GLSL: setShaderSource must throw (non-null error string) and the
  // previous (unmasked) program must keep rendering.
  const err2 = await page.evaluate(() => window.__viz!.setShaderSource('glyph-fs', 'void main() { syntax'))
  expect(err2).not.toBeNull()
  expect(err2!.toLowerCase()).toContain('error')

  await page.evaluate(() => window.__viz!.renderFrames(10))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)

  // fade-fs: same hot-recompile contract, checked independently since it's a
  // separate program/uniform-location cache in the scene. Swap the fade
  // color to a nonzero tint (still low alpha) so the edit is provably live.
  const err3 = await page.evaluate(() => {
    const stage = window.__viz!.getShaderSources().find((s) => s.key === 'fade-fs')!
    const edited = stage.source.replace(
      'outColor = vec4(0.0, 0.0, 0.0, uFade);',
      'outColor = vec4(0.2, 0.0, 0.2, uFade);',
    )
    return window.__viz!.setShaderSource('fade-fs', edited)
  })
  expect(err3).toBeNull()
  await page.evaluate(() => window.__viz!.renderFrames(10))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)

  const err4 = await page.evaluate(() => window.__viz!.setShaderSource('fade-fs', 'void main() { syntax'))
  expect(err4).not.toBeNull()
  await page.evaluate(() => window.__viz!.renderFrames(10))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})
