import { expect, test } from '@playwright/test'

/**
 * The "what I saw is what exports" guarantee (user bug: a Tunnel × Terrain
 * Mirror performance "exported totally different — the terrain washed out and
 * flew at the wrong speed"). Root cause: the live loop runs update()/render()
 * once per rAF (the DISPLAY refresh, ~120Hz), while a fixed-fps export runs them
 * once per output frame (30/60). Any scene state advanced per-CALL (terrain's
 * scroll, its trail fade + additive deposit) therefore covered ~2x the ground
 * and rendered a different trail on a 60fps export than on a 120Hz live view —
 * the same session, two different videos.
 *
 * The fix paces that state on `frame.dt` (elapsed seconds): the scroll advances
 * by seconds, and the trail is an exact leaky-integrator discretization (fade
 * AND additive deposit both scaled by dt), so BOTH the scroll distance and the
 * trail brightness/length are invariant across frame rates. This spec renders
 * the SAME scene to the SAME wall-clock time at two fixed fps and asserts:
 *   1. scroll distance matches (the "flies too fast" symptom — exact),
 *   2. total frame brightness matches (the wash-out symptom),
 *   3. coarse structure matches.
 * All calibrated so the 30fps golden harness is byte-identical to pre-fix.
 * `?fps=` (testing/hooks.ts) selects the fixed-timestep rate.
 *
 * Terrain is the probe because it carries every frame-rate-dependent mechanism
 * at once (per-call scroll + per-render fade + additive deposit). Tunnel, by
 * contrast, is already time-driven (frame.time / frame.frame) and needs no fix.
 */

const SECONDS = 2 // wall-clock time both runs render to
const LOW_FPS = 30
const HIGH_FPS = 60

interface Shot {
  data: number[]
  width: number
  height: number
  scroll: number
}

async function renderShot(
  page: import('@playwright/test').Page,
  fps: number,
  seconds: number,
): Promise<Shot> {
  await page.goto(`/?test=1&seed=42&scene=terrain&fps=${fps}`)
  await page.waitForFunction(() => window.__viz !== undefined)
  const frames = Math.round(fps * seconds)
  return page.evaluate((n) => {
    window.__viz!.renderFrames(n)
    const canvas = document.querySelector('canvas')!
    const gl = canvas.getContext('webgl2')!
    const px = new Uint8Array(canvas.width * canvas.height * 4)
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px)
    return {
      data: Array.from(px),
      width: canvas.width,
      height: canvas.height,
      scroll: window.__viz!.getParam('#scrollDistance'),
    }
  }, frames)
}

test('terrain renders the same wall-clock frame at 30fps and 60fps (frame-rate independent)', async ({ page }) => {
  const low = await renderShot(page, LOW_FPS, SECONDS)
  const high = await renderShot(page, HIGH_FPS, SECONDS)

  expect(high.width).toBe(low.width)
  expect(high.height).toBe(low.height)

  // (1) Scroll distance — the exact invariant. dt-paced scroll covers `speed *
  // seconds` regardless of frame rate; before the fix the 60fps run advanced
  // twice as far (per-call step × twice as many calls) — scroll 4.0 vs 2.0.
  expect(low.scroll).toBeGreaterThan(0.5) // sanity: it actually scrolled
  expect(high.scroll).toBeCloseTo(low.scroll, 4)

  // (2) Total brightness — the wash-out probe. The additive trail is a leaky
  // integrator whose steady state is deposit/fade; pacing only the fade left it
  // fps-dependent (a 60fps frame came out ~1.6x brighter). Scaling the deposit
  // too pins brightness across frame rates.
  const totalLuma = (d: number[]) => {
    let s = 0
    for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
    return s
  }
  const ratio = totalLuma(high.data) / totalLuma(low.data)
  expect(ratio).toBeGreaterThan(0.93)
  expect(ratio).toBeLessThan(1.07)

  // (3) Coarse structure — average luma over tiles (cancels thin-line shimmer,
  // preserves where the terrain bulk and trail energy sit).
  const BLOCK = 20
  const { width, height } = low
  const lumaAt = (d: number[], x: number, y: number) => {
    const i = (y * width + x) * 4
    return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
  }
  let blocks = 0
  let sumAbsDiff = 0
  let litLow = 0
  for (let by = 0; by + BLOCK <= height; by += BLOCK) {
    for (let bx = 0; bx + BLOCK <= width; bx += BLOCK) {
      let ml = 0
      let mh = 0
      for (let y = by; y < by + BLOCK; y++) {
        for (let x = bx; x < bx + BLOCK; x++) {
          ml += lumaAt(low.data, x, y)
          mh += lumaAt(high.data, x, y)
        }
      }
      ml /= BLOCK * BLOCK
      mh /= BLOCK * BLOCK
      if (ml > 2) litLow++
      sumAbsDiff += Math.abs(ml - mh)
      blocks++
    }
  }
  expect(litLow).toBeGreaterThan(5) // non-blank (guards a vacuous pass)
  expect(sumAbsDiff / blocks).toBeLessThan(2)
})
