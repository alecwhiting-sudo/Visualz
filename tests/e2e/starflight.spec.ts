import { expect, test } from '@playwright/test'

/**
 * Golden/behavioral tests for Star Flight (geometry family): a warp-speed
 * starfield flythrough where stars streak into radial hyperspace lines at
 * high speed, with bass hits punching warp bursts. See starflight.ts's class
 * doc for the pure-hash respawn + frame-clocked travel determinism discipline.
 *
 * Frame choice: 150 (seed 42) — matches terrain.spec.ts's convention, and
 * comfortably past the point where the nearest stars in the 1200-star pool
 * have wrapped (respawned via the pure hash) at least once at the default
 * speed, so the golden exercises both the initial-PRNG and hash-respawn paths.
 */

const GOLDEN_FRAME = 150

async function boot(page: import('@playwright/test').Page, size?: string) {
  await page.goto(`/?test=1&seed=42&scene=starflight${size ?? ''}`)
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
    scene: { id: 'starflight', params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames,
    events: [],
  }
}

// --- Goldens ----------------------------------------------------------------

test('starflight renders deterministically at frame 150', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('starflight-seed42-f150.png')
})

test('starflight composes correctly at 9:16', async ({ page }) => {
  await boot(page, '&w=360&h=640')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('starflight-9x16-f150.png')
})

test('starflight composes correctly at 1:1', async ({ page }) => {
  await boot(page, '&w=480&h=480')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('starflight-1x1-f150.png')
})

// --- Non-blank guards --------------------------------------------------------

test('starflight canvas is not blank', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await litPixelCount(page)).toBeGreaterThan(500)
})

test('starflight at 16:9, 9:16, and 1:1 are all non-blank', async ({ page }) => {
  for (const size of ['', '&w=360&h=640', '&w=480&h=480']) {
    await boot(page, size)
    await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
    expect(await litPixelCount(page)).toBeGreaterThan(500)
  }
})

// --- Determinism: loadSession re-init, two runs, byte-identical pixelHash,
// spanning enough frames that many stars have wrapped/respawned repeatedly ---

test('starflight replays byte-identically via loadSession across a long flight', async ({ page }) => {
  await boot(page)
  const doc = minimalDoc(300)
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

// --- Scene Contract (docs/SCENE_CONTRACT.md), migrated from the old fade pass ---

test('starflight render() is pure: re-rendering the same frame is byte-identical', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  const a = await page.evaluate(() => { window.__viz!.rerender(); return window.__viz!.pixelHash() })
  const b = await page.evaluate(() => { window.__viz!.rerender(); return window.__viz!.pixelHash() })
  expect(b).toBe(a)
})

test('starflight travel is dt-paced: same distance per wall-second at 30/60/120fps', async ({ page }) => {
  // warpPulse=0 makes instSpeed constant (= speed), so travel = speed*TRAVEL_PER_SEC*t
  // exactly — a per-CALL advance would run 120fps ~4x as far as 30fps and this catches it.
  const seconds = 4
  const travelAt = async (fps: number) => {
    await boot(page, `&fps=${fps}`)
    await page.evaluate((n) => {
      window.__viz!.setParam('warpPulse', 0)
      window.__viz!.renderFrames(n)
    }, Math.round(seconds * fps))
    return page.evaluate(() => (window.__viz as { getParam(n: string): number }).getParam('#travel'))
  }
  const a = await travelAt(30)
  const b = await travelAt(60)
  const c = await travelAt(120)
  expect(a).toBeGreaterThan(0) // guard: the equality below is vacuous if travel never advanced
  expect(b).toBeCloseTo(a, 3)
  expect(c).toBeCloseTo(a, 3)
})
