import { expect, test } from '@playwright/test'

/**
 * Expression guidance (user-approved design): every param row's expression
 * box carries a range-correct, param-specific placeholder, and an "fx"
 * button opens a tap-to-apply menu of range-mapped expressions. Real-app
 * spec — the flow under test is exactly what a user does: open menu, tap a
 * suggestion, watch the param go expression-driven.
 */

test('placeholders are param-specific and the fx menu applies a working binding', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.panel')).toBeVisible()
  await page.waitForFunction(() => window.__vizLive !== undefined)

  // Lissajous's first row (freqX, 1..12): placeholder must be range-mapped
  // ("1 + bass * 7" territory), not the old generic example.
  const firstRow = page.locator('.knob').filter({ hasText: 'X frequency' })
  const exprInput = firstRow.locator('input.expr')
  await expect(exprInput).toHaveAttribute('placeholder', /e\.g\. \d/)
  const ph1 = await exprInput.getAttribute('placeholder')
  // A neighboring row cycles to a different teaching signal.
  const secondRow = page.locator('.knob').filter({ hasText: 'Y frequency' })
  const ph2 = await secondRow.locator('input.expr').getAttribute('placeholder')
  expect(ph2).not.toBe(ph1)

  // Open the fx menu and tap "Sweep once per beat".
  await firstRow.getByRole('button', { name: 'Expression ideas for X frequency' }).click()
  const menu = page.locator('.expr-suggest-menu')
  await expect(menu).toBeVisible()
  // Fully on-page (same viewport-clamp contract as the info popovers).
  const box = (await menu.boundingBox())!
  const viewport = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)

  await menu.getByRole('button', { name: /Sweep once per beat/ }).click()
  await expect(menu).toHaveCount(0) // menu closes on pick

  // The binding is live: input holds the expression, the row shows the
  // bound marker, and the slider is disabled (expression owns the param).
  await expect(exprInput).toHaveValue('1 + beatPhase * 11')
  await expect(firstRow.locator('em')).toHaveText('ƒ(t)')
  await expect(firstRow.locator('input[type=range]')).toBeDisabled()

  // The param genuinely moves under the expression (demo signals drive
  // beatPhase even with no track loaded).
  const v1 = await page.evaluate(() => window.__vizLive!.getParam('freqX'))
  await expect
    .poll(() => page.evaluate(() => window.__vizLive!.getParam('freqX')), { timeout: 3000 })
    .not.toBe(v1)

  // Clear from the same menu: knob takes over again.
  await firstRow.getByRole('button', { name: 'Expression ideas for X frequency' }).click()
  await page.locator('.expr-suggest-menu').getByRole('button', { name: /Clear expression/ }).click()
  await expect(firstRow.locator('input[type=range]')).toBeEnabled()
  await expect(exprInput).toHaveValue('')
})
