import { expect, test, type Page } from '@playwright/test'

/**
 * Regression coverage for the take-baselining defect (architect-diagnosed):
 * `SessionRecorder` used to store event frames as ABSOLUTE `transport.frame`
 * values and `durationFrames` from the absolute end frame. Live-mode
 * `transport.frame` is a rAF tick counter that never resets, so a take armed
 * after any rehearsal — the standard flow (rehearse -> stop -> arm -> ▶) —
 * carried thousands of frames of dead lead-in: replays/exports ran far longer
 * than the actual performance, and every recorded event landed at the wrong
 * relative time.
 *
 * Every existing fixture (golden.spec.ts, export.spec.ts, mapping/handoff
 * specs) records via `window.__viz.startRecording()` against a FRESH
 * render-mode engine that always starts at frame 0 — the bug can only
 * reproduce against a real live-mode transport that has actually ticked
 * before recording starts, which is why this spec drives the REAL App UI
 * (performanceModel.spec.ts's conventions), not the `?test=1` harness, for
 * the live half of the flow.
 */

const footerRecordButton = (page: Page) =>
  page.locator('.panel-footer').getByRole('button', { name: /Arm|Armed|End take/ })

interface TakeDoc {
  seed: number
  fps: number
  durationFrames: number
  scene: { id: string }
  audio: { kind: string; startSeconds?: number }
}

/**
 * Demo mode (no audio file needed): rehearses for ~2s against the real live
 * engine, then arms-while-"playing" (demo mode is always dancing, so Arm
 * starts the take immediately — same path as performanceModel.spec.ts's third
 * test), runs ~1s, and ends the take. Returns the resulting `SessionDoc` via
 * `window.__vizLive.lastSessionDoc()`.
 */
async function recordPostRehearsalTake(page: Page): Promise<TakeDoc> {
  await page.goto('/')
  await page.waitForFunction(() => window.__vizLive !== undefined)

  // REHEARSAL: the live engine has been running (and dancing to demo signals)
  // since mount — this is exactly the dead lead-in that used to leak into the
  // take before this fix.
  await page.waitForTimeout(2000)

  await footerRecordButton(page).click() // arm-while-"playing": starts the take immediately
  await expect(page.locator('.panel-footer .perf-mode-line')).toHaveText(/^● TAKE \d+:\d{2}$/)

  await page.waitForTimeout(1000)
  await footerRecordButton(page).click() // ends the take

  const doc = await page.evaluate(() => window.__vizLive!.lastSessionDoc())
  expect(doc).not.toBeNull()
  return doc as TakeDoc
}

test.setTimeout(60_000)

test('a take recorded after rehearsal reports the PERFORMED length, not lead-in + performed (regression)', async ({
  page,
}) => {
  const doc = await recordPostRehearsalTake(page)

  // THE regression: before the fix, durationFrames was the absolute end frame
  // (~2s rehearsal + ~1s take = ~3s worth of frames at 60fps ≈ 180). Fixed,
  // it must be the ~1s PERFORMED length only. Tightened from the original
  // 0.3-2s band (Finding 2's fix): `transport.frame` is now `floor(time * fps)`
  // instead of a per-rAF-tick counter, so the take's frame count tracks real
  // elapsed seconds regardless of the test runner's actual rAF rate — a ~1s
  // `waitForTimeout` should now land within ~20%, not just "not obviously
  // still carrying the rehearsal" (the old loose band only ruled out the
  // ~3x-too-long regression, it didn't assert real-time accuracy).
  const performedSeconds = doc.durationFrames / doc.fps
  expect(performedSeconds).toBeGreaterThan(0.8)
  expect(performedSeconds).toBeLessThan(1.3)

  // The audio-start-offset half of the fix: this take started well into the
  // demo clock's run (~2s of rehearsal already elapsed), so startSeconds must
  // have been captured and be roughly that large — proving the engine baselined
  // the take's own time source, not just the frame counter.
  expect(doc.audio.kind).toBe('demo')
  expect(doc.audio.startSeconds ?? 0).toBeGreaterThan(1)

  // Replay determinism: hand the doc to the render-mode harness (same seed,
  // default scene matches doc.scene.id === 'lissajous') and replay it twice,
  // hashing every frame — must be byte-identical both times, and the frame
  // count must match durationFrames exactly (not the old, inflated value).
  await page.goto(`/?test=1&seed=${doc.seed}`)
  await page.waitForFunction(() => window.__viz !== undefined)

  const [hashesA, hashesB] = await page.evaluate((sessionDoc) => {
    function runOnce(): string[] {
      window.__viz!.loadSession(sessionDoc)
      const hashes: string[] = []
      for (let i = 0; i < (sessionDoc as { durationFrames: number }).durationFrames; i++) {
        window.__viz!.renderFrames(1)
        hashes.push(window.__viz!.pixelHash())
      }
      return hashes
    }
    return [runOnce(), runOnce()]
  }, doc)

  expect(hashesA.length).toBe(doc.durationFrames)
  expect(hashesB).toEqual(hashesA)
  // Non-blank guard (CLAUDE.md's golden-test convention): the lissajous curve
  // is always moving, so a real replay must not hash to one constant frame.
  expect(new Set(hashesA).size).toBeGreaterThan(1)
})

