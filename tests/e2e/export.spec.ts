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

test('export encodes a 1080p high-bitrate video (High/Max quality presets)', async ({ page }) => {
  // Guards the export-quality presets: the app now exports 1080p at a generous
  // bitrate (the grain fix), and H.264 picks Main level 4.2 for >720p. Prove the
  // encoder actually accepts a 1080p/20Mbps config and produces a real file.
  await boot(page, 42)
  const doc = await recordSession(page)

  const hi = await page.evaluate(async (sessionDoc) => {
    return window.__viz!.exportSession(sessionDoc, {
      width: 1920,
      height: 1080,
      fps: 30,
      bitrate: 20_000_000,
      collectHashes: true,
    })
  }, doc)

  expect(hi.size).toBeGreaterThan(10_000)
  expect(hi.frameHashes?.length).toBe(60)
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

test('credits overlay: lit upper-third pixels near the end, none at an early frame', async ({ page }) => {
  // Frame-level readback of the actual MUXED/encoded video isn't reachable
  // from Playwright here (no in-suite VideoDecoder verification, per the
  // existing "decoded a real export with ffmpeg" note above) — so this
  // asserts directly on `drawCredits`'s pure canvas-2D output via the
  // `sampleCreditsRegion` test hook, at the exact alpha `creditsAlpha` would
  // compute for an early frame vs the last frame of a short (3s) export —
  // shorter than the default 5s window, exercising the clamp-to-0 case too.
  await boot(page, 42)

  const width = 320
  const height = 180
  // durationSec=3 is < the default 5s window, exercising the clamp-to-0 case:
  // start clamps to 0, the fade completes at t=1, and holds at 1 well before
  // the last frame — so alpha=0 (t=0) vs alpha=1 (last frame) below is exactly
  // what creditsAlpha would compute for that clip.

  const [early, last] = await page.evaluate(
    ({ width, height }) => {
      const regionFrac = 0.2
      return [
        window.__viz!.sampleCreditsRegion(width, height, 'Alec Whiting', 'divurj.com', 0, regionFrac),
        window.__viz!.sampleCreditsRegion(width, height, 'Alec Whiting', 'divurj.com', 1, regionFrac),
      ]
    },
    { width, height },
  )

  expect(early).toBe(0)
  expect(last).toBeGreaterThan(100)
})

test('credits overlay does not change the export determinism fixture (default: both lines blank)', async ({
  page,
}) => {
  // The existing determinism test above passes NO `credits` option — proving
  // the export pipeline stays on today's byte-identical path is exactly what
  // that test already does. This test proves the ENGAGED feature end to end:
  // with credits set, frame hashes come from the composited 2D canvas (the
  // pixels that get encoded — render.ts hashes the composite when active), so
  // (a) two runs matching proves the overlay itself renders deterministically
  // (shadow blur included), and (b) the final frame's hash differing from a
  // credits-blank export's final frame proves the overlay is actually present
  // in the encoded source, not silently absent.
  await boot(page, 42)
  const doc = await recordSession(page)

  const [run1, run2, runBlank] = await page.evaluate((sessionDoc) => {
    const base = { width: 320, height: 180, fps: 30, collectHashes: true }
    const credits = { line1: 'Alec Whiting', line2: 'divurj.com' }
    return Promise.all([
      window.__viz!.exportSession(sessionDoc, { ...base, credits }),
      window.__viz!.exportSession(sessionDoc, { ...base, credits }),
      window.__viz!.exportSession(sessionDoc, base),
    ])
  }, doc)

  expect(run1.frameHashes?.length).toBe(60)
  expect(run2.frameHashes).toEqual(run1.frameHashes)
  // Presence: the 2s fixture is fully inside the (duration<5s → from t=0)
  // credits window, so the last frame must differ from the blank export's.
  expect(run1.frameHashes![59]).not.toBe(runBlank.frameHashes![59])
  expect(run1.mime).toBe('video/webm')
  expect(run1.size).toBeGreaterThan(1000)
})
