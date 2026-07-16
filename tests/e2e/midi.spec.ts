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
 * attempted — Playwright has no cheap flag to auto-grant WebMIDI permission,
 * and the task called this enhancement optional. attachMidi's device-toggle
 * and learn-binding logic is covered by its own unit tests
 * (tests/unit/midi.test.ts) plus code-level reasoning; this spec covers
 * App.tsx's wiring for the one path that's cheap and deterministic headlessly.
 */

test('MIDI panel reaches "not supported" in headless Chromium and never throws', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  await page.goto('/')

  await expect(page.locator('.panel')).toBeVisible()
  const midiSection = page.locator('section', { has: page.locator('h2', { hasText: 'MIDI' }) })
  await expect(midiSection).toBeVisible()
  // requestMIDIAccess's promise settles asynchronously (rejected for lack of
  // permission, or simply absent) — toBeVisible auto-retries until the panel
  // catches up.
  await expect(midiSection.getByText('MIDI: not supported in this browser')).toBeVisible()

  // No device checkboxes and no Learn button once MIDI is unavailable.
  await expect(midiSection.locator('input[type="checkbox"]')).toHaveCount(0)
  await expect(midiSection.getByRole('button', { name: 'Learn' })).toHaveCount(0)

  expect(pageErrors).toEqual([])
})
