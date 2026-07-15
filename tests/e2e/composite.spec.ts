import { expect, test } from '@playwright/test'

/**
 * The scene combiner (ARCHITECTURE.md's "combining algorithms" milestone):
 * `CompositeScene` (src/scenes/composite.ts) renders two child scenes into
 * their own offscreen targets and blends them. Exercised here via the
 * registry's 'blend-julia-flow' combo (Julia Warp × Flow field) — mirrors the
 * patterns in newscenes.spec.ts and shaders.spec.ts.
 *
 * CI-runtime note: this combo runs the Julia fractal's 96-iteration fragment
 * pass AND the flow field's GPGPU update pass every frame, on SwiftShader. The
 * three golden + determinism tests use the same 90-frame convention as
 * newscenes.spec.ts (that budget was fine there); the "controls are live" /
 * param-routing / shader-routing tests below don't need golden-level frame
 * depth, so they render fewer frames (30) to bound total spec runtime — noted
 * again at the bottom with the measured numbers.
 */

const SCENE = 'blend-julia-flow'
// ?count= forwards to flowfield (the composite's unprefixed-param broadcast
// rule) — same reasoning as newscenes.spec.ts's particle-family goldens: keep
// the swarm small enough that SwiftShader CI stays fast.
const COUNT = '&count=16384'

async function boot(page: import('@playwright/test').Page, size?: string) {
  await page.goto(`/?test=1&seed=42&scene=${SCENE}${COUNT}${size ?? ''}`)
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

// --- Goldens ----------------------------------------------------------------

test('blend-julia-flow renders deterministically at frame 90', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => window.__viz!.renderFrames(90))
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(90)
  await expect(page.locator('canvas')).toHaveScreenshot('blend-julia-flow-seed42-f90.png')
})

test('blend-julia-flow composes correctly at 9:16', async ({ page }) => {
  await boot(page, '&w=360&h=640')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  await expect(page.locator('canvas')).toHaveScreenshot('blend-julia-flow-9x16-f90.png')
})

test('blend-julia-flow composes correctly at 1:1', async ({ page }) => {
  await boot(page, '&w=480&h=480')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  await expect(page.locator('canvas')).toHaveScreenshot('blend-julia-flow-1x1-f90.png')
})

test('blend-julia-flow canvas is not blank at all three aspects', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => window.__viz!.renderFrames(90))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)

  await boot(page, '&w=360&h=640')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)

  await boot(page, '&w=480&h=480')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

// --- Determinism -------------------------------------------------------------

test('blend-julia-flow replays byte-identically via loadSession', async ({ page }) => {
  await boot(page)
  const doc = minimalDoc(SCENE, 90)
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

// --- Blend controls are live -------------------------------------------------

test('mix and mode controls change the rendered output', async ({ page }) => {
  const doc = minimalDoc(SCENE, 30)

  await boot(page)
  const hashMix0 = await page.evaluate((d) => {
    window.__viz!.loadSession(d)
    window.__viz!.setParam('mix', 0)
    window.__viz!.renderFrames(30)
    return window.__viz!.pixelHash()
  }, doc)

  await boot(page)
  const hashMix1 = await page.evaluate((d) => {
    window.__viz!.loadSession(d)
    window.__viz!.setParam('mix', 1)
    window.__viz!.renderFrames(30)
    return window.__viz!.pixelHash()
  }, doc)

  await boot(page)
  const hashMode1 = await page.evaluate((d) => {
    window.__viz!.loadSession(d)
    window.__viz!.setParam('mix', 1)
    window.__viz!.setParam('mode', 1)
    window.__viz!.renderFrames(30)
    return window.__viz!.pixelHash()
  }, doc)

  expect(hashMix0).not.toBe(hashMix1)
  expect(hashMix1).not.toBe(hashMode1)
  expect(hashMix0).not.toBe(hashMode1)
})

// --- Param routing (a./b. prefix) -------------------------------------------

test('a./b. prefixed setParam reaches each child', async ({ page }) => {
  const doc = minimalDoc(SCENE, 30)

  await boot(page)
  const hashDefault = await page.evaluate((d) => {
    window.__viz!.loadSession(d)
    window.__viz!.renderFrames(30)
    return window.__viz!.pixelHash()
  }, doc)

  await boot(page)
  const hashA = await page.evaluate((d) => {
    window.__viz!.loadSession(d)
    window.__viz!.setParam('a.hueShift', 0.2)
    window.__viz!.renderFrames(30)
    return window.__viz!.pixelHash()
  }, doc)

  await boot(page)
  const hashB = await page.evaluate((d) => {
    window.__viz!.loadSession(d)
    window.__viz!.setParam('b.flowSpeed', 2)
    window.__viz!.renderFrames(30)
    return window.__viz!.pixelHash()
  }, doc)

  expect(hashA).not.toBe(hashDefault)
  expect(hashB).not.toBe(hashDefault)
})

// --- Shader routing smoke ----------------------------------------------------

test('shader stages are prefixed and blend-fs is editable', async ({ page }) => {
  await boot(page)

  const keys = await page.evaluate(() => window.__viz!.getShaderSources().map((s) => s.key))
  expect(keys).toContain('blend-fs')
  expect(keys).toContain('a.render-fs')
  expect(keys).toContain('b.update-fs')

  const hashA = await page.evaluate(() => {
    window.__viz!.renderFrames(30)
    return window.__viz!.pixelHash()
  })

  // Text-replace edit of the live stock blend-fs source (mode 0 is the
  // default, so this affects the default render): force pure-red output.
  const { err: err1, matched } = await page.evaluate(() => {
    const stage = window.__viz!.getShaderSources().find((s) => s.key === 'blend-fs')!
    const edited = stage.source.replace('col = mix(a, b, uMix);', 'col = vec3(1.0, 0.0, 0.0);')
    return { err: window.__viz!.setShaderSource('blend-fs', edited), matched: edited !== stage.source }
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
  const err2 = await page.evaluate(() => window.__viz!.setShaderSource('blend-fs', 'void main() { syntax'))
  expect(err2).not.toBeNull()
  expect(err2!.toLowerCase()).toContain('error')

  await page.evaluate(() => window.__viz!.renderFrames(10))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

// --- Coverage for the other two registered combos (review finding: every
// registered scene needs a golden per CLAUDE.md, and blend-kaleido-lorenz is
// the pairing most exposed to child GL-state leakage — lorenz leaves BLEND
// enabled after render). Frame 60 bounds the grayscott combo's 16-substeps-
// per-frame cost on SwiftShader. -------------------------------------------

for (const combo of ['blend-kaleido-lorenz', 'blend-rd-flow'] as const) {
  test(`${combo} renders deterministically at frame 60`, async ({ page }) => {
    await page.goto(`/?test=1&seed=42&scene=${combo}&count=16384`)
    await page.waitForFunction(() => window.__viz !== undefined)
    await page.evaluate(() => window.__viz!.renderFrames(60))
    expect(await litPixelCount(page)).toBeGreaterThan(2000)
    await expect(page.locator('canvas')).toHaveScreenshot(`${combo}-seed42-f60.png`)
  })

  test(`${combo} replays byte-identically via loadSession`, async ({ page }) => {
    await page.goto(`/?test=1&seed=42&scene=${combo}&count=16384`)
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
