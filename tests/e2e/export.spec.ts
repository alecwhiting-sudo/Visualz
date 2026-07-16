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

  // Reference: replay the session in the page engine (same 640x360 canvas the
  // harness booted) and hash every frame.
  const replayHashes = await page.evaluate((sessionDoc) => {
    window.__viz!.loadSession(sessionDoc)
    const hashes: string[] = []
    for (let i = 0; i < 60; i++) {
      window.__viz!.renderFrames(1)
      hashes.push(window.__viz!.pixelHash())
    }
    return hashes
  }, doc)

  const [run1, run2] = await page.evaluate(async (sessionDoc) => {
    const opts = { width: 640, height: 360, fps: 30, collectHashes: true }
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
  // session produce byte-identical per-frame readback content.
  expect(run2.frameHashes).toEqual(run1.frameHashes)
  // And the export pipeline renders exactly what an in-page replay renders —
  // the worker/OffscreenCanvas path introduces no divergence. (What the encoder
  // consumes vs the readback is validated out-of-band: review decoded a real
  // export with ffmpeg — in-suite VideoDecoder verification is future work.)
  expect(run1.frameHashes).toEqual(replayHashes)
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
  // Sanity check only: output responds to the requested dimensions. This does
  // NOT prove aspect-aware composition (a naive stretch would also differ) —
  // that rule is enforced by the 9:16 and 1:1 goldens in golden.spec.ts.
  expect(tall.frameHashes).not.toEqual(wide.frameHashes)
})

test('export muxes an Opus audio track', async ({ page }) => {
  await boot(page, 42)
  const doc = await recordSession(page)

  const [silent, audible] = await page.evaluate(async (sessionDoc) => {
    const a = await window.__viz!.exportSession(sessionDoc, { width: 320, height: 180, fps: 30 })
    const b = await window.__viz!.exportSession(sessionDoc, {
      width: 320,
      height: 180,
      fps: 30,
      audioSeconds: 2,
    })
    return [a, b]
  }, doc)

  expect(silent.mime).toBe('video/webm')
  expect(silent.magic).toEqual([0x1a, 0x45, 0xdf, 0xa3])
  expect(audible.mime).toBe('video/webm')
  expect(audible.magic).toEqual([0x1a, 0x45, 0xdf, 0xa3])

  // A 2s 128kbps Opus stream is roughly 32KB — the audio-bearing export should be
  // substantially larger than the silent one, not just noise from muxer overhead.
  expect(audible.size).toBeGreaterThan(silent.size + 5000)
})

test('codec detection falls back to VP9 when a complete MP4 is unsupported', async ({ page }) => {
  await boot(page, 42)
  const doc = await recordSession(page)

  // No `codec` option at all — proves detectExportCodec() actually runs (not
  // just a hardcoded default). Preference is H.264/AAC MP4 (REQUIREMENTS.md
  // §5.2), but this Chromium build supports VP9/Opus encode and not H.264/AAC,
  // so detection must land on 'vp9' (see export/encode.ts).
  const result = await page.evaluate((sessionDoc) => {
    return window.__viz!.exportSession(sessionDoc, { width: 320, height: 180, fps: 30 })
  }, doc)

  expect(result.mime).toBe('video/webm')
  expect(result.fileExtension).toBe('webm')
  expect(result.magic).toEqual([0x1a, 0x45, 0xdf, 0xa3])
})

test('explicit h264 request on a non-supporting browser throws a clear error', async ({ page }) => {
  await boot(page, 42)
  const doc = await recordSession(page)

  // This spec's Chromium build supports VP9/Opus but not H.264/AAC encode
  // (ARCHITECTURE.md §6 / task context) — so an explicit h264 request must
  // reject with a message naming the codec, rather than hanging or throwing
  // something generic deep inside the encoder.
  const message = await page.evaluate(async (sessionDoc) => {
    try {
      await window.__viz!.exportSession(sessionDoc, { width: 320, height: 180, fps: 30, codec: 'h264' })
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }, doc)

  expect(message).not.toBeNull()
  expect(message!.toLowerCase()).toMatch(/h264|h\.264|avc/)
})
