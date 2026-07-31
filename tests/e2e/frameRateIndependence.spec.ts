import { expect, test } from '@playwright/test'

/**
 * Terrain "what I see live is what exports" guard (see terrain.ts's class doc).
 *
 * The live loop renders at the DISPLAY refresh (~120Hz) while an export steps at
 * a fixed output fps (30/60). Terrain's scroll and trail fade are dt-paced so the
 * same performance covers the same ground and holds the same trail length per
 * wall-second at any frame rate. This renders terrain to the SAME wall-clock time
 * at 30/60/120fps and asserts the results match on the things that actually
 * caused the regressions:
 *
 *   - scroll distance is frame-rate INDEPENDENT (the old per-call scroll flew
 *     slower on a low-fps export → piled-up wash-out);
 *   - the wireframe lines stay FULLY BRIGHT at every rate (the reverted fix
 *     scaled the additive deposit down, dimming lines to "terrain missing" on a
 *     60fps export — so we assert peak brightness is preserved, not just the
 *     total, which that fix held invariant by construction while the lines
 *     vanished).
 *
 * Determinism is unchanged — export/replay always step at a fixed dt — so this is
 * a wall-clock-equivalence check across rates, not a determinism check.
 */

const SECONDS = 5

async function probe(page: import('@playwright/test').Page, fps: number) {
  await page.goto(`/?test=1&seed=42&scene=terrain&fps=${fps}`)
  await page.waitForFunction(() => window.__viz !== undefined)
  await page.evaluate((n) => window.__viz!.renderFrames(n), SECONDS * fps)
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas')!
    const gl = canvas.getContext('webgl2')!
    const px = new Uint8Array(canvas.width * canvas.height * 4)
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px)
    let lit = 0
    let max = 0
    for (let i = 0; i < px.length; i += 4) {
      const v = px[i] + px[i + 1] + px[i + 2]
      if (v > 30) lit++
      if (v > max) max = v
    }
    const scroll = (window.__viz as { getParam(n: string): number }).getParam('#scrollDistance')
    return { lit, max, scroll }
  })
}

test('terrain scroll distance is frame-rate independent', async ({ page }) => {
  const a = await probe(page, 30)
  const b = await probe(page, 60)
  const c = await probe(page, 120)
  // speed 1 × SCROLL_PER_SEC(4) × 5s = 20 units, at every frame rate.
  expect(a.scroll).toBeCloseTo(20, 3)
  expect(b.scroll).toBeCloseTo(20, 3)
  expect(c.scroll).toBeCloseTo(20, 3)
})

test('terrain wireframe stays fully bright at every frame rate (no dim/missing export)', async ({ page }) => {
  const a = await probe(page, 30)
  const b = await probe(page, 60)
  const c = await probe(page, 120)
  // Peak line brightness must be preserved across rates — the reverted fix let
  // this collapse on 60fps. Near-saturated (>500/765) at all rates, within 15%.
  for (const m of [a, b, c]) {
    expect(m.max).toBeGreaterThan(500)
    expect(m.lit).toBeGreaterThan(2000) // clearly a terrain, never blank
  }
  // Peak brightness must not COLLAPSE at any rate. The reverted deposit-scaling
  // dropped 60fps peak to ~0.55x (ratio ~1.8); this bound catches that with wide
  // margin. It is deliberately loose: `max` is line-deposit PLUS the near-static
  // glow, which legitimately rises ~11% with fps (581/614/645), so a tight bound
  // would be brittle to future speed/glow/fade tweaks without adding real signal.
  const maxes = [a.max, b.max, c.max]
  expect(Math.max(...maxes) / Math.min(...maxes)).toBeLessThan(1.3)
})