/**
 * Finding 1 regression (architect-diagnosed): `loadSession` used to reset the
 * transport to time 0 and add `doc.audio.startSeconds` back in ONLY for signal
 * sampling (the engine's now-deleted `sampleTime` split) — scene render and DSL
 * bindings read raw, un-shifted `frame.time`. A take armed at demo-clock position
 * T>0 (this rehearsal flow always produces `startSeconds` > 1, asserted above)
 * would therefore replay every time-driven visual (lissajous's curve is a direct
 * function of `ctx.frame.time`, no signal binding involved) starting from phase
 * 0, not phase T — silently wrong despite passing every existing determinism
 * check (those only ever compare a replay against ITSELF).
 *
 * The ideal proof would render a completely independent fresh engine forward (via
 * ordinary `renderFrames`) to the exact same absolute `transport.time` the
 * replay's first frame lands on, and assert pixel-identical output — but the
 * `?test=1` harness's engine runs at a fixed 30fps while `startSeconds` is an
 * arbitrary continuous value from a 60fps-ish live demo clock, so a fresh
 * transport stepping in 1/30s increments from 0 can only ever land on a multiple
 * of 1/30s, generally NOT exactly `startSeconds + 1/30` — the two would differ by
 * a sub-frame fraction of a second, which a continuously-varying curve renders as
 * a real (if tiny) pixel diff, making exact-hash comparison unreliable rather
 * than a clean proof. So instead (the spec's documented fallback): replay the
 * SAME event log twice with `startSeconds` present (must be byte-identical —
 * determinism holds with the phase-shift applied) and once more with it stripped
 * (must DIFFER from the first two) — the only way stripping a single doc field
 * changes the rendered output is if that field is actually reaching scene
 * render, not just signal sampling, which is exactly what Finding 1 fixes.
 */
test('a take armed mid-dance replays at the PERFORMED phase, not phase-shifted back to time zero (Finding 1 regression)', async ({
  page,
}) => {
  const doc = await recordPostRehearsalTake(page)
  expect(doc.audio.startSeconds ?? 0).toBeGreaterThan(1) // precondition: genuinely armed mid-dance

  await page.goto(`/?test=1&seed=${doc.seed}`)
  await page.waitForFunction(() => window.__viz !== undefined)

  const replayAllHashes = (sessionDoc: unknown) =>
    page.evaluate((d) => {
      window.__viz!.loadSession(d)
      const hashes: string[] = []
      const n = (d as { durationFrames: number }).durationFrames
      for (let i = 0; i < n; i++) {
        window.__viz!.renderFrames(1)
        hashes.push(window.__viz!.pixelHash())
      }
      return hashes
    }, sessionDoc)

  const withOffsetRun1 = await replayAllHashes(doc)

  await page.goto(`/?test=1&seed=${doc.seed}`) // fresh engine: loadSession must be replayed from cold
  await page.waitForFunction(() => window.__viz !== undefined)
  const withOffsetRun2 = await replayAllHashes(doc)
  expect(withOffsetRun2).toEqual(withOffsetRun1) // determinism holds WITH the phase-shift applied

  const strippedDoc = JSON.parse(JSON.stringify(doc))
  delete strippedDoc.audio.startSeconds
  await page.goto(`/?test=1&seed=${doc.seed}`)
  await page.waitForFunction(() => window.__viz !== undefined)
  const strippedRun = await replayAllHashes(strippedDoc)

  // The phase-shift is load-bearing: stripping `startSeconds` alone (same seed,
  // same scene, same event log) must change the rendered frames.
  expect(strippedRun).not.toEqual(withOffsetRun1)
})

test('export over a post-rehearsal take is deterministic and covers exactly durationFrames', async ({ page }) => {
  const doc = await recordPostRehearsalTake(page)

  await page.goto(`/?test=1&seed=${doc.seed}`)
  await page.waitForFunction(() => window.__viz !== undefined)

  const [run1, run2] = await page.evaluate(async (sessionDoc) => {
    const opts = {
      width: 320,
      height: 180,
      fps: (sessionDoc as { fps: number }).fps,
      collectHashes: true,
    }
    const a = await window.__viz!.exportSession(sessionDoc, opts)
    const b = await window.__viz!.exportSession(sessionDoc, opts)
    return [a, b]
  }, doc)

  for (const run of [run1, run2]) {
    expect(run.frameHashes?.length).toBe(doc.durationFrames)
  }
  expect(run2.frameHashes).toEqual(run1.frameHashes)
})
