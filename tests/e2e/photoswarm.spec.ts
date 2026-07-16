import { expect, test } from '@playwright/test'

/**
 * Golden/behavioral tests for Photo Swarm (particles family): an imported
 * photo (or, in these tests, the procedural fallback image — no checked-in
 * asset needed) supplies each particle's home position + color; a spring
 * holds the swarm together at rest while bass-scaled turbulence and onset
 * shockwaves knock it apart. Same render-mode harness as particles.spec.ts,
 * parameterized by `?scene=photoswarm`.
 *
 * Perf note: same `?count=` test-mode override as particles.spec.ts's flow-
 * field goldens (docs/PARTICLES.md §9) — 16384 (the "128^2" ladder rung)
 * keeps SwiftShader runtime bounded while still exercising real GPGPU
 * ping-pong, the home/color textures, and aspect-fit behavior.
 */

const TEST_COUNT = 16384
const GOLDEN_FRAME = 90

async function boot(
  page: import('@playwright/test').Page,
  opts: { size?: string; count?: number; seed?: number } = {},
) {
  const count = opts.count ?? TEST_COUNT
  const seed = opts.seed ?? 42
  const size = opts.size ?? ''
  await page.goto(`/?test=1&seed=${seed}&scene=photoswarm&count=${count}${size}`)
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
    scene: { id: 'photoswarm', params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames,
    events: [],
  }
}

// --- Goldens: fallback image, frame 90 (this suite's own convention — same
// frame every other scene here uses). At the default params, demo bass never
// drops below ~0.3 (src/audio/engine.ts's publishDemoSignals), so turbulence
// is always at least a little live; frame 90 (t=3s at 30fps) lands the swarm
// visibly perturbed off its home pixels (not perfectly settled) while still
// clearly tracing the fallback image's radial-gradient-plus-blobs silhouette
// (not scattered into noise) — the "photo swarm" character the task asks for. ---

test('photoswarm renders deterministically at frame 90', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('photoswarm-seed42-f90.png')
})

test('photoswarm composes correctly at 9:16', async ({ page }) => {
  await boot(page, { size: '&w=360&h=640' })
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('photoswarm-9x16-f90.png')
})

test('photoswarm composes correctly at 1:1', async ({ page }) => {
  await boot(page, { size: '&w=480&h=480' })
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('photoswarm-1x1-f90.png')
})

// --- Non-blank guard (silent all-black regression) --------------------------

test('photoswarm canvas is not blank', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

// --- Determinism: two independent fresh boots of the natural render path
// (not via loadSession) must produce byte-identical pixels. ------------------

test('photoswarm is deterministic across two independent fresh boots', async ({ page, context }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  const hash1 = await page.evaluate(() => window.__viz!.pixelHash())

  const page2 = await context.newPage()
  await boot(page2)
  await page2.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  const hash2 = await page2.evaluate(() => window.__viz!.pixelHash())
  await page2.close()

  expect(hash2).toBe(hash1)
})

// --- Determinism: loadSession re-init, two runs, byte-identical pixelHash ---

test('photoswarm replays byte-identically via loadSession', async ({ page }) => {
  await boot(page)
  const doc = minimalDoc(GOLDEN_FRAME)
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

// --- Real-image path: setSceneImage -> record -> loadSession replay --------

test('a real image (via setSceneImage) records and replays byte-identically', async ({ page }) => {
  await boot(page, { count: 4096 })

  const RECORD_FRAMES = 45

  const result = await page.evaluate((frames) => {
    // A tiny 32x32 RGBA gradient, built right here rather than shipped as a
    // fixture file — small enough that a single non-chunked btoa/fromCharCode
    // is safe (4096 bytes, nowhere near the arg-count ceiling the chunked
    // codec in src/engine/imageCodec.ts exists to avoid for full-size images).
    const size = 32
    const bytes = new Uint8Array(size * size * 4)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4
        bytes[i] = Math.floor((x / (size - 1)) * 255)
        bytes[i + 1] = Math.floor((y / (size - 1)) * 255)
        bytes[i + 2] = 128
        bytes[i + 3] = 255
      }
    }
    const base64 = btoa(String.fromCharCode(...bytes))

    window.__viz!.setSceneImage(size, size, base64)
    window.__viz!.startRecording()
    window.__viz!.renderFrames(frames)
    const doc = window.__viz!.stopRecording()
    const hashAfterRecording = window.__viz!.pixelHash()

    window.__viz!.loadSession(doc)
    window.__viz!.renderFrames(frames)
    const hashAfterReplay = window.__viz!.pixelHash()

    return { hashAfterRecording, hashAfterReplay, doc }
  }, RECORD_FRAMES)

  expect(result.hashAfterReplay).toBe(result.hashAfterRecording)
  expect(await litPixelCount(page)).toBeGreaterThan(200)

  // The recorded doc actually carries the image (proves startRecording's
  // snapshot picked up setSceneImage's pending image, not just the default).
  const doc = result.doc as { scene: { image?: { width: number; height: number; data: string } } }
  expect(doc.scene.image?.width).toBe(32)
  expect(doc.scene.image?.height).toBe(32)
  expect(typeof doc.scene.image?.data).toBe('string')
})
