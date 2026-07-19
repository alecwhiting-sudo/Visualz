import { expect, test, type Page } from '@playwright/test'

/**
 * The three-state performance model (rehearsal / armed / performing) against
 * the REAL App.tsx UI shell (not the `?test=1` harness — see
 * transport-ui.spec.ts for why). User-reported problems this rebuild fixes:
 * (1) record/play/export read as "a confusing mess"; (2) takes came out
 * LONGER than the actual performance because the transport ⏹ was a no-op
 * while recording (engine.stopAudio's isRecording gate) — the user stopped
 * nothing, and the take kept running until they found the Record button's
 * own Stop.
 *
 * transport-ui.spec.ts avoids loading a real audio file because a fixture +
 * a user-gesture-gated AudioContext aren't practical headlessly — but that
 * caution is about AUDIBLE playback. `AudioEngine.playFile` decodes and
 * calls `source.start()` unconditionally (queued even on a suspended
 * context — see audio/engine.ts's comment on `startSourceAt`), so
 * `hasFile`/`isPlaying` and `transport.frame` (a live-mode rAF tick counter,
 * NOT an audio-clock reading — see core/transport.ts's `advanceTo`) all
 * behave correctly whether or not the context ever resumes. A tiny synthetic
 * WAV built right here (Buffer, no fixture file on disk) is therefore enough
 * to drive the real Arm -> ▶ -> ⏹ flow end to end.
 */

/** A minimal valid mono 16-bit PCM WAV, `durationSec` long — real enough for
 * Chromium's decodeAudioData, small enough to inline as a Buffer. */
function makeWavBuffer(durationSec: number, sampleRate = 8000): Buffer {
  const numSamples = Math.floor(durationSec * sampleRate)
  const blockAlign = 2 // mono, 16-bit
  const dataSize = numSamples * blockAlign
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * blockAlign, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate
    const sample = Math.round(Math.sin(2 * Math.PI * 220 * t) * 3000)
    buffer.writeInt16LE(sample, 44 + i * blockAlign)
  }
  return buffer
}

/** Loads a fixture track through the real INPUTS-tab file input and waits
 * for the transport row (pinned footer) to appear — `playback.hasFile`
 * becomes true, matching transport-ui.spec.ts's own wait convention. */
async function loadFixtureAudio(page: Page, durationSec = 8) {
  await page.getByRole('tab', { name: 'INPUTS' }).click()
  const audioInput = page.locator('input[type="file"][accept*="audio"]')
  await audioInput.setInputFiles({
    name: 'take.wav',
    mimeType: 'audio/wav',
    buffer: makeWavBuffer(durationSec),
  })
  await expect(page.locator('.transport-row')).toBeVisible()
}

const footerModeLine = (page: Page) => page.locator('.panel-footer .perf-mode-line')
const footerRecordButton = (page: Page) => page.locator('.panel-footer').getByRole('button', { name: /Arm|Armed|End take/ })

test('footer mode line transitions rehearsal -> armed -> performing', async ({ page }) => {
  await page.goto('/')
  await loadFixtureAudio(page)

  // REHEARSAL: a file is loaded (auto-plays on decode) but nothing is armed
  // or recording yet.
  await expect(footerModeLine(page)).toHaveText('rehearsal — tweaks are not recorded')

  // Pause first — Arm only ARMS (rather than arming-and-starting immediately)
  // once the track isn't audibly playing (engine.startRecording's own guard).
  await page.locator('.panel-footer .transport-row').getByRole('button', { name: 'Pause' }).click()
  await expect(page.locator('.panel-footer .transport-row').getByRole('button', { name: 'Play' })).toBeVisible()
  // Still rehearsal — pausing alone records/arms nothing.
  await expect(footerModeLine(page)).toHaveText('rehearsal — tweaks are not recorded')

  // ARMED: press Arm while paused.
  await footerRecordButton(page).click()
  await expect(footerModeLine(page)).toHaveText('armed — ▶ starts the take')
  await expect(footerRecordButton(page)).toHaveText('Armed ●')

  // PERFORMING: ▶ starts audio AND the take together.
  await page.locator('.panel-footer .transport-row').getByRole('button', { name: 'Play' }).click()
  await expect(footerModeLine(page)).toHaveText(/^● TAKE \d+:\d{2}$/)
  await expect(footerRecordButton(page)).toHaveText('End take')

  // Cleanup: end the take so no dangling recording survives into another test.
  await footerRecordButton(page).click()
  await expect(footerModeLine(page)).toHaveText('rehearsal — tweaks are not recorded')
})

