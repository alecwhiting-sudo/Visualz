import { expect, test } from '@playwright/test'

/**
 * Golden/behavioral tests for the two newest geometry-family scenes —
 * Morphogen (GPU-stateless, journeys between four pattern generators) and
 * Audio Tunnel (GPU-stateless render pass + a 512x1 RGBA32F audio-feature
 * ring-buffer texture written one texel per frame) — plus their two new
 * curated combos (`blend-mandel-kaleido`, `blend-tunnel-morph`). Mirrors the
 * patterns in newscenes.spec.ts (goldens, non-blank, determinism, shader-edit
 * smoke) and mandeldive.spec.ts (documenting a non-default frame choice) and
 * composite.spec.ts (the loop-based combo-coverage pattern at the bottom).
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

// --- Morphogen --------------------------------------------------------------

// Frame choice: the task asked for a golden frame that lands mid-transition
// between two of the four pattern generators (not near an integer `journey`
// value where the blend fraction is ~0, which would render one generator in
// isolation). journeySpeed's default (0.04) accumulates slowly and picks up
// extra jumps from demo-signal onset lunges (src/audio/engine.ts's
// publishDemoSignals + the causal onset detector in src/audio/events.ts —
// both deterministic but not worth hand-deriving), so the exact journeyPhase
// at a given frame isn't obvious from the formula alone. Checked empirically:
// a throwaway instrumented build (temporarily stashing the render()-computed
// `journey` value on `window` right before `this.fsPass.draw()`, removed
// before this commit) was stepped through candidate frames
// 60/90/120/150/180/210/240/270/300/330/360/400/450/500 at seed 42. Frame 90
// — already every other scene's golden-frame convention — turns out to land
// at journey≈1.4300 (fract≈0.43, idx=1: blending g1Phyllotaxis→g2Hexfold),
// comfortably inside the requested 0.3-0.7 "clearly blended" band, so no
// deviation from the 90-frame convention was needed.
test('morph renders deterministically at frame 90', async ({ page }) => {
  await boot(page, 'morph')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(90)
  await expect(page.locator('canvas')).toHaveScreenshot('morph-seed42-f90.png')
})

test('morph composes correctly at 9:16', async ({ page }) => {
  await boot(page, 'morph', '&w=360&h=640')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  await expect(page.locator('canvas')).toHaveScreenshot('morph-9x16-f90.png')
})

test('morph composes correctly at 1:1', async ({ page }) => {
  await boot(page, 'morph', '&w=480&h=480')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  await expect(page.locator('canvas')).toHaveScreenshot('morph-1x1-f90.png')
})

test('morph canvas is not blank', async ({ page }) => {
  await boot(page, 'morph')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

test('morph replays byte-identically via loadSession', async ({ page }) => {
  await boot(page, 'morph')
  const doc = minimalDoc('morph', 90)
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

test('morph render-fs is editable; bad GLSL keeps last good program', async ({ page }) => {
  await boot(page, 'morph')

  const hashA = await page.evaluate(() => {
    window.__viz!.renderFrames(30)
    return window.__viz!.pixelHash()
  })

  // Text-replace edit from the live stock source: force pure-red output.
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

  // Garbage GLSL: setShaderSource must throw (non-null error string) and the
  // previous (red) program must keep rendering.
  const err2 = await page.evaluate(() => window.__viz!.setShaderSource('render-fs', 'void main() { syntax'))
  expect(err2).not.toBeNull()
  expect(err2!.toLowerCase()).toContain('error')

  await page.evaluate(() => window.__viz!.renderFrames(10))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

// --- Audio Tunnel -------------------------------------------------------------

// Frame 90 is the same convention as every other scene here — nothing about
// the tunnel's polar ring-history math makes it slow-building or boring at
// frame 90 the way mandeldive's zoom is (see mandeldive.spec.ts).

test('tunnel renders deterministically at frame 90', async ({ page }) => {
  await boot(page, 'tunnel')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(90)
  await expect(page.locator('canvas')).toHaveScreenshot('tunnel-seed42-f90.png')
})

test('tunnel composes correctly at 9:16', async ({ page }) => {
  await boot(page, 'tunnel', '&w=360&h=640')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  await expect(page.locator('canvas')).toHaveScreenshot('tunnel-9x16-f90.png')
})

test('tunnel composes correctly at 1:1', async ({ page }) => {
  await boot(page, 'tunnel', '&w=480&h=480')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  await expect(page.locator('canvas')).toHaveScreenshot('tunnel-1x1-f90.png')
})

test('tunnel canvas is not blank', async ({ page }) => {
  await boot(page, 'tunnel')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

test('tunnel replays byte-identically via loadSession', async ({ page }) => {
  await boot(page, 'tunnel')
  const doc = minimalDoc('tunnel', 90)
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

// --- Coverage for the two new combos (composite.spec.ts's loop-based pattern
// used for blend-rd-flow's coverage). Frame 60, no ?count= needed — neither
// combo has a particle-family child. ------------------------------------------

for (const combo of ['blend-mandel-kaleido', 'blend-tunnel-morph'] as const) {
  test(`${combo} renders deterministically at frame 60`, async ({ page }) => {
    await page.goto(`/?test=1&seed=42&scene=${combo}`)
    await page.waitForFunction(() => window.__viz !== undefined)
    await page.evaluate(() => window.__viz!.renderFrames(60))
    expect(await litPixelCount(page)).toBeGreaterThan(2000)
    await expect(page.locator('canvas')).toHaveScreenshot(`${combo}-seed42-f60.png`)
  })

  test(`${combo} replays byte-identically via loadSession`, async ({ page }) => {
    await page.goto(`/?test=1&seed=42&scene=${combo}`)
    await page.waitForFunction(() => window.__viz !== undefined)
    const [a, b] = await page.evaluate((sceneId) => {
      const doc = {
        version: 1, seed: 42, fps: 30,
        scene: { id: sceneId, params: {} },
        bindings: {}, audio: { kind: 'demo' }, durationFrames: 60, events: [],
      }
      window.__viz!.loadSession(doc)
      window.__viz!.renderFrames(60)
      const first = window.__viz!.pixelHash()
      window.__viz!.loadSession(doc)
      window.__viz!.renderFrames(60)
      return [first, window.__viz!.pixelHash()]
    }, combo)
    expect(b).toBe(a)
  })
}
