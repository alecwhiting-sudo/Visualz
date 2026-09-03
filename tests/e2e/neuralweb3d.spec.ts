import { expect, test } from '@playwright/test'

/**
 * Golden/behavioral tests for Neural Web 3D (geometry family, meta.framing =
 * 'bounded'): a 3D force-directed graph viewed through an orbiting perspective
 * camera. See neuralweb3d.ts's class doc for the split-pulse redesign and the
 * fixed-sub-step force sim.
 *
 * Frame choice: 180 (seed 42) — enough update()s for the seed cluster to grow
 * via beat-spawns, the camera to have orbited visibly, and several pulses to
 * have travelled and split.
 */

const GOLDEN_FRAME = 180

async function boot(page: import('@playwright/test').Page, size?: string) {
  await page.goto(`/?test=1&seed=42&scene=neuralweb3d${size ?? ''}`)
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
    scene: { id: 'neuralweb3d', params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames,
    events: [],
  }
}

// --- Goldens ----------------------------------------------------------------

test('neuralweb3d renders deterministically at frame 180', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('neuralweb3d-seed42-f180.png', { timeout: 60_000 })
})

test('neuralweb3d composes correctly at 9:16', async ({ page }) => {
  await boot(page, '&w=360&h=640')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('neuralweb3d-9x16-f180.png', { timeout: 60_000 })
})

test('neuralweb3d composes correctly at 1:1', async ({ page }) => {
  await boot(page, '&w=480&h=480')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('neuralweb3d-1x1-f180.png', { timeout: 60_000 })
})

// --- Non-blank guards --------------------------------------------------------

test('neuralweb3d canvas is not blank', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await litPixelCount(page)).toBeGreaterThan(100)
})

test('neuralweb3d at 16:9, 9:16, and 1:1 are all non-blank', async ({ page }) => {
  for (const size of ['', '&w=360&h=640', '&w=480&h=480']) {
    await boot(page, size)
    await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
    expect(await litPixelCount(page)).toBeGreaterThan(100)
  }
})

// --- Contract: render() is pure ---------------------------------------------

test('neuralweb3d render() is pure: re-rendering the same frame is byte-identical', async ({ page }) => {
  await boot(page)
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

// --- Contract: frame-rate independence (preview == export) ------------------

async function probeAtFps(page: import('@playwright/test').Page, fps: number, seconds: number) {
  await boot(page, `&fps=${fps}`)
  await page.evaluate((n) => window.__viz!.renderFrames(n), Math.round(seconds * fps))
  return litPixelCount(page)
}

test('neuralweb3d looks the same at 30/60/120fps at equal wall-clock time', async ({ page }) => {
  const seconds = 4
  const a = await probeAtFps(page, 30, seconds)
  const b = await probeAtFps(page, 60, seconds)
  const c = await probeAtFps(page, 120, seconds)
  for (const lit of [a, b, c]) expect(lit).toBeGreaterThan(100)
  const hi = Math.max(a, b, c)
  const lo = Math.min(a, b, c)
  expect(hi / lo).toBeLessThan(1.1)
})

// dt-paced state invariant (terrain.spec.ts:117-129 pattern): orbitAngle and
// injectCounter are both advanced only in update(), directly paced by
// frame.dt — same wall-clock time must land on the same values regardless of
// how many update() calls it took to get there.
async function probeStateAtFps(page: import('@playwright/test').Page, fps: number, seconds: number) {
  await boot(page, `&fps=${fps}`)
  await page.evaluate((n) => window.__viz!.renderFrames(n), Math.round(seconds * fps))
  return page.evaluate(() => ({
    orbitAngle: (window.__viz as { getParam(n: string): number }).getParam('#orbitAngle'),
    injections: (window.__viz as { getParam(n: string): number }).getParam('#injections'),
  }))
}

test('neuralweb3d orbit/injection state is dt-paced: equal at 30/60/120fps at equal wall-clock time', async ({ page }) => {
  const seconds = 4
  const a = await probeStateAtFps(page, 30, seconds)
  const b = await probeStateAtFps(page, 60, seconds)
  const c = await probeStateAtFps(page, 120, seconds)
  for (const p of [a, b, c]) expect(p.orbitAngle).toBeCloseTo(a.orbitAngle, 4)
  for (const p of [a, b, c]) expect(p.injections).toBe(a.injections)
})

// --- Keep-alive: pulses survive a long bass-transient drought ----------------

// Regression for the dead-web bug: the bass-transient detector can go 15+
// seconds without firing on real music while cascades live only ~9s, so the
// web would go fully dark. Holding `bass` steady (no transient, since jump =
// bass - bassEnv settles near 0 once the envelope tracks it) for a long
// stretch must still keep injections growing (via the dt-paced keep-alive)
// and pulses alive at the end, rather than freezing/dying out.
test('neuralweb3d pulses stay alive under sustained bass (no transients)', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => window.__viz!.setInputSignal('bass', 0.75))
  const initialInjections = await page.evaluate(() => (window.__viz as unknown as { getParam(n: string): number }).getParam('#injections'))

  // 8s of frames at 60fps, in chunks so a single evaluate() doesn't run long.
  const chunk = 60
  const totalFrames = 480
  for (let done = 0; done < totalFrames; done += chunk) {
    await page.evaluate((n) => window.__viz!.renderFrames(n), chunk)
  }

  const finalInjections = await page.evaluate(() => (window.__viz as unknown as { getParam(n: string): number }).getParam('#injections'))
  const activePulses = await page.evaluate(() => (window.__viz as unknown as { getParam(n: string): number }).getParam('#activePulses'))

  expect(finalInjections - initialInjections).toBeGreaterThan(3)
  expect(activePulses).toBeGreaterThan(0)
})

// --- Determinism: byte-identical replay via loadSession ---------------------

test('neuralweb3d replays byte-identically via loadSession', async ({ page }) => {
  await boot(page)
  const doc = minimalDoc(240)
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
