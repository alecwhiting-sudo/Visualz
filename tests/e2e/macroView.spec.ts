import { expect, test, type Page } from '@playwright/test'

/**
 * Knob-view toggle trial (docs/DECKS.md, user decision): on a deck
 * (blend-*) scene the 8 macro slots address ONE of four views, chosen by
 * the recorded `macro.view` input signal — 0 deck A (default), 1 deck B,
 * 2 fader-follows (mix < 0.5 → A, else B), 3 both (slot i drives A's AND
 * B's i-th param off one edge). Harness-level (`?test=1`, render mode):
 * `setInputSignal` is exactly what the UI toggle / a mapped CC writes, and
 * the fixed-step `renderFrames` makes each routing tick deterministic.
 *
 * Scene under test: blend-tunnel-morph — A = tunnel (a.speed [0.2,3],
 * default 1), B = morph (b.journeySpeed [0,0.2], default 0.04).
 */

async function boot(page: Page) {
  await page.goto('/?test=1&seed=42&scene=blend-tunnel-morph')
  await page.waitForFunction(() => window.__viz !== undefined)
}

function get(page: Page, name: string): Promise<number> {
  return page.evaluate((n) => window.__viz!.getParam(n), name)
}

test('view A (default) drives deck A params only; flipping views obeys pickup; B/Both/Fader route their decks', async ({
  page,
}) => {
  await boot(page)

  // Default view A: slot 1 -> a.speed.
  await page.evaluate(() => {
    window.__viz!.setInputSignal('ctl.1', 1)
    window.__viz!.renderFrames(1)
  })
  expect(await get(page, 'a.speed')).toBeCloseTo(3, 5)
  expect(await get(page, 'b.journeySpeed')).toBeCloseTo(0.04, 5)

  // Flip to view B with the ctl value UNCHANGED: pickup — B must not be
  // yanked to the stale hardware position.
  await page.evaluate(() => {
    window.__viz!.setInputSignal('macro.view', 1)
    window.__viz!.renderFrames(1)
  })
  expect(await get(page, 'b.journeySpeed')).toBeCloseTo(0.04, 5)

  // The knob actually moving now drives deck B; A keeps its value.
  await page.evaluate(() => {
    window.__viz!.setInputSignal('ctl.1', 0.5)
    window.__viz!.renderFrames(1)
  })
  expect(await get(page, 'b.journeySpeed')).toBeCloseTo(0.1, 5)
  expect(await get(page, 'a.speed')).toBeCloseTo(3, 5)

  // View Both: one knob movement lands on BOTH decks' first params.
  await page.evaluate(() => {
    window.__viz!.setInputSignal('macro.view', 3)
    window.__viz!.setInputSignal('ctl.1', 0.25)
    window.__viz!.renderFrames(1)
  })
  expect(await get(page, 'a.speed')).toBeCloseTo(0.2 + 0.25 * 2.8, 5)
  expect(await get(page, 'b.journeySpeed')).toBeCloseTo(0.05, 5)

  // View Fader with mix past 50%: knobs follow deck B.
  await page.evaluate(() => {
    window.__viz!.setInputSignal('macro.view', 2)
    window.__viz!.setParam('mix', 0.8)
    window.__viz!.setInputSignal('ctl.1', 0.75)
    window.__viz!.renderFrames(1)
  })
  expect(await get(page, 'b.journeySpeed')).toBeCloseTo(0.15, 5)
  expect(await get(page, 'a.speed')).toBeCloseTo(0.2 + 0.25 * 2.8, 5) // untouched since Both

  // Fader swings below 50%: same knob now drives deck A.
  await page.evaluate(() => {
    window.__viz!.setParam('mix', 0.2)
    window.__viz!.setInputSignal('ctl.1', 1)
    window.__viz!.renderFrames(1)
  })
  expect(await get(page, 'a.speed')).toBeCloseTo(3, 5)
  expect(await get(page, 'b.journeySpeed')).toBeCloseTo(0.15, 5)
})

