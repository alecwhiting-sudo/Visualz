import { expect, test, type Page } from '@playwright/test'

/**
 * Stage 4 (canvas-format feature): the format switch in the real App.tsx UI
 * shell (not the `?test=1` harness — see transport-ui.spec.ts for why),
 * covering the parts of REQUIREMENTS.md §5.3's preview=export gap that live
 * in the browser: (i) the format buttons actually resize the live canvas'
 * backing store, (ii) the format switch locks for a take's whole life (same
 * construction-time-constant rule as a scene switch — docs/SCENE_CONTRACT.md's
 * Framing section), and (iii) the take's recorded doc actually carries the
 * format it was recorded at, not just whatever the UI shows.
 */

const footerRecordButton = (page: Page) =>
  page.locator('.panel-footer').getByRole('button', { name: /Arm|Armed|End take/ })

/** Records a short demo-mode take (Arm starts immediately, no file needed)
 * and leaves it sitting as `lastSession`/the take card — mirrors
 * performanceModel.spec.ts's `recordDemoTakeOnSessionTab`. */
async function recordShortTake(page: Page, ms = 300) {
  const recordBtn = footerRecordButton(page)
  await recordBtn.click()
  await page.waitForTimeout(ms)
  await recordBtn.click()
  await expect(recordBtn).toHaveText('Arm')
}

test('clicking Portrait 9:16 resizes the live canvas backing store to 540x960', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => window.__vizLive !== undefined)

  const canvas = page.locator('canvas')
  // Default format is 16:9 (960x540) — loadCanvasFormat's fallback.
  await expect(canvas).toHaveAttribute('width', '960')
  await expect(canvas).toHaveAttribute('height', '540')

  await page.getByRole('tab', { name: 'INPUTS' }).click()
  await page.getByRole('radio', { name: 'Portrait 9:16' }).click()

  await expect(canvas).toHaveAttribute('width', '540')
  await expect(canvas).toHaveAttribute('height', '960')
})

test('the format switch locks for a take\'s whole life and unlocks on discard', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => window.__vizLive !== undefined)
  await page.getByRole('tab', { name: 'INPUTS' }).click()

  const formatButtons = page.getByRole('radio')
  await expect(formatButtons).toHaveCount(3)
  for (const btn of await formatButtons.all()) {
    await expect(btn).toBeEnabled()
  }

  await recordShortTake(page)

  // takeLocksFormat: `lastSession !== null` holds the lock for the take's
  // whole life, independent of which tab is active.
  for (const btn of await formatButtons.all()) {
    await expect(btn).toBeDisabled()
  }

  await page.getByRole('tab', { name: 'SESSION' }).click()
  await page.locator('.take-card').getByRole('button', { name: 'Discard' }).click()
  await expect(page.locator('.take-card')).toHaveCount(0)

  await page.getByRole('tab', { name: 'INPUTS' }).click()
  for (const btn of await formatButtons.all()) {
    await expect(btn).toBeEnabled()
  }
})

test('a take recorded in Portrait 9:16 stamps format: "9:16" in its session doc', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => window.__vizLive !== undefined)
  await page.getByRole('tab', { name: 'INPUTS' }).click()
  await page.getByRole('radio', { name: 'Portrait 9:16' }).click()

  await recordShortTake(page)

  const doc = await page.evaluate(() => window.__vizLive!.lastSessionDoc())
  expect((doc as { format?: string }).format).toBe('9:16')
})
