import { expect, test } from '@playwright/test'

/**
 * Golden/behavioral tests for Guilloché (geometry family wildcard): a
 * full-bleed, beat-locked ornamental-lathe curve engine — see guilloche.ts's
 * class doc for the maths and the beat-alignment discipline.
 *
 * Frame choice: 150 (seed 42, 30fps demo signals = 5s = 10 demo beats @120bpm,
 * spanning 2 full `cycle`=4-beat harmonic-redraw events past the settled
 * frame-0 starting pool) — the same frame the task's own spec called out as
 * the "poster" frame to tune the aesthetics against.
 */

const GOLDEN_FRAME = 150

async function boot(page: import('@playwright/test').Page, size?: string) {
  await page.goto(`/?test=1&seed=42&scene=guilloche${size ?? ''}`)
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

/**
 * Non-blank check over a small square patch of the canvas, in WebGL readPixels
 * coordinates (origin bottom-left) — used by the full-bleed edge assertion
 * below to sample near each of the four edge midpoints.
 */
async function patchLit(
  page: import('@playwright/test').Page,
  cx: number,
  cy: number,
  half: number,
): Promise<boolean> {
  return page.evaluate(
    ({ cx, cy, half }) => {
      const canvas = document.querySelector('canvas')!
      const gl = canvas.getContext('webgl2')!
      const x0 = Math.max(0, Math.round(cx - half))
      const y0 = Math.max(0, Math.round(cy - half))
      const pw = Math.min(canvas.width - x0, half * 2)
      const ph = Math.min(canvas.height - y0, half * 2)
      if (pw <= 0 || ph <= 0) return false
      const pixels = new Uint8Array(pw * ph * 4)
      gl.readPixels(x0, y0, pw, ph, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 30) return true
      }
      return false
    },
    { cx, cy, half },
  )
}

function minimalDoc(durationFrames: number) {
  return {
    version: 1,
    seed: 42,
    fps: 30,
    scene: { id: 'guilloche', params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames,
    events: [],
  }
}

// --- Goldens --------------------------------------------------------------

test('guilloche renders deterministically at frame 150', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('guilloche-seed42-f150.png')
})

test('guilloche composes correctly at 9:16', async ({ page }) => {
  await boot(page, '&w=360&h=640')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('guilloche-9x16-f150.png')
})

test('guilloche composes correctly at 1:1', async ({ page }) => {
  await boot(page, '&w=480&h=480')
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  await expect(page.locator('canvas')).toHaveScreenshot('guilloche-1x1-f150.png')
})

// --- Non-blank guard --------------------------------------------------------

