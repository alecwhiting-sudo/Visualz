import { expect, test } from '@playwright/test'

/**
 * Particles family golden/behavioral tests (docs/PARTICLES.md §9). Same
 * render-mode harness as golden.spec.ts, parameterized by `?scene=`.
 *
 * Perf note: docs/PARTICLES.md's default particle count (65536, the "256²"
 * ladder rung) times 90 GPGPU-update + point-render frames per test, times six
 * size/scene combinations, is expensive on SwiftShader's software rasterizer —
 * the flow field's update fragment alone does ~32 hash32 evaluations per
 * particle per frame (2 octaves × 4 finite-difference taps × 4 lattice corners).
 * `?count=` (accepted flags in docs/PARTICLES.md §0 / src/testing/hooks.ts) bakes
 * a smaller ladder rung for test mode only — goldens here use 16384 (the "128²"
 * rung), which keeps the whole spec well under budget while still exercising
 * real GPGPU ping-pong, respawn, and aspect-fit behavior. See the final report
 * for the measured full-suite runtime.
 */

const TEST_COUNT = 16384

async function boot(
  page: import('@playwright/test').Page,
  scene: string,
  opts: { size?: string; count?: number } = {},
) {
  const count = opts.count ?? TEST_COUNT
  const size = opts.size ?? ''
  await page.goto(`/?test=1&seed=42&scene=${scene}&count=${count}${size}`)
  await page.waitForFunction(() => window.__viz !== undefined)
}

// --- Goldens: flowfield f90 (docs/PARTICLES.md §8 — the flow field is
// non-chaotic so any frame count is stable). ----------------------------------

test('flowfield renders deterministically at frame 90', async ({ page }) => {
  await boot(page, 'flowfield')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(90)
  await expect(page.locator('canvas')).toHaveScreenshot('flowfield-seed42-f90.png')
})

test('flowfield composes correctly at 9:16', async ({ page }) => {
  await boot(page, 'flowfield', { size: '&w=360&h=640' })
  await page.evaluate(() => window.__viz!.renderFrames(90))
  await expect(page.locator('canvas')).toHaveScreenshot('flowfield-9x16-f90.png')
})

test('flowfield composes correctly at 1:1', async ({ page }) => {
  await boot(page, 'flowfield', { size: '&w=480&h=480' })
  await page.evaluate(() => window.__viz!.renderFrames(90))
  await expect(page.locator('canvas')).toHaveScreenshot('flowfield-1x1-f90.png')
})

// --- Non-blank guards (silent all-black regression) ---------------------------

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

test('flowfield canvas is not blank', async ({ page }) => {
  await boot(page, 'flowfield')
  await page.evaluate(() => window.__viz!.renderFrames(90))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

// --- Determinism: loadSession re-init, two runs, byte-identical pixelHash -----

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

test('flowfield replays byte-identically via loadSession', async ({ page }) => {
  await boot(page, 'flowfield')
  const doc = minimalDoc('flowfield', 90)
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

// --- Behavioral: live animation, count re-init, onset impulse -----------------

test('flowfield keeps animating (hash at f30 differs from f90)', async ({ page }) => {
  await boot(page, 'flowfield')
  const hash30 = await page.evaluate(() => {
    window.__viz!.renderFrames(30)
    return window.__viz!.pixelHash()
  })
  const hash90 = await page.evaluate(() => {
    window.__viz!.renderFrames(60) // now at frame 90
    return window.__viz!.pixelHash()
  })
  expect(hash90).not.toBe(hash30)
})

// Count re-init (docs/PARTICLES.md §6): a `setParam('count', v)` change snaps to
// the ladder and re-seeds deterministically from the stored seed at the top of
// the next update() — a "reset burst" whose replay is byte-identical for the
// same seed/count, and visually distinct from never changing count.
//
// Uses the ladder floor (4096) as this test's own starting count — independent
// of the goldens' `?count=` override above — so the resize step stays cheap
// regardless of what count the goldens bake in.
test('count re-init is deterministic and visually distinct', async ({ page }) => {
  await boot(page, 'flowfield', { count: 4096 })
  const resized1 = await page.evaluate(() => {
    window.__viz!.setParam('count', 16384)
    window.__viz!.renderFrames(60)
    return window.__viz!.pixelHash()
  })

  await boot(page, 'flowfield', { count: 4096 })
  const resized2 = await page.evaluate(() => {
    window.__viz!.setParam('count', 16384)
    window.__viz!.renderFrames(60)
    return window.__viz!.pixelHash()
  })
  expect(resized2).toBe(resized1)

  await boot(page, 'flowfield', { count: 4096 })
  const unresized = await page.evaluate(() => {
    window.__viz!.renderFrames(60)
    return window.__viz!.pixelHash()
  })
  expect(unresized).not.toBe(resized1)
})

// Onset impulse (docs/PARTICLES.md §5): uPulse's CPU envelope pulls particles
// toward the field's centre. The real onset signal is a one-frame detector
// pulse; setInputSignal here holds it high instead (persists on the bus until
// changed again) — a stronger, still-deterministic perturbation that's enough
// to diverge the two runs' pixel hashes, which is all this test needs.
test('onset impulse changes the rendered swarm', async ({ page }) => {
  await boot(page, 'flowfield')
  const unpulsed = await page.evaluate(() => {
    window.__viz!.renderFrames(60)
    return window.__viz!.pixelHash()
  })

  await boot(page, 'flowfield')
  const pulsed = await page.evaluate(() => {
    window.__viz!.renderFrames(40)
    window.__viz!.setInputSignal('onset', 1)
    window.__viz!.renderFrames(20)
    return window.__viz!.pixelHash()
  })

  expect(pulsed).not.toBe(unpulsed)
})
