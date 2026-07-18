import { expect, test } from '@playwright/test'

/**
 * Golden/behavioral tests for "Glyph Lattice" — a diagram-style morphing
 * lattice of parametric curves (lissajous <-> rose <-> harmonograph) with
 * Matrix-rain text strings flowing along them from a baked bitmap glyph
 * atlas. Mirrors wildcards.spec.ts's structure: golden frame + non-blank +
 * aspect coverage + determinism-via-replay + a shader hot-recompile smoke
 * test.
 *
 * Frame 90 (same convention as every other scene in this file): by 3s at
 * 30fps the demo signal's onset detector has already fired several times
 * (see src/audio/events.ts's spectral-flux detector over the ~120bpm demo
 * bass curve — src/audio/engine.ts's publishDemoSignals), so frame 90
 * exercises the onset-triggered string-respawn path, not just the
 * continuous flow/morph maths.
 */

async function boot(page: import('@playwright/test').Page, size?: string) {
  await page.goto(`/?test=1&seed=42&scene=glyphlattice${size ?? ''}`)
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
    scene: { id: 'glyphlattice', params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames,
    events: [],
  }
}

test('glyphlattice renders deterministically at frame 90', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => window.__viz!.renderFrames(90))
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(90)
  await expect(page.locator('canvas')).toHaveScreenshot('glyphlattice-seed42-f90.png')
})

test('glyphlattice composes correctly at 9:16', async ({ page }) => {
  await boot(page, '&w=360&h=640')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  await expect(page.locator('canvas')).toHaveScreenshot('glyphlattice-9x16-f90.png')
})

test('glyphlattice composes correctly at 1:1', async ({ page }) => {
  await boot(page, '&w=480&h=480')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  await expect(page.locator('canvas')).toHaveScreenshot('glyphlattice-1x1-f90.png')
})

test('glyphlattice canvas is not blank', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => window.__viz!.renderFrames(90))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

test('glyphlattice composes non-blank at 9:16 and 1:1', async ({ page }) => {
  for (const size of ['&w=360&h=640', '&w=480&h=480']) {
    await boot(page, size)
    await page.evaluate(() => window.__viz!.renderFrames(90))
    expect(await litPixelCount(page)).toBeGreaterThan(1500)
  }
})

test('glyphlattice replays byte-identically via loadSession', async ({ page }) => {
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

test('glyphlattice line-fs and glyph-fs are editable; bad GLSL keeps last good program', async ({ page }) => {
  await boot(page)

  const hashA = await page.evaluate(() => {
    window.__viz!.renderFrames(30)
    return window.__viz!.pixelHash()
  })

  // Text-replace edit from the live stock source: force pure-red output.
  const { err: err1, matched } = await page.evaluate(() => {
    const stage = window.__viz!.getShaderSources().find((s) => s.key === 'line-fs')!
    const edited = stage.source.replace('outColor = vColor;', 'outColor = vec4(1.0, 0.0, 0.0, vColor.a);')
    return { err: window.__viz!.setShaderSource('line-fs', edited), matched: edited !== stage.source }
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
  // previous (red) program must keep rendering.
  const err2 = await page.evaluate(() => window.__viz!.setShaderSource('line-fs', 'void main() { syntax'))
  expect(err2).not.toBeNull()
  expect(err2!.toLowerCase()).toContain('error')

  await page.evaluate(() => window.__viz!.renderFrames(10))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)

  // glyph-fs: same hot-recompile contract, checked independently since it's
  // a separate program/uniform-location cache in the scene.
  const err3 = await page.evaluate(() => {
    const stage = window.__viz!.getShaderSources().find((s) => s.key === 'glyph-fs')!
    const edited = stage.source.replace('float mask = texture(uAtlas, vUV).r;', 'float mask = 1.0;')
    return window.__viz!.setShaderSource('glyph-fs', edited)
  })
  expect(err3).toBeNull()
  await page.evaluate(() => window.__viz!.renderFrames(10))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)

  const err4 = await page.evaluate(() => window.__viz!.setShaderSource('glyph-fs', 'void main() { syntax'))
  expect(err4).not.toBeNull()
  await page.evaluate(() => window.__viz!.renderFrames(10))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})