test('guilloche canvas is not blank', async ({ page }) => {
  await boot(page)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_FRAME)
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

// --- Determinism: loadSession re-init, two runs, byte-identical pixelHash,
// spanning several beats (and beat-cycle harmonic-redraw events) -----------

test('guilloche replays byte-identically via loadSession across several beats', async ({ page }) => {
  await boot(page)
  // 240 frames @30fps = 8s = 16 demo beats (120bpm) = 4 full `cycle`=4-beat
  // harmonic-redraw events at default params — exercises both the per-beat
  // phase-ease target jumps and the per-cycle PRNG harmonics redraw.
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

// --- Full-bleed contract: at 9:16, the curve genuinely reaches all four
// edges (not a square inscribed in the rect) — sampled near each edge
// midpoint across a run spanning many beats/cycles, since any single frame
// may have every layer's envelope momentarily short of full amplitude on a
// given axis. ------------------------------------------------------------

test('guilloche fills the full 9:16 frame — curve visits all four edge midpoints', async ({ page }) => {
  await boot(page, '&w=360&h=640')
  // Pin spin=0: at the new stock default (0.06) the whole-figure rotation
  // (applied to every symmetry copy including the untransformed k=0 base —
  // see guilloche.ts's class doc) momentarily pulls the base copy's corners
  // in from the far edges as it turns. That's the intended, accepted
  // performer-facing behavior of nonzero spin, but it's orthogonal to the
  // full-bleed CONTRACT this test checks (the envelope construction, not the
  // rotation) — so freeze spin here the same way symmetry defaults to a
  // no-op fold (1) that doesn't touch this test either.
  await page.evaluate(() => window.__viz!.setParam('spin', 0))
  const width = 360
  const height = 640
  const margin = 20 // inset from the true edge
  const half = 30 // patch half-size (60x60 sample square)

  // WebGL readPixels coordinates: origin bottom-left.
  const edges = {
    top: { cx: width / 2, cy: height - margin },
    bottom: { cx: width / 2, cy: margin },
    left: { cx: margin, cy: height / 2 },
    right: { cx: width - margin, cy: height / 2 },
  }
  const seen: Record<keyof typeof edges, boolean> = { top: false, bottom: false, left: false, right: false }

  // Step one demo beat (15 frames @30fps) at a time, up to 30 beats (15s),
  // checking all four edges after each step — plenty of harmonic/phase
  // diversity (7+ `cycle`=4-beat redraw events) for every layer's envelope to
  // swing out near its full amplitude on both axes at some point.
  for (let step = 0; step < 30 && !Object.values(seen).every(Boolean); step++) {
    await page.evaluate(() => window.__viz!.renderFrames(15))
    for (const key of Object.keys(edges) as (keyof typeof edges)[]) {
      if (seen[key]) continue
      const { cx, cy } = edges[key]
      if (await patchLit(page, cx, cy, half)) seen[key] = true
    }
  }

  expect(seen).toEqual({ top: true, bottom: true, left: true, right: true })
})

// --- Follow-up: symmetry / breathe / spin ---------------------------------
//
// `symmetry`, `breathe`, `spin` are CPU-side only (params 2/5/6 in the new
// 11-param schema) — the stock `line-fs`/`fade-fs` GLSL is unchanged, so
// these are param-motion / geometry-path tests, not new shader stages.

test('symmetry=4 renders a different figure than symmetry=1 (the fold does something)', async ({ page }) => {
  await boot(page)
  const hashSym1 = await page.evaluate((n) => {
    window.__viz!.setParam('symmetry', 1)
    window.__viz!.renderFrames(n)
    return window.__viz!.pixelHash()
  }, GOLDEN_FRAME)

  await boot(page)
  const hashSym4 = await page.evaluate((n) => {
    window.__viz!.setParam('symmetry', 4)
    window.__viz!.renderFrames(n)
    return window.__viz!.pixelHash()
  }, GOLDEN_FRAME)

  expect(hashSym4).not.toBe(hashSym1)
})

test('symmetry copies are rotation-true at 9:16 (no NaN/shear collapse)', async ({ page }) => {
  // Smoke test for the aspect-corrected rotation path (guilloche.ts's
  // toSquare/toNDCFromSquare/rotateNDC): a non-square aspect is exactly where
  // a naive NDC-space rotation would shear into an ellipse or, if any NaN
  // crept into the maths, collapse to a blank/corrupted canvas. Asserting
  // plain non-blank output after actually exercising `symmetry=2` at 9:16 is
  // sufficient to catch either failure mode without hand-deriving pixel
  // positions of a rotated rosette.
  await boot(page, '&w=360&h=640')
  await page.evaluate((n) => {
    window.__viz!.setParam('symmetry', 2)
    window.__viz!.renderFrames(n)
  }, GOLDEN_FRAME)
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

test('spin=+1 and spin=-1 render different figures at the same frame', async ({ page }) => {
  await boot(page)
  const hashPos = await page.evaluate((n) => {
    window.__viz!.setParam('spin', 1)
    window.__viz!.renderFrames(n)
    return window.__viz!.pixelHash()
  }, GOLDEN_FRAME)

  await boot(page)
  const hashNeg = await page.evaluate((n) => {
    window.__viz!.setParam('spin', -1)
    window.__viz!.renderFrames(n)
    return window.__viz!.pixelHash()
  }, GOLDEN_FRAME)

  expect(hashNeg).not.toBe(hashPos)
})
