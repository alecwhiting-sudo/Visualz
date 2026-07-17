import { expect, test, type Page } from '@playwright/test'

/**
 * Task #37, two user reports in one spec:
 *
 * 1. "seems they only work when music playing … should work when music not
 *    playing to allow to get in position" — with a track loaded but stopped/
 *    paused, the live loop's frozen branch used to skip the tick ENTIRELY
 *    (the pause-freeze fix that stops Gray-Scott simmering), so macro routing
 *    never ran and every control was dead until ▶. The engine now runs a
 *    reduced "control tick" (route + render, no scene.update) whenever a
 *    control-surface mutation arrives while frozen.
 * 2. "can't switch between hardware knob tweaks versus software UI knob
 *    tweaks" — MacroRouter re-asserted the last hardware value every frame,
 *    clobbering UI edits on macro-driven params. Routing is edge-triggered
 *    now: last writer wins, hardware re-takes only when it actually moves.
 *
 * Real-app coverage (no `?test=1` harness — the frozen branch only exists in
 * the live loop). transport-ui.spec.ts calls deep audio interaction
 * impractical headlessly, but this scenario needs NO audible playback: the
 * WAV (generated below, decodeAudioData handles it fine in headless
 * Chromium) just has to decode so `hasFile` is true, then ⏹ puts the engine
 * in exactly the frozen state under test. `window.__vizLive.setInputSignal`
 * is the same mapped-CC seam macros.spec.ts uses; `setParam` is the same
 * UI-knob seam frames.spec.ts uses.
 */

import { wavFixture } from './wavFixture'

async function bootWithStoppedTrack(page: Page) {
  await page.goto('/')
  await expect(page.locator('.panel')).toBeVisible()
  await page.waitForFunction(() => window.__vizLive !== undefined)

  await page.getByRole('tab', { name: 'INPUTS' }).click()
  await page
    .locator('input[type=file][accept*="audio"]')
    .setInputFiles({ name: 'fixture.wav', mimeType: 'audio/wav', buffer: wavFixture(2) })

  // Decode auto-plays; the transport row appearing proves `hasFile`. Stop
  // rewinds to 0 and leaves the engine in the frozen (loaded, not playing)
  // state this spec exists to exercise.
  await expect(page.locator('.transport-row')).toBeVisible()
  await page.getByRole('button', { name: 'Stop and rewind' }).click()
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible()
}

function getParam(page: Page, name: string): Promise<number> {
  return page.evaluate((n) => window.__vizLive!.getParam(n), name)
}

test('macro knobs drive params while the track is loaded but stopped', async ({ page }) => {
  await bootWithStoppedTrack(page)

  // Lissajous param index 0 is freqX ([1,12] step 1, default 3): ctl.1 = 1
  // must drive it to 12 even though the transport is frozen.
  expect(await getParam(page, 'freqX')).toBe(3)
  await page.evaluate(() => window.__vizLive!.setInputSignal('ctl.1', 1))
  await expect.poll(() => getParam(page, 'freqX')).toBe(12)
})

test('UI edits stick on a macro-driven param; hardware re-takes only when it moves', async ({ page }) => {
  await bootWithStoppedTrack(page)

  // Engage slot 1 (hardware at full): freqX -> 12.
  await page.evaluate(() => window.__vizLive!.setInputSignal('ctl.1', 1))
  await expect.poll(() => getParam(page, 'freqX')).toBe(12)

  // A UI edit on the engaged param must STICK (edge-triggered routing) — the
  // old level-triggered router clobbered it back to 12 on the next tick.
  await page.evaluate(() => window.__vizLive!.setParam('freqX', 5))
  await expect.poll(() => getParam(page, 'freqX')).toBe(5)
  await page.waitForTimeout(300) // several ticks' worth of clobber opportunity
  expect(await getParam(page, 'freqX')).toBe(5)

  // The hardware actually moving re-takes the param: 1 + 0.5*11 = 6.5, step-
  // snapped to 7.
  await page.evaluate(() => window.__vizLive!.setInputSignal('ctl.1', 0.5))
  await expect.poll(() => getParam(page, 'freqX')).toBe(7)
})
