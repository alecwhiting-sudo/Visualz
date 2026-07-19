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

  // Poll rather than one immediate read (review finding: the glide's first
  // rAF tick sits at easedValue(from, ·, 0) === from, so an instant read
  // races it ~33% of the time). Departure from max proves the glide started;
  // the arrival poll below proves it takes multiple ticks, not a jump.
  await expect
    .poll(() => getParam(page, param0.name), { timeout: 3000 })
    .toBeLessThan(param0.max)
  await expect.poll(() => getParam(page, param0.name), { timeout: 5000 }).toBeCloseTo(param0.default, 1)
})

test('the Glide latch makes a PLAIN press glide (touch has no Shift key)', async ({ page }) => {
  await boot(page)
  const param0 = await page.evaluate(() => window.__vizLive!.sceneParams()[0])

  await page.getByRole('button', { name: 'Store' }).click()
  await page.getByRole('button', { name: 'F5', exact: true }).click()
  await setParam(page, param0.name, param0.max)

  // Latch Glide, then a plain (no-Shift) press — must glide, not jump.
  const glideToggle = page.getByRole('button', { name: 'Glide' })
  await glideToggle.click()
  await expect(glideToggle).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'F5', exact: true }).click()

  // Same departure-then-arrival proof as the Shift+press test above.
  await expect
    .poll(() => getParam(page, param0.name), { timeout: 3000 })
    .toBeLessThan(param0.max)
  await expect.poll(() => getParam(page, param0.name), { timeout: 5000 }).toBeCloseTo(param0.default, 1)

  // Unlatch: a plain press is an instant jump again.
  await glideToggle.click()
  await expect(glideToggle).toHaveAttribute('aria-pressed', 'false')
  await setParam(page, param0.name, param0.max)
  await page.getByRole('button', { name: 'F5', exact: true }).click()
  await expect.poll(() => getParam(page, param0.name)).toBeCloseTo(param0.default, 2)
})

test('grabbing a control mid-glide takes that param over while the rest keep gliding', async ({ page }) => {
  await boot(page)
  const [param0, param1] = await page.evaluate(() => window.__vizLive!.sceneParams().slice(0, 2))

  // Store defaults into F6, push the first two params to max, start a glide
  // back toward the stored frame.
  await page.getByRole('button', { name: 'Store' }).click()
  await page.getByRole('button', { name: 'F6', exact: true }).click()
  await setParam(page, param0.name, param0.max)
  await setParam(page, param1.name, param1.max)
  await page.getByRole('button', { name: 'F6', exact: true }).click({ modifiers: ['Shift'] })

  // Wait until the glide is demonstrably running (param0 departed max) …
  await expect
    .poll(() => getParam(page, param0.name), { timeout: 3000 })
    .toBeLessThan(param0.max)

  // … then grab param0 (what a hardware ctl or UI slider write looks like).
  // "Whichever is being used takes over at the moment of use": the glide
  // must release param0 to the grab and keep gliding param1 to the frame.
  const grabbed = param0.min + (param0.max - param0.min) * 0.9
  await setParam(page, param0.name, grabbed)

  await expect.poll(() => getParam(page, param1.name), { timeout: 5000 }).toBeCloseTo(param1.default, 1)
  expect(await getParam(page, param0.name)).toBeCloseTo(grabbed, 5)
})

test('frames are PER ALGORITHM: julia gets an empty bank; lissajous keeps its own across a round trip', async ({
  page,
}) => {
  // docs/SESSIONS.md §7.2 (user decision) — supersedes the original global-
  // positional behavior: each scene owns its F1-F8 bank.
  await boot(page)
  const lissParam0 = await page.evaluate(() => window.__vizLive!.sceneParams()[0])

  await page.getByRole('button', { name: 'Store' }).click()
  await page.getByRole('button', { name: 'F3', exact: true }).click()

  // Hand off to Julia: its bank is EMPTY, so pressing F3 must not move
  // julia's params.
  await page.locator('.switch-control select').selectOption('julia')
  await page.getByRole('button', { name: /Switch \(hand off\)/i }).click()
  const juliaParam0 = await page.evaluate(() => window.__vizLive!.sceneParams()[0])
  await setParam(page, juliaParam0.name, juliaParam0.max)
  await page.getByRole('button', { name: 'F3', exact: true }).click()
  await page.waitForTimeout(200)
  expect(await getParam(page, juliaParam0.name)).toBeCloseTo(juliaParam0.max, 2)

  // Back to lissajous: its own bank survived the round trip — F3 restores
  // the stored (default) position after moving the param away.
  await page.locator('.switch-control select').selectOption('lissajous')
  await page.getByRole('button', { name: /Switch \(hand off\)/i }).click()
  await setParam(page, lissParam0.name, lissParam0.max)
  await page.getByRole('button', { name: 'F3', exact: true }).click()
  await expect.poll(() => getParam(page, lissParam0.name)).toBeCloseTo(lissParam0.default, 2)
})

test('the Frames block has its own "?" guidance popover with the spec\'d copy', async ({ page }) => {
  await boot(page)
  const infoButton = page.getByRole('button', { name: 'Frames info' })
  await expect(infoButton).toBeVisible()
  await infoButton.click()
  await expect(page.locator('.info-popover-content')).toContainText('Frames store the 8 controller positions')
})
