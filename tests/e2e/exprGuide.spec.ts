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
  // Fully on-page in BOTH axes (the seven-item menu once ran past the
  // viewport bottom, putting Clear expression off-screen — the vertical
  // clamp measures the real rendered height).
  const box = (await menu.boundingBox())!
  const viewport = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)

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

test('a low-on-page fx menu clamps on-screen and holds still (user report: jiggle loop)', async ({
  page,
}) => {
  // A short viewport guarantees the last param row's menu needs the vertical
  // clamp — the case that used to oscillate at 10Hz between its unclamped
  // and clamped positions (state-vs-ref fight, re-triggered by the app's
  // 100ms meter poll re-render).
  await page.setViewportSize({ width: 1280, height: 520 })
  await page.goto('/')
  await expect(page.locator('.panel')).toBeVisible()
  await page.waitForFunction(() => window.__vizLive !== undefined)

  const lastParam = await page.evaluate(() => {
    const params = window.__vizLive!.sceneParams()
    return params[params.length - 1]
  })
  const lastRow = page.locator('.knob').filter({ has: page.locator(`input[type=range]`) }).last()
  await lastRow.scrollIntoViewIfNeeded()
  await lastRow.getByRole('button', { name: /Expression ideas/ }).click()

  const menu = page.locator('.expr-suggest-menu')
  await expect(menu).toBeVisible()
  const viewport = page.viewportSize()!
  const box1 = (await menu.boundingBox())!
  expect(box1.y).toBeGreaterThanOrEqual(0)
  expect(box1.y + box1.height).toBeLessThanOrEqual(viewport.height)

  // Stability: several meter-poll re-renders later, the menu has not moved a
  // single pixel (the jiggle loop moved it every ~100ms).
  await page.waitForTimeout(450)
  const box2 = (await menu.boundingBox())!
  expect(box2.x).toBe(box1.x)
  expect(box2.y).toBe(box1.y)
  expect(box2.height).toBe(box1.height)

  // And it still works: applying from the clamped menu binds the low param.
  await menu.getByRole('button', { name: /Sweep once per beat/ }).click()
  await expect(lastRow.locator('em')).toHaveText('ƒ(t)')
  expect(lastParam.name.length).toBeGreaterThan(0)
})
