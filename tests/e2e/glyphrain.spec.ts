import { expect, test } from '@playwright/test'

/**
 * Golden/behavioral tests for "Glyph Rain" — the classic Matrix-movie
 * digital rain, built deliberately rectilinear: straight falling columns of
 * glyphs plus axis-aligned circuit-trace polylines (90°-turn-only) carrying
 * a second population of glyph streamers. Mirrors wildcards.spec.ts's
 * structure (also glyphlattice.spec.ts's, the closest sibling scene): golden
 * frame + non-blank + aspect coverage + determinism-via-replay + a shader
 * hot-recompile smoke test for both editable stages ('glyph-fs', 'fade-fs').
 *
 * Frame 90 (same convention as every other scene in this file): by 3s at
 * 30fps the demo signal's onset detector has already fired several times
 * (src/audio/engine.ts's publishDemoSignals), so frame 90 exercises the
 * onset-triggered column-respawn + circuit-flash path, not just the
 * continuous fall/flow maths.
 */

async function boot(page: import('@playwright/test').Page, size?: string) {
  await page.goto(`/?test=1&seed=42&scene=glyphrain${size ?? ''}`)
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
    scene: { id: 'glyphrain', params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames,
    events: [],
  }
}

test('glyphrain renders deterministically at frame 90', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => window.__viz!.renderFrames(90))
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(90)
  await expect(page.locator('canvas')).toHaveScreenshot('glyphrain-seed42-f90.png')
})

test('glyphrain composes correctly at 9:16', async ({ page }) => {
  await boot(page, '&w=360&h=640')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  await expect(page.locator('canvas')).toHaveScreenshot('glyphrain-9x16-f90.png')
})

test('glyphrain composes correctly at 1:1', async ({ page }) => {
  await boot(page, '&w=480&h=480')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  await expect(page.locator('canvas')).toHaveScreenshot('glyphrain-1x1-f90.png')
})

test('glyphrain canvas is not blank', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => window.__viz!.renderFrames(90))
  expect(await litPixelCount(page)).toBeGreaterThan(1000)
})

test('glyphrain composes non-blank at 9:16 and 1:1', async ({ page }) => {
  for (const size of ['&w=360&h=640', '&w=480&h=480']) {
    await boot(page, size)
    await page.evaluate(() => window.__viz!.renderFrames(90))
    expect(await litPixelCount(page)).toBeGreaterThan(700)
  }
})

test('glyphrain replays byte-identically via loadSession', async ({ page }) => {
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

test('glyphrain glyph-fs and fade-fs are editable; bad GLSL keeps last good program', async ({ page }) => {
  await boot(page)

  const hashA = await page.evaluate(() => {
    window.__viz!.renderFrames(30)
    return window.__viz!.pixelHash()
  })

  // Text-replace edit from the live stock source: invert the atlas mask.
  const { err: err1, matched } = await page.evaluate(() => {
    const stage = window.__viz!.getShaderSources().find((s) => s.key === 'glyph-fs')!
    const edited = stage.source.replace('float mask = texture(uAtlas, vUV).r;', 'float mask = 1.0 - texture(uAtlas, vUV).r;')
    return { err: window.__viz!.setShaderSource('glyph-fs', edited), matched: edited !== stage.source }
  })
  expect(matched).toBe(true)
  expect(err1).toBeNull()

  const hashB = await page.evaluate(() => {
    window.__viz!.renderFrames(30)
    return window.__viz!.pixelHash()
  })
  expect(hashB).not.toBe(hashA)
  expect(await litPixelCount(page)).toBeGreaterThan(1000)

  // Garbage GLSL: setShaderSource must throw (non-null error string) and the
  // previous (inverted-mask) program must keep rendering.
  const err2 = await page.evaluate(() => window.__viz!.setShaderSource('glyph-fs', 'void main() { syntax'))
  expect(err2).not.toBeNull()
  expect(err2!.toLowerCase()).toContain('error')

  await page.evaluate(() => window.__viz!.renderFrames(10))
  expect(await litPixelCount(page)).toBeGreaterThan(1000)

  // fade-fs: same hot-recompile contract, checked independently since it's a
  // separate program/uniform-location cache in the scene.
  const err3 = await page.evaluate(() => {
    const stage = window.__viz!.getShaderSources().find((s) => s.key === 'fade-fs')!
    const edited = stage.source.replace('outColor = vec4(0.0, 0.0, 0.0, uFade);', 'outColor = vec4(0.0, 0.0, 0.0, uFade * 0.5);')
    return window.__viz!.setShaderSource('fade-fs', edited)
  })
  expect(err3).toBeNull()
  await page.evaluate(() => window.__viz!.renderFrames(10))
  expect(await litPixelCount(page)).toBeGreaterThan(1000)

  const err4 = await page.evaluate(() => window.__viz!.setShaderSource('fade-fs', 'void main() { syntax'))
  expect(err4).not.toBeNull()
  await page.evaluate(() => window.__viz!.renderFrames(10))
  expect(await litPixelCount(page)).toBeGreaterThan(1000)
})
