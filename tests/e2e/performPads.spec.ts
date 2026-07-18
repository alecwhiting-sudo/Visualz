import { expect, test } from '@playwright/test'

/**
 * Pads/PERFORM batch: real-app coverage (no `?test=1` harness — see
 * transport-ui.spec.ts for why) for
 *   1. the trigger pads + XY pad now living in the PERFORM tab (moved from
 *      INPUTS) with their "?" guidance popovers, and
 *   2. positional pad targeting actually driving a NON-Lissajous scene's own
 *      param (the bug this batch fixes — T1-T4 used to be hardcoded to
 *      Lissajous param names, dead on every other scene).
 * (The perform strip's compact pads/XY variant and its main-row alignment
 * fix were removed along with the strip itself — see viewmodes.spec.ts.)
 */

const PADS_HELP_SNIPPET = 'Momentary hits: T1-T4 each pulse'
const XY_HELP_SNIPPET = 'writes the pad.x / pad.y signals'

test('PERFORM tab shows the trigger pads + XY pad, each with a working "?" popover', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.panel')).toBeVisible()
  // PERFORM (id 'scene') is the default active tab — no tab click needed.
  await expect(page.getByRole('tab', { name: 'PERFORM' })).toHaveAttribute('aria-selected', 'true')

  const padsInfoButton = page.getByRole('button', { name: 'Trigger pads info' })
  const xyInfoButton = page.getByRole('button', { name: 'XY pad info' })
  await expect(page.locator('.trigger-grid')).toBeVisible()
  await expect(page.locator('.xy-pad')).toBeVisible()
  await expect(padsInfoButton).toBeVisible()
  await expect(xyInfoButton).toBeVisible()

  // Closed by default.
  await expect(page.locator('.info-popover-content')).toHaveCount(0)

  // Click opens the pads popover with the spec'd copy.
  await padsInfoButton.click()
  const padsContent = page.locator('.info-popover-content')
  await expect(padsContent).toBeVisible()
  await expect(padsContent).toContainText(PADS_HELP_SNIPPET)

  // Fully ON the page (user report: this "?" sits near the panel's right
  // edge and its left-anchored popover ran 31px off-screen — InfoPopover
  // now flips to right-anchored when left-anchoring would overflow).
  const viewport = page.viewportSize()!
  const box = (await padsContent.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)

  // Click again toggles it closed.
  await padsInfoButton.click()
  await expect(page.locator('.info-popover-content')).toHaveCount(0)

  // Click-away closes it (open via click, then click somewhere neutral).
  await padsInfoButton.click()
  await expect(page.locator('.info-popover-content')).toBeVisible()
  await page.locator('.panel-header h1').click()
  await expect(page.locator('.info-popover-content')).toHaveCount(0)

  // Esc closes it too.
  await padsInfoButton.click()
  await expect(page.locator('.info-popover-content')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.info-popover-content')).toHaveCount(0)

  // The XY pad's popover has its own, different copy.
  await xyInfoButton.click()
  const xyContent = page.locator('.info-popover-content')
  await expect(xyContent).toBeVisible()
  await expect(xyContent).toContainText(XY_HELP_SNIPPET)
  await expect(xyContent).not.toContainText(PADS_HELP_SNIPPET)
})

/**
 * The core bug fix (CONTEXT): T1-T4 used to be hardcoded to Lissajous param
 * names (drift/hueSpeed/freqX/freqY) — dead on every other scene. Switching
 * to Julia (a scene with no such params at all) and pressing T1 must now
 * visibly kick JULIA'S OWN first param, positionally. Reads
 * `sceneParams()[0].name` rather than hardcoding "orbitSpeed" so this stays
 * correct if Julia's param order ever changes.
 */
test('a pad press on a non-Lissajous scene (Julia) visibly changes its own pulsed param', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.panel')).toBeVisible()
  await page.waitForFunction(() => window.__vizLive !== undefined)

  const sceneSelect = page.locator('.scene-select', { hasText: 'Scene' }).locator('select')
  await sceneSelect.selectOption('julia')

  const firstParam = await page.evaluate(() => window.__vizLive!.sceneParams()[0])
  expect(firstParam.name).not.toBe('drift')
  expect(firstParam.name).not.toBe('hueSpeed')
  expect(firstParam.name).not.toBe('freqX')
  expect(firstParam.name).not.toBe('freqY')

  const before = await page.evaluate((n) => window.__vizLive!.getParam(n), firstParam.name)

  await page.getByRole('button', { name: 'T1' }).first().click()
  // The pulse only takes effect once the live engine's rAF loop processes the
  // queued trigger event (MappingRuntime.update, next tick) — give it a
  // couple of frames, then read promptly (the pulse decays, halflife 0.4s).
  await page.waitForTimeout(50)
  const after = await page.evaluate((n) => window.__vizLive!.getParam(n), firstParam.name)

  // Full kick amount is 0.3 * (max - min); a generous fraction of that survives
  // any realistic delay between the click and this read.
  const fullAmount = 0.3 * (firstParam.max - firstParam.min)
  expect(after - before).toBeGreaterThan(fullAmount * 0.3)
})

