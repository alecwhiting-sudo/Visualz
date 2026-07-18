import { expect, test, type Page } from '@playwright/test'

/**
 * Crossfader contract (user report: "mix … seems not to allow for fully
 * exclusive view of one algorithm at either end"): on a composite scene the
 * `mix` fader must show ONLY deck A at 0 and ONLY deck B at 1 in EVERY
 * blend mode — the mode's character (add/multiply/screen) lives in the
 * middle of the travel. The old modes 1-3 were dry/wet dials (`mix(a,
 * blend(a,b), uMix)`), so B was never reachable alone.
 *
 * Proof without external references: at a fixed frame, the mix=0 hash must
 * be identical ACROSS all four modes (they all show pure A), the mix=1 hash
 * identical across all modes (pure B), and the two ends must differ.
 */

const FRAME = 40

async function hashAt(page: Page, mode: number, mix: number): Promise<string> {
  await page.goto('/?test=1&seed=42&scene=blend-tunnel-morph')
  await page.waitForFunction(() => window.__viz !== undefined)
  return page.evaluate(
    ({ mode, mix, frames }) => {
      const viz = window.__viz!
      viz.setParam('mode', mode)
      viz.setParam('mix', mix)
      viz.renderFrames(frames)
      return viz.pixelHash()
    },
    { mode, mix, frames: FRAME },
  )
}

test('mix=0 shows only deck A and mix=1 only deck B, in every blend mode', async ({ page }) => {
  const atZero: string[] = []
  const atOne: string[] = []
  for (let mode = 0; mode < 4; mode++) {
    atZero.push(await hashAt(page, mode, 0))
    atOne.push(await hashAt(page, mode, 1))
  }
  // All modes agree at each end — the mode cannot leak into a full-A or
  // full-B view.
  expect(new Set(atZero).size).toBe(1)
  expect(new Set(atOne).size).toBe(1)
  // And the ends genuinely show different scenes.
  expect(atZero[0]).not.toBe(atOne[0])
})

test('the middle of the travel still carries the blend character (modes differ at mix=0.5)', async ({ page }) => {
  const midCrossfade = await hashAt(page, 0, 0.5)
  const midAdd = await hashAt(page, 1, 0.5)
  const midMultiply = await hashAt(page, 2, 0.5)
  expect(midAdd).not.toBe(midCrossfade)
  expect(midMultiply).not.toBe(midCrossfade)
})
