import { expect, test, type Page } from '@playwright/test'

/**
 * Handoff glide (user request — "a glide for handoffs like the frame
 * glide"): when the recorded `handoff.fade` input signal is above the
 * engine's cut threshold at switch time, the outgoing scene's final frame
 * is captured full-res and dissolved over the incoming scene across the
 * given duration of transport time. Unset/below-threshold stays the
 * original hard cut (all pre-existing handoff goldens are untouched by
 * construction — they never set the signal).
 */

async function boot(page: Page) {
  await page.goto('/?test=1&seed=42&scene=lissajous')
  await page.waitForFunction(() => window.__viz !== undefined)
}

test('a glided switch shows the outgoing frame dissolving (differs from a hard cut), deterministically', async ({
  page,
}) => {
  // Hard cut baseline.
  await boot(page)
  const cutHash = await page.evaluate(() => {
    const viz = window.__viz!
    viz.renderFrames(30)
    viz.switchScene('julia')
    viz.renderFrames(2)
    return viz.pixelHash()
  })

  // Same switch with a 5s glide armed: the first post-switch frames must
  // show A's frame blended over julia — different pixels than the cut.
  const run = () =>
    boot(page).then(() =>
      page.evaluate(() => {
        const viz = window.__viz!
        viz.renderFrames(30)
        viz.setInputSignal('handoff.fade', 5)
        viz.renderFrames(1)
        viz.switchScene('julia')
        viz.renderFrames(1)
        return viz.pixelHash()
      }),
    )
  const fadeHash1 = await run()
  const fadeHash2 = await run()
  expect(fadeHash1).not.toBe(cutHash)
  expect(fadeHash2).toBe(fadeHash1) // the dissolve itself is deterministic
})

test('a recorded take with a glided handoff replays byte-identically', async ({ page }) => {
  await boot(page)
  const live = await page.evaluate(() => {
    const viz = window.__viz!
    viz.startRecording()
    viz.setInputSignal('handoff.fade', 2)
    viz.renderFrames(5)
    viz.switchScene('julia')
    viz.renderFrames(30) // mid-dissolve AND post-dissolve frames both covered
    const doc = viz.stopRecording()
    return { doc, hash: viz.pixelHash() }
  })

  const replayOnce = () =>
    boot(page).then(() =>
      page.evaluate((doc) => {
        const viz = window.__viz!
        viz.loadSession(doc)
        viz.renderFrames(35)
        return viz.pixelHash()
      }, live.doc),
    )
  expect(await replayOnce()).toBe(live.hash)
  expect(await replayOnce()).toBe(live.hash)
})

test('a glide dialed in BEFORE arming is baselined into the take (held-signal rule)', async ({ page }) => {
  await boot(page)
  const live = await page.evaluate(() => {
    const viz = window.__viz!
    // Set the dial pre-take, exactly what the UI knob does in rehearsal —
    // no frame rendered in between, so nothing but the baseline can carry it.
    viz.setInputSignal('handoff.fade', 3)
    viz.startRecording()
    viz.renderFrames(5)
    viz.switchScene('julia')
    viz.renderFrames(10)
    const doc = viz.stopRecording()
    return { doc, hash: viz.pixelHash() }
  })

  await boot(page)
  const replayHash = await page.evaluate((doc) => {
    const viz = window.__viz!
    viz.loadSession(doc)
    viz.renderFrames(15)
    return viz.pixelHash()
  }, live.doc)
  expect(replayHash).toBe(live.hash)
})
