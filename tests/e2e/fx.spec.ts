import { expect, test } from '@playwright/test'

/**
 * FX chain (`src/fx/`) — post-processing passes stacked over a scene's own
 * output. Beyond the usual golden + non-blank checks, this asserts the two
 * properties the bypass path and the chain's statelessness exist to
 * guarantee: an all-disabled chain must be pixel-for-pixel identical to the
 * pre-FX render path (every existing scene golden depends on this), and the
 * chain itself must hold the Scene Contract's render-purity /
 * loadSession-replay-determinism properties just like a scene does.
 */

const GOLDEN_FRAME = 90

async function boot(page: import('@playwright/test').Page, extra?: string) {
  await page.goto(`/?test=1&seed=42&scene=terrain${extra ?? ''}`)
  await page.waitForFunction(() => window.__viz !== undefined)
}

async function litPixelCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas')!
    const gl = canvas.getContext('webgl2')!
    const px = new Uint8Array(canvas.width * canvas.height * 4)
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px)
    let lit = 0
    for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 30) lit++
    return lit
  })
}

function minimalDocWithFx(durationFrames: number) {
  return {
    version: 1,
    seed: 42,
    fps: 30,
    scene: { id: 'terrain', params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames,
    events: [
      { frame: 0, type: 'fxParam', passId: 'kaleido', name: 'enabled', value: 1 },
      { frame: 0, type: 'fxParam', passId: 'kaleido', name: 'segments', value: 8 },
      { frame: 0, type: 'fxParam', passId: 'kaleido', name: 'rotate', value: 0.55 },
      { frame: 0, type: 'fxParam', passId: 'posterize', name: 'enabled', value: 1 },
      { frame: 0, type: 'fxParam', passId: 'posterize', name: 'levels', value: 5 },
    ],
  }
}

// --- (a) Bypass proof: all-disabled chain changes zero pixels ---------------

test('fx: an all-disabled chain is pixel-identical to the pre-FX render path', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  const untouchedHash = await page.evaluate(() => window.__viz!.pixelHash())

  await boot(page)
  await page.evaluate(() => {
    // Explicitly touch every pass's enable flag (leaving it off) — proves
    // the chain existing/being poked doesn't itself perturb anything, not
    // just that a never-touched chain is a no-op.
    for (const id of ['kaleido', 'mirror', 'rgbshift', 'pixelate', 'posterize', 'zoompulse']) {
      window.__viz!.setFxParam(id, 'enabled', 0)
    }
  })
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  const toggledOffHash = await page.evaluate(() => window.__viz!.pixelHash())

  expect(toggledOffHash).toBe(untouchedHash)
})

// --- (b) Golden: kaleido + posterize enabled with fixed params --------------

test('fx: kaleido + posterize renders deterministically at frame 90', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => {
    window.__viz!.setFxParam('kaleido', 'enabled', 1)
    window.__viz!.setFxParam('kaleido', 'segments', 8)
    window.__viz!.setFxParam('kaleido', 'rotate', 0.55)
    window.__viz!.setFxParam('posterize', 'enabled', 1)
    window.__viz!.setFxParam('posterize', 'levels', 5)
  })
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('fx-kaleido-posterize-seed42-f90.png')
})

// --- (e) Non-blank at 16:9 with FX on ----------------------------------------

test('fx: kaleido + posterize is non-blank at 16:9', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => {
    window.__viz!.setFxParam('kaleido', 'enabled', 1)
    window.__viz!.setFxParam('kaleido', 'segments', 8)
    window.__viz!.setFxParam('kaleido', 'rotate', 0.55)
    window.__viz!.setFxParam('posterize', 'enabled', 1)
  })
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await litPixelCount(page)).toBeGreaterThan(500)
})

test('fx: kaleido + posterize is non-blank at 9:16', async ({ page }) => {
  await boot(page, '&w=360&h=640')
  await page.evaluate(() => {
    window.__viz!.setFxParam('kaleido', 'enabled', 1)
    window.__viz!.setFxParam('kaleido', 'segments', 8)
    window.__viz!.setFxParam('kaleido', 'rotate', 0.55)
    window.__viz!.setFxParam('posterize', 'enabled', 1)
  })
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await litPixelCount(page)).toBeGreaterThan(500)
})

// --- (c) Contract: the chain's render() is pure ------------------------------

test('fx: rerender() with the chain enabled is byte-identical', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => {
    window.__viz!.setFxParam('kaleido', 'enabled', 1)
    window.__viz!.setFxParam('rgbshift', 'enabled', 1)
    window.__viz!.setFxParam('pixelate', 'enabled', 1)
  })
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  const hashA = await page.evaluate(() => {
    window.__viz!.rerender()
    return window.__viz!.pixelHash()
  })
  const hashB = await page.evaluate(() => {
    window.__viz!.rerender()
    return window.__viz!.pixelHash()
  })
  expect(hashB).toBe(hashA)
})

// --- (d) Determinism: byte-identical loadSession replay, fx events included -

test('fx: loadSession replay (including recorded fx param/enable events) is byte-identical', async ({ page }) => {
  await boot(page)
  const doc = minimalDocWithFx(120)
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
  // And the fx state genuinely round-tripped (not just "replay is stable
  // however it landed") — the doc's events resolve to these live values.
  const [segments, levels] = await page.evaluate(() => [
    window.__viz!.getFxParam('kaleido', 'segments'),
    window.__viz!.getFxParam('posterize', 'levels'),
  ])
  expect(segments).toBe(8)
  expect(levels).toBe(5)
})

// --- loadSession with NO fx data loads with every pass disabled -------------

test('fx: a doc with no fx events loads with every pass disabled (version tolerance)', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => {
    window.__viz!.setFxParam('kaleido', 'enabled', 1)
  })
  const doc = {
    version: 1,
    seed: 42,
    fps: 30,
    scene: { id: 'terrain', params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames: 10,
    events: [],
  }
  const enabled = await page.evaluate((d) => {
    window.__viz!.loadSession(d)
    return window.__viz!.getFxParam('kaleido', 'enabled')
  }, doc)
  expect(enabled).toBe(0)
})
