import { expect, test, type Page } from '@playwright/test'

/**
 * Frame buttons F1-F8 (task #35, upgraded): eight per-scene snapshot slots
 * below the PERFORM tab's pads. Each slot stores the current scene's
 * first-8 param values NORMALIZED (position-relative, like Controls 1-8)
 * ALONGSIDE each param's binding text at store time (null = unbound) — a
 * frame fully defines the 8 controls' state, bindings included. Applying:
 * plain press jumps values instantly (and re-binds/clears bindings
 * instantly, always — never glided); shift+press glides the plain values
 * over the transition-speed knob's duration. Right-click clears a slot.
 * Real-app coverage (no `?test=1` harness — see transport-ui.spec.ts for
 * why); `window.__vizLive.setParam`/`setBinding`/`getBinding` are the seams,
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

function setBinding(page: Page, name: string, src: string): Promise<string | null> {
  return page.evaluate(({ name: n, src: s }) => window.__vizLive!.setBinding(n, s), { name, src })
}

function clearBinding(page: Page, name: string): Promise<void> {
  return page.evaluate((n) => window.__vizLive!.clearBinding(n), name)
}

function getBinding(page: Page, name: string): Promise<string | null> {
  return page.evaluate((n) => window.__vizLive!.getBinding(n), name)
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

test('right-click on a frame CLEARS the slot (task #35 upgrade — no longer stores)', async ({ page }) => {
  await boot(page)
  const param0 = await page.evaluate(() => window.__vizLive!.sceneParams()[0])

  // Store the default into F4, confirm it applies.
  await page.getByRole('button', { name: 'Store' }).click()
  await page.getByRole('button', { name: 'F4', exact: true }).click()
  await setParam(page, param0.name, param0.max)
  await page.getByRole('button', { name: 'F4', exact: true }).click()
  await expect.poll(() => getParam(page, param0.name)).toBeCloseTo(param0.default, 2)

  // Right-click clears it — the button loses its "occupied" styling and a
  // plain press on the (now-empty) slot no longer touches the param.
  const f4 = page.getByRole('button', { name: 'F4', exact: true })
  await expect(f4).toHaveClass(/frame-button-occupied/)
  await f4.click({ button: 'right' })
  await expect(f4).not.toHaveClass(/frame-button-occupied/)

  await setParam(page, param0.name, param0.max)
  await f4.click()
  await page.waitForTimeout(200)
  expect(await getParam(page, param0.name)).toBeCloseTo(param0.max, 2) // untouched — slot was empty
})

test('right-click clears even while Store mode is armed, and never applies the slot', async ({ page }) => {
  await boot(page)
  const param0 = await page.evaluate(() => window.__vizLive!.sceneParams()[0])

  await page.getByRole('button', { name: 'Store' }).click()
  await page.getByRole('button', { name: 'F6', exact: true }).click() // stores default into F6, disarms Store
  await setParam(page, param0.name, param0.max)

  // Arm Store again, then right-click F6: it must CLEAR (not re-store, and
  // not apply — the param stays at max, untouched).
  await page.getByRole('button', { name: 'Store' }).click()
  await page.getByRole('button', { name: 'F6', exact: true }).click({ button: 'right' })
  expect(await getParam(page, param0.name)).toBeCloseTo(param0.max, 2)
  await expect(page.getByRole('button', { name: 'F6', exact: true })).not.toHaveClass(/frame-button-occupied/)
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

// --- Task #35 upgrade: expression capture ----------------------------------

test('a stored expression round-trips through a frame: bind, change it, apply the frame restores the original', async ({
  page,
}) => {
  await boot(page)
  const param0 = await page.evaluate(() => window.__vizLive!.sceneParams()[0])

  const err = await setBinding(page, param0.name, '2 + sin(t)')
  expect(err).toBeNull()

  await page.getByRole('button', { name: 'Store' }).click()
  await page.getByRole('button', { name: 'F1', exact: true }).click()
  expect(await getBinding(page, param0.name)).toBe('2 + sin(t)')

  // Change the binding to something else.
  expect(await setBinding(page, param0.name, '1 + bass')).toBeNull()
  expect(await getBinding(page, param0.name)).toBe('1 + bass')

  // Applying the frame restores the ORIGINAL binding, instantly (no glide
  // needed to observe it — a binding set/clear is never glided).
  await page.getByRole('button', { name: 'F1', exact: true }).click()
  expect(await getBinding(page, param0.name)).toBe('2 + sin(t)')
})

test('a frame slot with a null expr CLEARS a live binding on apply', async ({ page }) => {
  await boot(page)
  const param0 = await page.evaluate(() => window.__vizLive!.sceneParams()[0])

  // Stored while UNBOUND (default value, no expression).
  await page.getByRole('button', { name: 'Store' }).click()
  await page.getByRole('button', { name: 'F1', exact: true }).click()
  expect(await getBinding(page, param0.name)).toBeNull()

  // Bind an expression AFTER storing — the frame doesn't know about it.
  expect(await setBinding(page, param0.name, '1 + bass')).toBeNull()
  expect(await getBinding(page, param0.name)).toBe('1 + bass')

  // Applying the frame must remove the binding (the frame's null expr wins)
  // and land the param back on its stored (default) value.
  await page.getByRole('button', { name: 'F1', exact: true }).click()
  await expect.poll(() => getBinding(page, param0.name)).toBeNull()
  await expect.poll(() => getParam(page, param0.name)).toBeCloseTo(param0.default, 2)
})

test('bug regression: clearing a bound expression makes frames affect that param again', async ({ page }) => {
  // Root cause investigated for the "frames stopped working after removing
  // expressions" report: `engine.clearBinding` (and the expr-input's clear
  // path via `useParamBinding.applyExpr`) DO fully delete the binding —
  // `getBinding` correctly returns undefined afterward, so the OLD
  // "skip params with a live binding" precedence rule was not literally
  // leaking a defined-but-empty binding. What WAS silently broken: an
  // unbound, non-macro-driven Knob's on-screen slider is backed by local
  // React state that a direct `engine.setParam` (which is exactly how
  // `applyFrame` writes) never touched — so even though the param's real
  // value updated correctly, the slider visibly froze, making a frame press
  // look like a no-op. This test asserts the underlying VALUE moves (the
  // original report's literal claim); the slider-visibility half of the
  // same root cause is covered by the visible-slider test below.
  await boot(page)
  const param0 = await page.evaluate(() => window.__vizLive!.sceneParams()[0])

  expect(await setBinding(page, param0.name, '1 + bass')).toBeNull()

  // Store while BOUND (this scene had an expression on param0)…
  await page.getByRole('button', { name: 'Store' }).click()
  await page.getByRole('button', { name: 'F1', exact: true }).click()

  // …then remove the expression (the user's reported workflow).
  await clearBinding(page, param0.name)
  expect(await getBinding(page, param0.name)).toBeNull()

  // Move the now-unbound param away from its stored position.
  const changed = param0.min + (param0.max - param0.min) * 0.9
  await setParam(page, param0.name, changed)
  expect(await getParam(page, param0.name)).toBeCloseTo(changed, 2)

  // F1 was stored while bound, so its expr for this param is non-null —
  // applying it re-binds the ORIGINAL expression (new task #35 semantics: a
  // frame fully defines binding state, not just a value).
  await page.getByRole('button', { name: 'F1', exact: true }).click()
  await expect.poll(() => getBinding(page, param0.name)).toBe('1 + bass')
})

test('a frame press visibly moves the on-screen slider for a plain (unbound, non-macro) param', async ({ page }) => {
  // The second half of the bug-regression root cause above: applyFrame
  // writes via engine.setParam directly, which an unbound Knob's own local
  // slider state does not observe on its own. Asserts the actual DOM
  // input's value attribute, not just the engine's internal getParam.
  await boot(page)
  const param0 = await page.evaluate(() => window.__vizLive!.sceneParams()[0])
  const slider = page.locator('input[type=range]').first()

  await page.getByRole('button', { name: 'Store' }).click()
  await page.getByRole('button', { name: 'F1', exact: true }).click() // stores default

  await setParam(page, param0.name, param0.max)
  await expect.poll(async () => Number(await slider.inputValue())).toBeCloseTo(param0.max, 2)

  await page.getByRole('button', { name: 'F1', exact: true }).click()
  await expect.poll(async () => Number(await slider.inputValue())).toBeCloseTo(param0.default, 2)
  expect(await getParam(page, param0.name)).toBeCloseTo(param0.default, 2)
})