test('the transport ⏹ ends a take in progress and stops audio at that instant', async ({ page }) => {
  await page.goto('/')
  await loadFixtureAudio(page)

  // The track auto-plays on decode — pressing Arm here is the "arm while
  // playing" path (task): it arms AND starts the take immediately, in one
  // press, rather than requiring a pause/▶ round trip.
  await footerRecordButton(page).click()
  await expect(footerModeLine(page)).toHaveText(/^● TAKE \d+:\d{2}$/)
  await expect(footerRecordButton(page)).toHaveText('End take')

  // Regression target: the ⏹ used to no-op while recording (engine.stopAudio's
  // isRecording gate), so the take ran on until the user found the Record
  // button's own Stop — takes came out longer than the performance. It must
  // now be enabled and end the take on the first click.
  const stopButton = page.locator('.panel-footer .transport-row').getByRole('button', { name: /Stop/ })
  await expect(stopButton).toBeEnabled()

  await page.waitForTimeout(1000)
  await stopButton.click()

  // Back to rehearsal; the Play/Pause and scrub controls (disabled while
  // recording) are usable again.
  await expect(footerModeLine(page)).toHaveText('rehearsal — tweaks are not recorded')
  await expect(footerRecordButton(page)).toHaveText('Arm')
  await expect(page.locator('.panel-footer .transport-row .transport-scrub')).toBeEnabled()

  // The take's recorded length must track the ~1s that actually elapsed —
  // not run on indefinitely. transport.frame is a rAF tick counter (not an
  // audio-clock reading), so this holds even though the synthetic fixture's
  // AudioContext may never leave "suspended" headlessly.
  const takeSeconds = await page.evaluate(() => window.__vizLive!.lastTakeDuration())
  expect(takeSeconds).not.toBeNull()
  expect(takeSeconds as number).toBeGreaterThan(0.3)
  expect(takeSeconds as number).toBeLessThan(5)
})

test('take card appears in SESSION tab with Export/Replay/Save/Discard once a take ends', async ({ page }) => {
  await page.goto('/')

  // Demo mode (no file loaded): Arm has nothing to wait for, so pressing it
  // starts the take immediately — same "one button, one concept" path as
  // arm-while-playing, just with no track to pause/resume.
  await footerRecordButton(page).click()
  await expect(footerModeLine(page)).toHaveText(/^● TAKE \d+:\d{2}$/)

  await page.waitForTimeout(300)
  // RecordButton itself is the second affordance for ending a take (task) —
  // use it here instead of the transport ⏹ (covered by the spec above), and
  // there's no transport row to click anyway (no file loaded).
  await footerRecordButton(page).click()
  await expect(footerRecordButton(page)).toHaveText('Arm')
  // Demo mode: the rehearsal line hides entirely (task: "hide in demo mode"),
  // so back-to-rehearsal here means the mode line is simply gone.
  await expect(footerModeLine(page)).toHaveCount(0)

  // The dot badge on the SESSION tab appears while the take is unexported.
  const sessionTab = page.getByRole('tab', { name: 'SESSION' })
  await expect(sessionTab.locator('.tab-badge')).toBeVisible()

  await sessionTab.click()
  const takeCard = page.locator('.take-card')
  await expect(takeCard).toBeVisible()
  await expect(takeCard.locator('.take-card-duration')).toHaveText(/^Last take: \d+:\d{2}$/)
  await expect(takeCard.getByRole('button', { name: 'Export video' })).toBeVisible()
  await expect(takeCard.getByRole('button', { name: 'Replay' })).toBeVisible()
  await expect(takeCard.getByRole('button', { name: 'Save take' })).toBeVisible()
  await expect(takeCard.getByRole('button', { name: 'Discard' })).toBeVisible()

  // Discard clears the take card and the badge together.
  await takeCard.getByRole('button', { name: 'Discard' }).click()
  await expect(takeCard).toHaveCount(0)
  await expect(sessionTab.locator('.tab-badge')).toHaveCount(0)
})

// --- Replay: stop, layout, and audio-sync hint -----------------------------
// User report (with screenshot): (1) no way to interrupt a replay — a 6:44
// take had to run to completion; (2) the take card's buttons overflowed the
// 320px panel (SAVE JSON wrapped, DISCARD clipped); (3) replay is silent even
// when the track that was recorded is still loaded.

/** Records a demo-mode take (Arm starts immediately, no file needed) of
 * roughly `ms` milliseconds and leaves the SESSION tab open with the
 * resulting take card visible. */
async function recordDemoTakeOnSessionTab(page: Page, ms = 2000) {
  await page.goto('/')
  await page.waitForFunction(() => window.__vizLive !== undefined)
  const recordBtn = footerRecordButton(page)
  await recordBtn.click()
  await page.waitForTimeout(ms)
  await recordBtn.click()
  await page.getByRole('tab', { name: 'SESSION' }).click()
  await expect(page.locator('.take-card')).toBeVisible()
}

