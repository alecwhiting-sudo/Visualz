import { expect, test } from '@playwright/test'

/**
 * App.tsx's real UI shell (not the `?test=1` harness — see transport-ui.spec.ts
 * for why): the MIDI panel section, exercising the "unavailable" path that a
 * real Safari/Firefox/iOS user (no Web MIDI API at all) and this headless CI
 * runner both land on, just via different routes:
 *
 * - `localhost` is a secure context, so Chromium *does* expose
 *   `navigator.requestMIDIAccess` as a function here (verified directly
 *   against the built preview server before writing this spec) — unlike a
 *   plain `about:blank` page, where it's `undefined` entirely.
 * - But Playwright's default browser context grants no permissions, so the
 *   call rejects with `NotAllowedError` (also verified directly) — landing
 *   `attachMidi` in the same "supported: false" fallback its true-absence
 *   branch produces for Safari.
 *
 * Either way the assertion that matters is the same: the panel must reach the
 * "not supported" state without throwing, with no device list and no Learn
 * button. A deeper test injecting a fake MIDIAccess via CDP (to exercise the
 * device list / Learn flow end-to-end with simulated hardware) was not
 * attempted — Playwright has no cheap flag to auto-grant WebMIDI permission.
 * attachMidi's runtime behavior (device map, hot-plug resync, active-gating,
 * learn activity, detach) is unit-tested against a fake MIDIAccess in
 * tests/unit/midiAttach.test.ts; the pure decoder in tests/unit/midi.test.ts;
 * this spec covers App.tsx's wiring for the one path that's cheap and
 * deterministic headlessly.
 *
 * MIDI settings are collapsed behind a compact disclosure by default (task:
 * "MIDI settings behind a button") — the tab-style "MIDI" button is the only
 * thing visible until clicked, so this spec opens it before asserting on the
 * status text / device list / Learn button that used to be visible outright.
 *
 * The studio panel is also now tabbed (SCENE | SESSION | INPUTS | CODE, SCENE
 * active by default) and the MIDI section lives inside INPUTS, so this spec
 * opens that tab first — same idea as the MIDI disclosure itself, just one
 * level up.
 */

test('MIDI panel reaches "not supported" in headless Chromium and never throws', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  await page.goto('/')

  await expect(page.locator('.panel')).toBeVisible()
  await page.getByRole('tab', { name: 'INPUTS' }).click()
  const midiSection = page.locator('section.midi-section')
  await expect(midiSection).toBeVisible()

  const midiToggle = midiSection.getByRole('button', { name: 'MIDI' })
  await expect(midiToggle).toBeVisible()
  // Closed by default — the disclosure's contents aren't in the DOM at all.
  await expect(midiSection.getByText(/MIDI: /)).toHaveCount(0)
  await expect(midiToggle).toHaveAttribute('aria-expanded', 'false')

  await midiToggle.click()
  await expect(midiToggle).toHaveAttribute('aria-expanded', 'true')

  // requestMIDIAccess's promise settles asynchronously (rejected for lack of
  // permission, or simply absent) — toBeVisible auto-retries until the panel
  // catches up.
  await expect(midiSection.getByText('MIDI: not supported in this browser')).toBeVisible()

  // No device checkboxes and no Learn button once MIDI is unavailable.
  await expect(midiSection.locator('input[type="checkbox"]')).toHaveCount(0)
  await expect(midiSection.getByRole('button', { name: 'Learn' })).toHaveCount(0)
  // Not supported, so no devices are connected and learn mode never turns
  // on — the disclosure trigger shows no badge.
  await expect(midiToggle.locator('.tab-badge')).toHaveCount(0)

  expect(pageErrors).toEqual([])
})
