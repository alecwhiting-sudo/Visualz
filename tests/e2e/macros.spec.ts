import { expect, test } from '@playwright/test'

/**
 * Macro controls (docs/MACROS.md): eight `ctl.N` slots that drive the current
 * scene's params positionally, with pickup semantics — a slot is dormant
 * (the param keeps its own value) until a NEW `ctl.N` value arrives, and every
 * `switchScene`/`loadSession`/cold construction resets every slot back to
 * dormant. Two kinds of proof, per the spec's §6:
 *
 * 1. Determinism (`?test=1` harness, no DOM): record a session whose ctl.N
 *    events span a scene-handoff switch, then replay it twice and assert
 *    byte-identical pixel hashes — this is the only way to prove engagement
 *    resets deterministically (a live/manual test can't observe "would this
 *    have engaged the same way on a second run").
 * 2. Real UI (no `window.__viz` — the real App shell doesn't boot that
 *    harness, see transport-ui.spec.ts): the studio panel's Knob must
 *    visibly go dormant -> engaged when a ctl.N value arrives. Headless
 *    Chromium's WebMIDI always rejects (midi.spec.ts), so hardware can't be
 *    simulated — `window.__vizLive.setInputSignal` (App.tsx) is the seam,
 *    exactly what a mapped CC would have written, called directly against the
 *    real live-mode Engine.
 */

// --- 1. Determinism across a handoff (?test=1 harness) ----------------------

async function boot(page: import('@playwright/test').Page, scene: string, seed = 42) {
  await page.goto(`/?test=1&seed=${seed}&scene=${scene}`)
  await page.waitForFunction(() => window.__viz !== undefined)
}

/** Records a session whose ctl.1/ctl.2 events span a lissajous -> tunnel
 * handoff (the same golden pair handoff.spec.ts uses for this scene combo). */
async function recordMacroSession(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const viz = window.__viz!
    viz.startRecording()
    // Engage slot 1 (-> lissajous's freqX, param index 0) mid-A.
    viz.setInputSignal('ctl.1', 0.2)
    viz.renderFrames(10)
    viz.setInputSignal('ctl.1', 0.8)
    viz.renderFrames(10)
    // Handoff: B (tunnel) must NOT inherit slot 1's stale engagement — its
    // param index 0 ("speed") should stay at its own default/current value
    // until a fresh ctl event arrives post-switch.
    viz.switchScene('tunnel')
    viz.renderFrames(10)
    // Engage slot 2 (-> tunnel's "twist", param index 1) post-switch.
    viz.setInputSignal('ctl.2', 0.6)
    viz.renderFrames(15)
    return viz.stopRecording()
  })
}

test('ctl.N events spanning a handoff switch replay byte-identically, twice', async ({ page }) => {
  await boot(page, 'lissajous')
  const doc = await recordMacroSession(page)
  const liveFrame = await page.evaluate(() => window.__viz!.frame())
  const liveHash = await page.evaluate(() => window.__viz!.pixelHash())
  expect(liveFrame).toBe(45)

  // `loadSession` requires the constructed scene to match `doc.scene.id` (the
  // *initial* scene, lissajous) — the live engine above already switched
  // in-place to tunnel while recording, same as handoff.spec.ts's equivalent
  // replay-across-a-switch test. Re-boot fresh before each replay.
  const replayOnce = () =>
    boot(page, 'lissajous').then(() =>
      page.evaluate((sessionDoc) => {
        window.__viz!.loadSession(sessionDoc)
        window.__viz!.renderFrames(45)
        return window.__viz!.pixelHash()
      }, doc),
    )

  const run1 = await replayOnce()
  expect(run1).toBe(liveHash)

  // CLAUDE.md's double-run rule: replay a second time and assert byte-identity
  // — macro pickup (engagement resetting on switchScene/loadSession) is
  // exactly the kind of state this project's determinism rules exist to
  // protect, so a repeat run confirms it isn't a fluke.
  const run2 = await replayOnce()
  expect(run2).toBe(liveHash)
  expect(run2).toBe(run1)

  // A third run for good measure.
  const run3 = await replayOnce()
  expect(run3).toBe(liveHash)
})

test('a slot engaged before a switch does not drive the new scene until re-engaged post-switch', async ({ page }) => {
  await boot(page, 'lissajous')

  // Engage slot 1 hard: ctl=1 drives lissajous's param index 0 (freqX,
  // [1,12] step 1) to its max — sanity-checks the router actually works
  // before testing what happens across a switch.
  await page.evaluate(() => {
    window.__viz!.setInputSignal('ctl.1', 1)
    window.__viz!.renderFrames(5)
  })
  expect(await page.evaluate(() => window.__viz!.getParam('freqX'))).toBe(12)

  // Switch to tunnel WITHOUT ever sending a fresh ctl.1. If pickup did not
  // reset, the router would immediately drive tunnel's param index 0
  // ("speed", [0.2,3]) from the STALE ctl.1=1 still sitting on the bus, to
  // 3 (its max) — instead it must stay at tunnel's own default, 1.
  await page.evaluate(() => {
    window.__viz!.switchScene('tunnel')
    window.__viz!.renderFrames(1)
  })
  expect(await page.evaluate(() => window.__viz!.getParam('speed'))).toBe(1)

  // Confirms the slot isn't just permanently dead post-switch — a FRESH
  // ctl.1 event re-engages it, now against tunnel's param index 0.
  await page.evaluate(() => {
    window.__viz!.setInputSignal('ctl.1', 1)
    window.__viz!.renderFrames(1)
  })
  expect(await page.evaluate(() => window.__viz!.getParam('speed'))).toBe(3)
})

// --- 2. Real UI: dormant -> touch -> engaged (no window.__viz here) --------

test('studio knob goes dormant -> engaged when a ctl.N value arrives', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.panel')).toBeVisible()
  await page.waitForFunction(() => window.__vizLive !== undefined)

  const freqXKnob = page.locator('.knob').filter({ hasText: 'X frequency' })
  await expect(freqXKnob).toBeVisible()
  const valueEl = freqXKnob.locator('em')

  // Dormant: renders freqX's plain numeric value (default 3), no macro class.
  await expect(valueEl).toHaveText('3.00')
  await expect(freqXKnob).not.toHaveClass(/knob-macro/)

  // Touch: a ctl.1 value arrives (what a mapped hardware CC would publish) —
  // the knob must go live within one 100ms poll tick.
  await page.evaluate(() => window.__vizLive!.setInputSignal('ctl.1', 1))

  // Engaged: source hint flips to "ctl 1" and the accent macro styling kicks in.
  await expect(valueEl).toHaveText('ctl 1')
  await expect(freqXKnob).toHaveClass(/knob-macro/)
})
