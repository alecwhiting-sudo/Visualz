import { expect, test } from '@playwright/test'

/**
 * Gray-Scott reaction-diffusion (simulation family) golden/behavioral tests
 * (docs/GRAYSCOTT.md §7-8). Same render-mode harness as particles.spec.ts /
 * newscenes.spec.ts, parameterized by `?scene=grayscott&grid=`.
 *
 * Perf note: goldens and every determinism/behavioral check here bake the
 * `?grid=128` test-mode override (docs/GRAYSCOTT.md §9 accepted flag #2)
 * instead of the 256² ship default — 16 substeps × 128² is comfortably
 * cheaper than the particles family's 65536-particle update on SwiftShader.
 * See the final report for the measured full-spec runtime.
 */

const TEST_GRID = 128

async function boot(page: import('@playwright/test').Page, opts: { size?: string; seed?: number } = {}) {
  const seed = opts.seed ?? 42
  const size = opts.size ?? ''
  await page.goto(`/?test=1&seed=${seed}&scene=grayscott&grid=${TEST_GRID}${size}`)
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

function minimalDoc(durationFrames: number, seed = 42) {
  return {
    version: 1,
    seed,
    fps: 30,
    scene: { id: 'grayscott', params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames,
    events: [],
  }
}

// --- Goldens: frame 96 (1536 substeps), default Coral, at 3 aspects ---------
// docs/GRAYSCOTT.md §7: NOT flagged for Chromium-bump regeneration (RD is
// contractive and transcendental-free in the reaction shader) — still tuned
// to the shared maxDiffPixelRatio in playwright.config.ts for driver variance.

test('grayscott renders deterministically at frame 96', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => window.__viz!.renderFrames(96))
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(96)
  await expect(page.locator('canvas')).toHaveScreenshot('grayscott-seed42-f96.png')
})

test('grayscott composes correctly at 9:16', async ({ page }) => {
  await boot(page, { size: '&w=360&h=640' })
  await page.evaluate(() => window.__viz!.renderFrames(96))
  await expect(page.locator('canvas')).toHaveScreenshot('grayscott-9x16-f96.png')
})

test('grayscott composes correctly at 1:1', async ({ page }) => {
  await boot(page, { size: '&w=480&h=480' })
  await page.evaluate(() => window.__viz!.renderFrames(96))
  await expect(page.locator('canvas')).toHaveScreenshot('grayscott-1x1-f96.png')
})

// --- Non-blank guards (silent all-black regression), all 3 aspects ---------

test('grayscott canvas is not blank at 16:9', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => window.__viz!.renderFrames(96))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

