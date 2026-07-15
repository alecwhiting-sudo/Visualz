import { expect, test } from '@playwright/test'

/**
 * File-audio session integration (docs/ANALYSIS.md §§6-7, task PART C): proves
 * a session whose `audio.kind === 'file'` (a serialized offline FeatureTimeline)
 * replays deterministically both in-page and through the export worker, and
 * that the timeline's signals actually drive the visuals (not silently ignored
 * in favor of demo signals). Does not touch golden.spec.ts's snapshots.
 */

async function boot(page: import('@playwright/test').Page, seed: number) {
  await page.goto(`/?test=1&seed=${seed}`)
  await page.waitForFunction(() => window.__viz !== undefined)
}

test('file-audio sessions replay deterministically', async ({ page }) => {
  await boot(page, 42)

  const doc = await page.evaluate(() => window.__viz!.makeFileSessionDoc(9))

  const hash1 = await page.evaluate((d) => {
    window.__viz!.loadSession(d)
    window.__viz!.renderFrames(90)
    return window.__viz!.pixelHash()
  }, doc)

  const hash2 = await page.evaluate((d) => {
    window.__viz!.loadSession(d)
    window.__viz!.renderFrames(90)
    return window.__viz!.pixelHash()
  }, doc)

  // Same doc, loaded and replayed twice: byte-identical pixels.
  expect(hash2).toBe(hash1)

  const demoHash = await page.evaluate((d) => {
    const demoDoc = { ...(d as Record<string, unknown>), audio: { kind: 'demo' } }
    window.__viz!.loadSession(demoDoc)
    window.__viz!.renderFrames(90)
    return window.__viz!.pixelHash()
  }, doc)

  // Same bindings/seed/params, only the audio source differs: the rendered
  // pixels must differ too, proving the timeline's bass/beat/beatPhase signals
  // (not demo signals) are what actually drove the beat-bound expressions.
  expect(demoHash).not.toBe(hash1)
})

test('file-audio session exports deterministically', async ({ page }) => {
  test.setTimeout(120_000)
  await boot(page, 42)

  const doc = await page.evaluate(() => window.__viz!.makeFileSessionDoc(9))

  const [run1, run2] = await page.evaluate(async (d) => {
    const opts = { width: 320, height: 180, fps: 30, collectHashes: true }
    const a = await window.__viz!.exportSession(d, opts)
    const b = await window.__viz!.exportSession(d, opts)
    return [a, b]
  }, doc)

  expect(run1.frameHashes?.length).toBe(90)
  expect(run2.frameHashes?.length).toBe(90)
  expect(run2.frameHashes).toEqual(run1.frameHashes)
})
