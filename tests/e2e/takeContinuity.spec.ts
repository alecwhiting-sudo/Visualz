import { expect, test } from '@playwright/test'
import { wavFixture } from './wavFixture'

/**
 * Mid-take scene changes must never end the take (user report: a 6-minute
 * performance "chopped at 2 minutes" — the studio Scene dropdown was used
 * mid-take; it tore down the engine, and the recorder died with it while
 * audio and visuals carried on looking perfectly normal). While recording,
 * `onSceneChange` now delegates to the in-place RECORDED handoff switch
 * (`engine.switchScene`), so the dropdown and the "Switch (hand off)" button
 * behave identically for a running take: the take continues and the switch
 * replays (invariant I6).
 *
 * Real-app spec with real (silent-in-CI) audio: recording requires a playing
 * track, and headless Chromium runs the AudioContext fine — the WAV fixture
 * auto-plays on load, same seam as frozenControls.spec.ts.
 */

test('changing the Scene dropdown mid-take keeps recording and records the switch', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.panel')).toBeVisible()
  await page.waitForFunction(() => window.__vizLive !== undefined)

  await page.getByRole('tab', { name: 'INPUTS' }).click()
  await page
    .locator('input[type=file][accept*="audio"]')
    .setInputFiles({ name: 'fixture.wav', mimeType: 'audio/wav', buffer: wavFixture(20) })
  await expect(page.locator('.transport-row')).toBeVisible()

  // Track auto-plays on decode, so Arm starts the take immediately.
  await page.getByRole('button', { name: 'Arm' }).click()
  const endTakeButton = page.getByRole('button', { name: 'End take' })
  await expect(endTakeButton).toBeVisible()

  // Let the take run a little so it has nonzero duration, then change the
  // STUDIO Scene dropdown (back on the default PERFORM tab) mid-take.
  await page.getByRole('tab', { name: 'PERFORM' }).click()
  await page.waitForTimeout(500)
  await page
    .locator('label.scene-select')
    .filter({ hasText: /^Scene/ })
    .locator('select')
    .selectOption('julia')

  // The take must still be running (the old teardown path flipped this back
  // to "Arm" and stashed a chopped take), and the scene must have switched.
  await expect(endTakeButton).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.__vizLive!.sceneParams()[0].name))
    .not.toBe('freqX')

  await page.waitForTimeout(300)
  await endTakeButton.click()

  // The stashed doc spans the WHOLE take (both sides of the switch) and
  // contains the recorded switch event. Poll: the stash lands via React
  // state, a tick after the click.
  await expect.poll(() => page.evaluate(() => window.__vizLive!.lastSessionDoc() !== null)).toBe(true)
  const doc = (await page.evaluate(() => window.__vizLive!.lastSessionDoc())) as {
    scene: { id: string }
    durationFrames: number
    events: Array<{ type: string; toScene?: string }>
  } | null
  expect(doc).not.toBeNull()
  expect(doc!.scene.id).toBe('lissajous')
  expect(doc!.durationFrames).toBeGreaterThan(0)
  const switches = doc!.events.filter((e) => e.type === 'switch')
  expect(switches).toEqual([expect.objectContaining({ toScene: 'julia' })])
})
