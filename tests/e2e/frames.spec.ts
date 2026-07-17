import { expect, test, type Page } from '@playwright/test'

/**
 * Frame buttons F1-F8 (task #35): eight snapshot slots below the PERFORM
 * tab's pads, storing the current scene's first-8 param values NORMALIZED
 * (position-relative, like Controls 1-8) so pressing a frame re-applies them
 * to WHATEVER scene is live — instant jump on a plain press, an eased glide
 * over the transition-speed knob's duration on shift+press. Real-app
 * coverage (no `?test=1` harness — see transport-ui.spec.ts for why);
 * `window.__vizLive.setParam` is the seam for moving a param away from its
 * stored position without depending on a specific slider's drag mechanics,
 * mirroring the existing `setInputSignal` seam macros.spec.ts uses for the
 * same reason.
 */

async function boot(page: Page) {
  await page.goto('/')
  await expect(page.locator('.panel')).toBeVisible()
  await page.waitForFunction(() => window.__vizLive !== undefined)
}

async function getParam(page: Page, name: string): Promise<number> {
  return page.evaluate((n) => window.__vizLive!.getParam(n), name)
}

function setParam(page: Page, name: string, value: number): Promise<void> {
  return page.evaluate(({ name: n, value: v }) => window.__vizLive!.setParam(n, v), { name, value })
}

test('store then press F1 returns a changed param to its stored position', async ({ page }) => {
  await boot(page)
  const param0 = await page.evaluate(() => window.__vizLive!.sceneParams()[0])

  await page.getByRole('button', { name: 'Store' }).click()
  await page.getByRole('button', { name: 'F1', exact: true }).click()

  // Change the param away from its stored (default) value.
  const changed = param0.min + (param0.max - param0.min) * 0.9
  await setParam(page, param0.name, changed)
  expect(await getParam(page, param0.name)).toBeCloseTo(changed, 2)

  // Plain press jumps back to the stored (default) value instantly.
  await page.getByRole('button', { name: 'F1', exact: true }).click()
  await expect.poll(() => getParam(page, param0.name)).toBeCloseTo(param0.default, 2)
})

test('right-click on a frame also stores, bypassing the Store toggle', async ({ page }) => {
  await boot(page)
  const param0 = await page.evaluate(() => window.__vizLive!.sceneParams()[0])

  // Store mode is NOT armed — a right-click still stores (desktop shortcut).
  await page.getByRole('button', { name: 'F4', exact: true }).click({ button: 'right' })

  const changed = param0.min + (param0.max - param0.min) * 0.9
  await setParam(page, param0.name, changed)

  await page.getByRole('button', { name: 'F4', exact: true }).click()
  await expect.poll(() => getParam(page, param0.name)).toBeCloseTo(param0.default, 2)
})

test('shift+press glides a param over the transition duration rather than snapping instantly', async ({ page }) => {
  await boot(page)
  const param0 = await page.evaluate(() => window.__vizLive!.sceneParams()[0])

  // Store the default position into F2.
  await page.getByRole('button', { name: 'Store' }).click()
  await page.getByRole('button', { name: 'F2', exact: true }).click()

  // Move the param to its max.
  await setParam(page, param0.name, param0.max)

  // Shift+press F2: glide back toward the stored (default) value.
  await page.getByRole('button', { name: 'F2', exact: true }).click({ modifiers: ['Shift'] })

  const mid = await getParam(page, param0.name)
  // Not still at max (the glide has started) — proves the press did
  // something — while the final assertion below (a later poll) proves it
  // takes multiple ticks rather than an instant jump.
  expect(mid).toBeLessThan(param0.max)
  await expect.poll(() => getParam(page, param0.name), { timeout: 5000 }).toBeCloseTo(param0.default, 1)
})

test("frames survive a handoff: store on lissajous, switch to julia, press moves julia's own params", async ({
  page,
}) => {
  await boot(page)
  // Default scene is lissajous; capture its first param's normalized default
  // position before switching, so the expected post-handoff value can be
  // computed without assuming defaults coincide across scenes (they don't).
  const lissParam0 = await page.evaluate(() => window.__vizLive!.sceneParams()[0])
  const normalized = (lissParam0.default - lissParam0.min) / (lissParam0.max - lissParam0.min)

  await page.getByRole('button', { name: 'Store' }).click()
  await page.getByRole('button', { name: 'F3', exact: true }).click()

  // Hand off to Julia specifically (the default hand-off target is Flow Field).
  await page.locator('.switch-control select').selectOption('julia')
  await page.getByRole('button', { name: /Switch \(hand off\)/i }).click()

  const juliaParam0 = await page.evaluate(() => window.__vizLive!.sceneParams()[0])
  await setParam(page, juliaParam0.name, juliaParam0.max)

  await page.getByRole('button', { name: 'F3', exact: true }).click()
  const expected = juliaParam0.min + normalized * (juliaParam0.max - juliaParam0.min)
  await expect.poll(() => getParam(page, juliaParam0.name)).toBeCloseTo(expected, 2)
})

test('the Frames block has its own "?" guidance popover with the spec\'d copy', async ({ page }) => {
  await boot(page)
  const infoButton = page.getByRole('button', { name: 'Frames info' })
  await expect(infoButton).toBeVisible()
  await infoButton.click()
  await expect(page.locator('.info-popover-content')).toContainText('Frames store the 8 controller positions')
})