test('Stop replay halts the running replay and restores a live, still-rendering engine', async ({ page }) => {
  await recordDemoTakeOnSessionTab(page)
  await page.locator('.take-card').getByRole('button', { name: 'Replay' }).click()

  const progress = page.locator('.replay-status .session-status')
  await expect(progress).toHaveText(/^replaying… frame \d+\/\d+$/)
  const stopButton = page.getByRole('button', { name: 'Stop replay' })
  await expect(stopButton).toBeVisible()

  // Let a handful of frames actually step before cancelling, so this isn't
  // just catching the replay before it ever got going.
  await page.waitForTimeout(300)
  await stopButton.click()

  // The replay UI disappears immediately...
  await expect(page.locator('.replay-status')).toHaveCount(0)
  // ...and stays gone — proves the rAF step loop actually stopped scheduling
  // itself (the "no further steps after cancel" requirement), not just that
  // the UI hid itself while a stray tick kept ticking underneath.
  await page.waitForTimeout(500)
  await expect(page.locator('.replay-status')).toHaveCount(0)

  // A fresh LIVE engine is attached (restoreLive ran, not left mid-teardown):
  // window.__vizLive only exists while App.tsx's attachLiveEngine has wired
  // up a real live-mode engine.
  await page.waitForFunction(() => window.__vizLive !== undefined)
  await expect(footerRecordButton(page)).toHaveText('Arm')

  // The canvas keeps rendering afterward (demo signals keep the live scene
  // animating) — two screenshots a moment apart must differ, not freeze on
  // whatever frame cancellation landed on.
  const shotA = await page.locator('canvas').screenshot()
  await page.waitForTimeout(400)
  const shotB = await page.locator('canvas').screenshot()
  expect(shotB.equals(shotA)).toBe(false)
})

test('Esc cancels a running replay the same way the Stop replay button does', async ({ page }) => {
  await recordDemoTakeOnSessionTab(page)
  await page.locator('.take-card').getByRole('button', { name: 'Replay' }).click()
  await expect(page.locator('.replay-status')).toBeVisible()

  await page.waitForTimeout(300)
  await page.keyboard.press('Escape')

  await expect(page.locator('.replay-status')).toHaveCount(0)
  await page.waitForFunction(() => window.__vizLive !== undefined)
  await expect(footerRecordButton(page)).toHaveText('Arm')
})

test('take-card and load-a-saved-take buttons fit within the 320px panel at its real width', async ({ page }) => {
  await recordDemoTakeOnSessionTab(page)

  const panelBox = await page.locator('.panel').boundingBox()
  expect(panelBox).not.toBeNull()
  const panelRight = panelBox!.x + panelBox!.width

  const takeCard = page.locator('.take-card')
  const takeCardLabels = ['Export video', 'Replay', 'Save take', 'Save session', 'Save both', 'Discard']
  for (const label of takeCardLabels) {
    const button = takeCard.getByRole('button', { name: label })
    const box = await button.boundingBox()
    expect(box, `${label} button has a bounding box`).not.toBeNull()
    // Fits inside the panel — no clipping off the right edge.
    expect(box!.x).toBeGreaterThanOrEqual(panelBox!.x)
    expect(box!.x + box!.width).toBeLessThanOrEqual(panelRight + 0.5)
    // A single line of text, not wrapped mid-word onto a second line — a
    // wrapped button roughly doubles its natural height (line-height would
    // otherwise be a single line's worth, ~36px per the button's own padding).
    // (textContent itself would read identically whether wrapped or not —
    // CSS text-transform/wrapping never change it — so height is the actual
    // visual-overflow signal here, not a text-content match.)
    expect(box!.height).toBeLessThan(40)
  }

  const subsection = page.locator('.session-subsection')
  for (const label of ['Load session or take…', 'Export from file…']) {
    const fileLabel = subsection.locator('label.file', { hasText: label.slice(0, -1) })
    const box = await fileLabel.first().boundingBox()
    expect(box, `${label} label has a bounding box`).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(panelBox!.x)
    expect(box!.x + box!.width).toBeLessThanOrEqual(panelRight + 0.5)
    await expect(fileLabel.first()).toHaveText(label)
  }
})

test('a silent (no-track) replay of a file-kind doc shows the "load the track to sync" hint', async ({ page }) => {
  // Build a file-kind session doc via the `?test=1` harness (fresh page —
  // this bypasses React entirely, see App.tsx's VizLiveTestApi doc comment),
  // then feed its JSON into the REAL app's "Replay from file…" input on a
  // fresh page that has never loaded any audio — the exact "no track loaded"
  // case task 3 covers without needing headless-audible audio at all.
  await page.goto('/?test=1&seed=42')
  await page.waitForFunction(() => window.__viz !== undefined)
  const doc = await page.evaluate(() => window.__viz!.makeFileSessionDoc(3))

  await page.goto('/')
  await page.waitForFunction(() => window.__vizLive !== undefined)
  await page.getByRole('tab', { name: 'SESSION' }).click()

  const fileInput = page.locator('input[type="file"][accept*="json"]').first()
  await fileInput.setInputFiles({
    name: 'take.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(doc)),
  })

  await expect(page.locator('.replay-status')).toBeVisible()
  await expect(page.locator('.session-status', { hasText: 'load the track' })).toHaveText(
    'load the track (INPUTS tab) to hear the replay in sync',
  )

  // Clean up rather than waiting out the whole replay.
  await page.getByRole('button', { name: 'Stop replay' }).click()
  await expect(page.locator('.replay-status')).toHaveCount(0)
})
