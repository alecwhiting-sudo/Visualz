import { expect, test } from '@playwright/test'

/**
 * App.tsx's real UI shell (not the `?test=1` harness, which bypasses React
 * entirely — see src/main.tsx): the transport row (play/pause/stop/scrub) and
 * the export-format picker. Deep audio interaction (loading a real file,
 * driving playback) isn't practical headlessly without a fixture file and a
 * user-gesture-gated AudioContext, so this spec sticks to what's verifiable
 * without one — the row's hidden/shown state and the picker's presence/options.
 *
 * The studio panel is now tabbed (SCENE | SESSION | INPUTS | CODE, SCENE
 * active by default): the audio file input lives in INPUTS and the export
 * format picker lives in SESSION, so this spec opens each tab before
 * asserting on its content. The transport row itself lives in the panel's
 * pinned footer (outside the tabs entirely — never scrolled away or hidden
 * by tab choice), so its hidden/shown assertion doesn't depend on which tab
 * is active.
 */

test('transport row is hidden until a file loads; export format picker is present', async ({ page }) => {
  await page.goto('/')

  // The real App shell (no window.__viz here) — wait on a stable panel element.
  await expect(page.locator('.panel')).toBeVisible()

  await page.getByRole('tab', { name: 'INPUTS' }).click()
  await expect(page.getByText('Load audio file (demo signals until then)')).toBeVisible()

  // No file has been loaded, so the transport row (pinned footer) must not
  // be rendered at all — regardless of which tab is active.
  await expect(page.locator('.transport-row')).toHaveCount(0)

  await page.getByRole('tab', { name: 'SESSION' }).click()
  const exportFormatLabel = page.locator('.scene-select', { hasText: 'Export format' })
  await expect(exportFormatLabel).toBeVisible()
  const select = exportFormatLabel.locator('select')
  await expect(select).toHaveValue('auto')
  await expect(select.locator('option')).toHaveCount(3)
  await expect(select.locator('option').nth(1)).toHaveText('MP4 (H.264)')
  await expect(select.locator('option').nth(2)).toHaveText('WebM (VP9)')
})
