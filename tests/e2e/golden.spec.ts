import { expect, test } from '@playwright/test'

/**
 * Golden-image tests: boot the engine in deterministic render mode
 * (fixed timestep, seeded, synthetic signals), step to an exact frame,
 * and diff the canvas against a checked-in PNG. This is how agents verify
 * visual changes headlessly (ARCHITECTURE.md §5).
 */

async function boot(page: import('@playwright/test').Page, seed: number) {
  await page.goto(`/?test=1&seed=${seed}`)
  await page.waitForFunction(() => window.__viz !== undefined)
}

test('lissajous renders deterministically at frame 120', async ({ page }) => {
  await boot(page, 42)
  await page.evaluate(() => window.__viz!.renderFrames(120))
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(120)
  await expect(page.locator('canvas')).toHaveScreenshot('lissajous-seed42-f120.png')
})

test('canvas is not blank (guards silent all-black regressions)', async ({ page }) => {
  await boot(page, 42)
  await page.evaluate(() => window.__viz!.renderFrames(30))
  const litPixels = await page.evaluate(() => {
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
  expect(litPixels).toBeGreaterThan(500)
})

test('parameter changes alter the image (knob layer is live)', async ({ page }) => {
  await boot(page, 42)
  await page.evaluate(() => {
    window.__viz!.setParam('freqX', 7)
    window.__viz!.setParam('freqY', 5)
    window.__viz!.renderFrames(120)
  })
  await expect(page.locator('canvas')).toHaveScreenshot('lissajous-7-5-f120.png')
})

test('expression-bound params render deterministically (equations layer)', async ({ page }) => {
  await boot(page, 42)
  await page.evaluate(() => {
    // Stateful lfo + audio signal in one binding: exercises the DSL end-to-end
    // under fixed-timestep replay with the deterministic demo signals.
    window.__viz!.setBinding('freqX', '3 + floor(3 * lfo(0.2))')
    window.__viz!.setBinding('drift', '0.2 + smooth(bass, 0.1) * 0.8')
    window.__viz!.renderFrames(120)
  })
  await expect(page.locator('canvas')).toHaveScreenshot('lissajous-expr-f120.png')
})

test('mapped triggers and pulses render deterministically (mapping layer)', async ({ page }) => {
  await boot(page, 42)
  await page.evaluate(() => {
    window.__viz!.queueEvent({ type: 'key', key: '4', edge: 'down' })
    window.__viz!.renderFrames(30)
    window.__viz!.queueEvent({ type: 'trigger', index: 1 })
    window.__viz!.queueEvent({ type: 'key', key: ' ', edge: 'down' })
    window.__viz!.renderFrames(90)
  })
  await expect(page.locator('canvas')).toHaveScreenshot('lissajous-mapped-f120.png')
})

test('beat-driven expressions render deterministically (audio events)', async ({ page }) => {
  await boot(page, 42)
  await page.evaluate(() => {
    // Bindings read the detector's demo-mode onset/beat/beatPhase signals like any
    // other signal (engine.ts publishes them before the bindings loop runs).
    window.__viz!.setBinding('trail', '0.05 + 0.25 * env(0.005, 0.15, beat)')
    window.__viz!.setBinding('freqY', '2 + 2*step(0.5, beatPhase)')
    window.__viz!.renderFrames(120)
  })
  await expect(page.locator('canvas')).toHaveScreenshot('lissajous-beat-f120.png')
})