test('grayscott canvas is not blank at 9:16', async ({ page }) => {
  await boot(page, { size: '&w=360&h=640' })
  await page.evaluate(() => window.__viz!.renderFrames(96))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

test('grayscott canvas is not blank at 1:1', async ({ page }) => {
  await boot(page, { size: '&w=480&h=480' })
  await page.evaluate(() => window.__viz!.renderFrames(96))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

// --- Determinism: loadSession re-init, two runs, byte-identical pixelHash --

test('grayscott replays byte-identically via loadSession at f96', async ({ page }) => {
  await boot(page)
  const doc = minimalDoc(96)
  const hash1 = await page.evaluate((d) => {
    window.__viz!.loadSession(d)
    window.__viz!.renderFrames(96)
    return window.__viz!.pixelHash()
  }, doc)
  const hash2 = await page.evaluate((d) => {
    window.__viz!.loadSession(d)
    window.__viz!.renderFrames(96)
    return window.__viz!.pixelHash()
  }, doc)
  expect(hash2).toBe(hash1)
})

// --- Behavioral: live animation, onset droplets, silence non-death, --------
// --- sustained-bass determinism, seed -> layout -----------------------------

test('grayscott keeps animating (hash at f48 differs from f96)', async ({ page }) => {
  await boot(page)
  const hash48 = await page.evaluate(() => {
    window.__viz!.renderFrames(48)
    return window.__viz!.pixelHash()
  })
  const hash96 = await page.evaluate(() => {
    window.__viz!.renderFrames(48) // now at frame 96
    return window.__viz!.pixelHash()
  })
  expect(hash96).not.toBe(hash48)
})

// Onset droplets (docs/GRAYSCOTT.md §4/§6): injected only on substep 0 of a
// frame where the onset signal is > 0.5. setInputSignal holds the signal high
// (persists on the bus, unlike the one-frame detector pulse) from f40 on —
// a stronger, still-deterministic perturbation that must diverge the run from
// an unpulsed baseline of the same length.
test('onset droplet injection diverges the field from the unpulsed baseline', async ({ page }) => {
  await boot(page)
  const unpulsed = await page.evaluate(() => {
    window.__viz!.renderFrames(96)
    return window.__viz!.pixelHash()
  })

  await boot(page)
  const pulsed = await page.evaluate(() => {
    window.__viz!.renderFrames(40)
    window.__viz!.setInputSignal('onset', 1)
    window.__viz!.renderFrames(56)
    return window.__viz!.pixelHash()
  })

  expect(pulsed).not.toBe(unpulsed)
})

// Silence non-death (docs/GRAYSCOTT.md §1/§8): with every signal at its 0
// fallback (no bass feed-modulation, no onset droplets), the default Coral
// preset must stay alive (not decay to a uniform dead field) through at
// least 300 frames (4800 substeps).
test('silence does not kill the pattern at f96 or f300', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => window.__viz!.renderFrames(96))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
  await page.evaluate(() => window.__viz!.renderFrames(204)) // now at frame 300
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(300)
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

// Sustained bass (docs/GRAYSCOTT.md §1's "audio stress" validation): bass=1
// permanently raises uF via the feed-modulation clamp (§6) for the whole run.
// Must stay bounded (non-blank) and, since nothing else is nondeterministic,
// byte-identical across two independent runs.
test('sustained bass=1 stays bounded and deterministic over 300 frames', async ({ page }) => {
  await boot(page)
  const run1 = await page.evaluate(() => {
    window.__viz!.setInputSignal('bass', 1)
    window.__viz!.renderFrames(300)
    return window.__viz!.pixelHash()
  })
  expect(await litPixelCount(page)).toBeGreaterThan(2000)

  await boot(page)
  const run2 = await page.evaluate(() => {
    window.__viz!.setInputSignal('bass', 1)
    window.__viz!.renderFrames(300)
    return window.__viz!.pixelHash()
  })
  expect(run2).toBe(run1)
})

// Seed -> layout (docs/GRAYSCOTT.md §6): the 18-spot seed nucleus placement is
// drawn from mulberry32(seed), so different seeds must produce a visibly
// different pattern at the golden frame.
test('different seeds produce different layouts at f96', async ({ page }) => {
  await boot(page, { seed: 42 })
  const hashSeed42 = await page.evaluate(() => {
    window.__viz!.renderFrames(96)
    return window.__viz!.pixelHash()
  })

  await boot(page, { seed: 7 })
  const hashSeed7 = await page.evaluate(() => {
    window.__viz!.renderFrames(96)
    return window.__viz!.pixelHash()
  })

  expect(hashSeed7).not.toBe(hashSeed42)
})

// --- Capability check (docs/GRAYSCOTT.md §9 / ARCHITECTURE.md §3.7): --------
// init() throws a message naming EXT_color_buffer_float when the extension
// is unavailable, same as the particle-family scenes. Boot-time init() throws
// synchronously out of the module script, so window.__viz never gets set and
// the failure surfaces as an uncaught page error instead of a rejected promise.

test('grayscott capability check throws naming EXT_color_buffer_float when unavailable', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))

  await page.addInitScript(() => {
    const proto = WebGL2RenderingContext.prototype
    const original = proto.getExtension
    proto.getExtension = function (this: WebGL2RenderingContext, name: string) {
      if (name === 'EXT_color_buffer_float') return null
      return original.call(this, name)
    } as typeof proto.getExtension
  })

  await page.goto(`/?test=1&seed=42&scene=grayscott&grid=${TEST_GRID}`)
  await page.waitForLoadState('load')

  expect(pageErrors.some((m) => m.includes('EXT_color_buffer_float'))).toBe(true)
  expect(await page.evaluate(() => window.__viz !== undefined)).toBe(false)
})