test('view flips spanning a recording replay byte-identically', async ({ page }) => {
  await boot(page)

  // Record a short session that exercises A, a flip to Both, and a fader
  // crossing — the whole feature rides the ordinary setInputSignal event
  // path, so replay must reproduce the routing exactly.
  const doc = await page.evaluate(() => {
    const viz = window.__viz!
    viz.startRecording()
    viz.setInputSignal('ctl.1', 0.8)
    viz.renderFrames(5)
    viz.setInputSignal('macro.view', 3)
    viz.setInputSignal('ctl.1', 0.3)
    viz.renderFrames(5)
    viz.setInputSignal('macro.view', 2)
    viz.setParam('mix', 0.9)
    viz.setInputSignal('ctl.1', 0.6)
    viz.renderFrames(10)
    return viz.stopRecording()
  })
  const liveHash = await page.evaluate(() => window.__viz!.pixelHash())

  const replayOnce = () =>
    boot(page).then(() =>
      page.evaluate((sessionDoc) => {
        window.__viz!.loadSession(sessionDoc)
        window.__viz!.renderFrames(20)
        return window.__viz!.pixelHash()
      }, doc),
    )

  const run1 = await replayOnce()
  const run2 = await replayOnce()
  expect(run1).toBe(liveHash)
  expect(run2).toBe(liveHash)
})

test('a take armed while view B is already selected replays with view B, not the default A', async ({
  page,
}) => {
  await boot(page)

  // Select view B BEFORE recording (review finding: the view is held state —
  // without baselining it into the take, replay defaulted to view A and
  // routed every recorded ctl edge to the wrong deck).
  // The view is set but NO frame is rendered before arming: startSeconds
  // stays 0, so live and replay share exact frame times and the pixel
  // hashes are directly comparable. (A nonzero take start quantizes
  // startSeconds to 4 decimals — replay-vs-replay stays byte-identical,
  // but live-vs-replay hashes drift by that rounding; not what this test
  // is about.) The held-signal bug reproduces either way: `macro.view`
  // sits in inputSignals from the setInputSignal call alone.
  const live = await page.evaluate(() => {
    const viz = window.__viz!
    viz.setInputSignal('macro.view', 1)
    viz.startRecording()
    viz.setInputSignal('ctl.1', 0.5)
    viz.renderFrames(8)
    const doc = viz.stopRecording()
    return { doc, b: viz.getParam('b.journeySpeed'), a: viz.getParam('a.speed'), hash: viz.pixelHash() }
  })
  expect(live.b).toBeCloseTo(0.1, 5) // view B routed the knob to deck B live
  expect(live.a).toBeCloseTo(1, 5) // deck A untouched

  await boot(page)
  const replay = await page.evaluate((doc) => {
    const viz = window.__viz!
    viz.loadSession(doc)
    viz.renderFrames(8) // exactly durationFrames — lands on the same absolute frame as live
    return { b: viz.getParam('b.journeySpeed'), a: viz.getParam('a.speed'), hash: viz.pixelHash() }
  }, live.doc)
  expect(replay.b).toBeCloseTo(0.1, 5)
  expect(replay.a).toBeCloseTo(1, 5)
  expect(replay.hash).toBe(live.hash)
})

// --- Real-app UI: the toggle exists only on deck scenes and retargets ------

test('the Knobs A/B/Fader/Both toggle appears on a blend scene and retargets the hardware slots', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.locator('.panel')).toBeVisible()
  await page.waitForFunction(() => window.__vizLive !== undefined)

  // No toggle on an ordinary scene.
  await expect(page.locator('.macro-view-toggle')).toHaveCount(0)

  await page.locator('label.scene-select').filter({ hasText: /^Scene/ }).locator('select').selectOption('blend-tunnel-morph')
  const toggle = page.locator('.macro-view-toggle')
  await expect(toggle).toBeVisible()

  // Default view A: a ctl.1 arrival drives a.speed.
  await page.evaluate(() => window.__vizLive!.setInputSignal('ctl.1', 1))
  await expect.poll(() => page.evaluate(() => window.__vizLive!.getParam('a.speed'))).toBeCloseTo(3, 5)

  // Click B, move the knob: b.journeySpeed follows, a.speed holds.
  await toggle.getByRole('button', { name: 'B', exact: true }).click()
  await page.evaluate(() => window.__vizLive!.setInputSignal('ctl.1', 0.5))
  await expect.poll(() => page.evaluate(() => window.__vizLive!.getParam('b.journeySpeed'))).toBeCloseTo(0.1, 5)
  expect(await page.evaluate(() => window.__vizLive!.getParam('a.speed'))).toBeCloseTo(3, 5)
})
