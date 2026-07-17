import { expect, test, type Page } from '@playwright/test'

/**
 * Pads/PERFORM batch: real-app coverage (no `?test=1` harness — see
 * transport-ui.spec.ts for why) for
 *   1. the trigger pads + XY pad now living in the PERFORM tab (moved from
 *      INPUTS) with their "?" guidance popovers,
 *   2. positional pad targeting actually driving a NON-Lissajous scene's own
 *      param (the bug this batch fixes — T1-T4 used to be hardcoded to
 *      Lissajous param names, dead on every other scene),
 *   3. compact pads + XY also rendering in the perform strip, and
 *   4. the perform strip's main-row baseline alignment fix.
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

async function switchToPerformStrip(page: Page) {
  await page.goto('/')
  await page.waitForTimeout(200)
  await page.getByRole('button', { name: 'Stage view' }).click()
  await expect(page.locator('.perform-strip')).toBeVisible()
}

test('compact trigger pads + XY pad also render in the perform strip', async ({ page }) => {
  await switchToPerformStrip(page)
  const strip = page.locator('.perform-strip')

  const compactPads = strip.locator('.perform-strip-pads .trigger-grid-compact')
  const compactXy = strip.locator('.perform-strip-pads .xy-pad-compact')
  await expect(compactPads).toBeVisible()
  await expect(compactXy).toBeVisible()
  await expect(compactPads.getByRole('button', { name: 'T1' })).toBeVisible()

  // Both compact controls carry their own "?" popovers too.
  await expect(strip.locator('.perform-strip-pads').getByRole('button', { name: 'Trigger pads info' })).toBeVisible()
  await expect(strip.locator('.perform-strip-pads').getByRole('button', { name: 'XY pad info' })).toBeVisible()

  // The strip stays in-flow and lean — still doesn't eat the canvas.
  const canvasBox = await page.locator('canvas').boundingBox()
  const stripBox = await page.locator('.perform-strip').boundingBox()
  expect(canvasBox).not.toBeNull()
  expect(stripBox).not.toBeNull()
  if (!canvasBox || !stripBox) return
  expect(canvasBox.y + canvasBox.height).toBeLessThanOrEqual(stripBox.y + 1)
})

/**
 * Alignment fix (user screenshot, item 4): the Scene/"Hand off to" selects
 * (label above control) and the bare SWITCH/ARM buttons used to look ragged
 * under `align-items: center`. `flex-end` should bottom-align every direct
 * child of `.perform-strip-main` — checked here as a cheap bounding-box
 * comparison rather than a pixel diff.
 */
test('perform strip main row bottom-aligns its controls', async ({ page }) => {
  await switchToPerformStrip(page)
  const strip = page.locator('.perform-strip')

  const sceneSelectBox = await strip.locator('.scene-select', { hasText: 'Scene' }).locator('select').boundingBox()
  const switchButtonBox = await strip.getByRole('button', { name: /Switch \(hand off\)/i }).boundingBox()
  const armButtonBox = await strip.getByRole('button', { name: 'Arm' }).boundingBox()

  expect(sceneSelectBox).not.toBeNull()
  expect(switchButtonBox).not.toBeNull()
  expect(armButtonBox).not.toBeNull()
  if (!sceneSelectBox || !switchButtonBox || !armButtonBox) return

  const bottoms = [
    sceneSelectBox.y + sceneSelectBox.height,
    switchButtonBox.y + switchButtonBox.height,
    armButtonBox.y + armButtonBox.height,
  ]
  const maxBottom = Math.max(...bottoms)
  const minBottom = Math.min(...bottoms)
  expect(maxBottom - minBottom).toBeLessThanOrEqual(6)
})
