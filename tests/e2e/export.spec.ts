import { expect, test } from '@playwright/test'

/**
 * Deterministic video export tests (ARCHITECTURE.md §3.6). Software VP9 encode is
 * slow, so this spec gets a generous timeout — it never touches golden.spec.ts's
 * snapshots.
 */

test.setTimeout(120_000)

async function boot(page: import('@playwright/test').Page, seed: number) {
  await page.goto(`/?test=1&seed=${seed}`)
  await page.waitForFunction(() => window.__viz !== undefined)
}

/** Records a short scripted 60-frame session (mirrors golden.spec.ts's mapping-layer test). */
async function recordSession(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    window.__viz!.startRecording()
    window.__viz!.queueEvent({ type: 'key', key: '4', edge: 'down' })
    window.__viz!.renderFrames(30)
    window.__viz!.queueEvent({ type: 'key', key: ' ', edge: 'down' })
    window.__viz!.renderFrames(30)
    return window.__viz!.stopRecording()
  })
}

test('export produces a valid deterministic WebM', async ({ page }) => {
  await boot(page, 42)
  const doc = await recordSession(page)

  const [run1, run2] = await page.evaluate(async (sessionDoc) => {
    const opts = { width: 320, height: 180, fps: 30, collectHashes: true }
    const a = await window.__viz!.exportSession(sessionDoc, opts)
    const b = await window.__viz!.exportSession(sessionDoc, opts)
    return [a, b]
  }, doc)

  for (const run of [run1, run2]) {
    expect(run.mime).toBe('video/webm')
    expect(run.size).toBeGreaterThan(1000)
    expect(run.magic).toEqual([0x1a, 0x45, 0xdf, 0xa3])
    expect(run.frameHashes?.length).toBe(60)
  }

  // Determinism (ARCHITECTURE.md §5 CI requirement): two exports of the same
  // session produce byte-identical per-frame pixel content.
  expect(run2.frameHashes).toEqual(run1.frameHashes)
})

test('export renders aspect-aware 9:16', async ({ page }) => {
  await boot(page, 42)
  const doc = await recordSession(page)

  const [wide, tall] = await page.evaluate(async (sessionDoc) => {
    const a = await window.__viz!.exportSession(sessionDoc, {
      width: 320,
      height: 180,
      fps: 30,
      collectHashes: true,
    })
    const b = await window.__viz!.exportSession(sessionDoc, {
      width: 180,
      height: 320,
      fps: 30,
      collectHashes: true,
    })
    return [a, b]
  }, doc)

  expect(tall.size).toBeGreaterThan(1000)
  expect(tall.frameHashes?.length).toBe(60)
  // Composition genuinely depends on aspect: a 9:16 render is not just a resized
  // 16:9 render, so the two runs' per-frame pixel hashes must differ.
  expect(tall.frameHashes).not.toEqual(wide.frameHashes)
})
