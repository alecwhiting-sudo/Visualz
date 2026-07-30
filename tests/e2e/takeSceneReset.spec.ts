import { expect, test } from '@playwright/test'

/**
 * Regression for "the export looks totally different from what I performed"
 * (reported for a Tunnel × Terrain Mirror blend): a scene accumulates per-frame
 * simulation state (terrain scroll, tunnel ring phase, particle/force layouts)
 * from the moment it is created. `startRecording` used to snapshot only
 * params/bindings/shaders — NOT that sim state — while `loadSession` (replay &
 * export) rebuilds the scene COLD at frame 0. So a take armed after any
 * rehearsal/idle time started from wherever the sim had drifted to, but the
 * export started from zero: every frame diverged.
 *
 * The fix resets the live scene to its fresh seeded state at `startRecording`,
 * so the take begins exactly where the offline render will. This test proves it
 * by REHEARSING a stateful scene (terrain scrolls), recording a few frames, and
 * asserting the recorded take replays to the identical pixels — which only holds
 * if the record-start reset happened.
 */

test('a take recorded after rehearsal replays byte-identically (record-start scene reset)', async ({
  page,
}) => {
  await page.goto('/?test=1&seed=42&scene=terrain')
  await page.waitForFunction(() => window.__viz !== undefined)

  // REHEARSAL: run the scene forward so its scroll accumulates well past zero —
  // the "idle/rehearse before recording" that used to leak into the divergence.
  await page.evaluate(() => window.__viz!.renderFrames(120))
  const rehearsedHash = await page.evaluate(() => window.__viz!.pixelHash())

  // Record a short take FROM the rehearsed state, capturing what the live view
  // shows at take-frame 30.
  const liveHash = await page.evaluate(() => {
    window.__viz!.startRecording()
    window.__viz!.renderFrames(30)
    return window.__viz!.pixelHash()
  })

  // The record-start reset means the take did NOT keep rendering the rehearsed
  // (scroll-120+) view — it restarted from a fresh scene, so 30 recorded frames
  // look like a fresh scene at frame 30, not the rehearsed frame 150.
  expect(liveHash).not.toBe(rehearsedHash)

  const doc = await page.evaluate(() => window.__viz!.stopRecording())
  expect(doc).not.toBeNull()

  // Replay/export the take through the cold `loadSession` path and step to the
  // same take frame. THIS is the assertion that used to fail: the live take and
  // its export must be pixel-identical.
  const replayHash = await page.evaluate((d) => {
    window.__viz!.loadSession(d!)
    window.__viz!.renderFrames(30)
    return window.__viz!.pixelHash()
  }, doc)

  expect(replayHash).toBe(liveHash)
})
