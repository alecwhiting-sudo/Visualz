import { expect, test, type Page } from '@playwright/test'

/**
 * App.tsx's real UI shell (not the `?test=1` harness — see transport-ui.spec.ts
 * for why): the two view modes (studio / full). The intermediate "perform"
 * slim-strip mode has been removed entirely (user decision: the studio
 * PERFORM tab already holds the full control surface — scene picker,
 * hand-off, param knobs, pads/XY, frames — so the strip added nothing) —
 * "Full screen" in the panel header now jumps straight from studio into true
 * Fullscreen-API fullscreen on the stage, and "V" is a plain two-state toggle.
 *
 * True fullscreen can't be asserted against real OS chrome headlessly, but
 * Playwright's headless Chromium does implement element Fullscreen for a
 * synthetic user gesture (a `.click()`) — verified directly against the built
 * preview server before writing this spec — so `document.fullscreenElement`
 * is asserted for real, and exit is simulated via `document.exitFullscreen()`
 * (standing in for "the browser exits fullscreen for any reason": Esc, OS
 * gesture, tab switch — cases this app can't distinguish from one another
 * either, which is exactly why it re-syncs off `fullscreenchange` rather than
 * only handling its own Full-screen button).
 */

async function litPixelCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas')!
    const gl = canvas.getContext('webgl2')!
    const pixels = new Uint8Array(canvas.width * canvas.height * 4)
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    let lit = 0
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 30) lit++
    }
    return lit
  })
}

test('studio mode (default) shows the full panel', async ({ page }) => {
  await page.goto('/')

  await expect(page.locator('.panel')).toBeVisible()
  await expect(page.locator('.panel-header h1')).toHaveText('Visualz')
  // The panel is tabbed (PERFORM | SESSION | INPUTS | CODE), PERFORM active by
  // default — Signals (INPUTS) and Session (SESSION) are regrouped behind
  // tabs now, so each is only visible once its own tab is active.
  await expect(page.getByRole('tab', { name: 'PERFORM' })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: 'INPUTS' }).click()
  await expect(page.locator('section', { has: page.locator('h2', { hasText: 'Signals' }) })).toBeVisible()
  await page.getByRole('tab', { name: 'SESSION' }).click()
  await expect(page.locator('section', { has: page.locator('h2', { hasText: 'Session' }) })).toBeVisible()
})

/**
 * Task item (3): tab switching shows/hides the right sections. Content for
 * every tab stays mounted (app.css toggles it via the `hidden` attribute, not
 * conditional rendering — see App.tsx's `panel-tab-content` divs) so that an
 * unsaved shader edit or the MIDI disclosure's open state survives a tab
 * switch; this test asserts the VISIBILITY toggle still behaves like a normal
 * tab strip regardless of that mounting choice. The pinned footer (Record/Arm
 * button) must stay visible no matter which tab is active — that's the whole
 * point of pinning it outside the tab strip.
 */
test('studio panel tabs show only the active tab\'s content; the footer stays pinned throughout', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.panel')).toBeVisible()

  const sceneTab = page.getByRole('tab', { name: 'PERFORM' })
  const sessionTab = page.getByRole('tab', { name: 'SESSION' })
  const inputsTab = page.getByRole('tab', { name: 'INPUTS' })
  const codeTab = page.getByRole('tab', { name: 'CODE' })
  const keyboardHint = page.locator('.keyboard-hint')
  const signalsSection = page.locator('section', { has: page.locator('h2', { hasText: 'Signals' }) })
  const sessionSection = page.locator('section', { has: page.locator('h2', { hasText: 'Session' }) })
  const footerRecordButton = page.locator('.panel-footer').getByRole('button', { name: /Record|Arm/ })

  // PERFORM (default): scene-only content visible, other tabs' content hidden
  // (still present in the DOM — count 1 — just not visible).
  await expect(sceneTab).toHaveAttribute('aria-selected', 'true')
  await expect(keyboardHint).toBeVisible()
  await expect(signalsSection).toHaveCount(1)
  await expect(signalsSection).not.toBeVisible()
  await expect(sessionSection).not.toBeVisible()
  await expect(footerRecordButton).toBeVisible()

  await inputsTab.click()
  await expect(inputsTab).toHaveAttribute('aria-selected', 'true')
  await expect(sceneTab).toHaveAttribute('aria-selected', 'false')
  await expect(signalsSection).toBeVisible()
  await expect(keyboardHint).not.toBeVisible()
  await expect(sessionSection).not.toBeVisible()
  await expect(footerRecordButton).toBeVisible()

  await sessionTab.click()
  await expect(sessionSection).toBeVisible()
  await expect(signalsSection).not.toBeVisible()
  await expect(footerRecordButton).toBeVisible()

  await codeTab.click()
  await expect(codeTab).toHaveAttribute('aria-selected', 'true')
  await expect(sessionSection).not.toBeVisible()
  await expect(signalsSection).not.toBeVisible()
  await expect(footerRecordButton).toBeVisible()
})

/**
 * Small addition (user report): the SCENE->PERFORM rename made the four tab
 * labels wider than the 320px panel's 288px inner width, clipping CODE off
 * the right edge. Each tab button must now fully fit inside the panel at the
 * panel's real (narrow) width — checked as a cheap bounding-box comparison
 * rather than a pixel diff.
 */
test('all four panel tabs fit fully inside the panel at its real width', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.panel')).toBeVisible()

  const panelBox = await page.locator('.panel').boundingBox()
  expect(panelBox).not.toBeNull()
  if (!panelBox) return

  const tabButtons = page.locator('.panel-tabs button')
  const count = await tabButtons.count()
  expect(count).toBe(4)

  const widths: number[] = []
  for (let i = 0; i < count; i++) {
    const box = await tabButtons.nth(i).boundingBox()
    expect(box).not.toBeNull()
    if (!box) continue
    widths.push(box.width)
    // Each button's right edge must sit at or inside the panel's right edge —
    // no clipping, no overflow off the panel.
    expect(box.x + box.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1)
  }

  // Equal widths (task: "no wrapping to two rows... equal widths") — loose
  // tolerance for sub-pixel layout rounding across the four buttons.
  const maxWidth = Math.max(...widths)
  const minWidth = Math.min(...widths)
  expect(maxWidth - minWidth).toBeLessThanOrEqual(2)
})

/**
 * Task item (1): the reported bug was the whole PAGE scrolling because the
 * panel column grew to whatever-is-expanded height, shrinking the canvas to
 * a tiny rectangle centered on the page. The panel's interior scroll
 * (`.panel-content`) plus the app shell's fixed 100vh/overflow: hidden must
 * hold regardless of which tab is open — checked across all four.
 */
test('studio mode never scrolls the page; the canvas stays fully inside the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/')
  await page.waitForTimeout(200)

  const viewport = page.viewportSize()
  expect(viewport).not.toBeNull()
  if (!viewport) return
  const epsilon = 2

  const assertNoPageScroll = async () => {
    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight)
    expect(scrollHeight).toBeLessThanOrEqual(viewport.height + epsilon)

    const box = await page.locator('canvas').boundingBox()
    expect(box).not.toBeNull()
    if (!box) return
    expect(box.x).toBeGreaterThanOrEqual(-epsilon)
    expect(box.y).toBeGreaterThanOrEqual(-epsilon)
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + epsilon)
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + epsilon)
  }

  await assertNoPageScroll()
  for (const name of ['SESSION', 'INPUTS', 'CODE']) {
    await page.getByRole('tab', { name }).click()
    await assertNoPageScroll()
  }
})

test('"V" toggles studio <-> full', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))
  await page.goto('/')
  await page.waitForTimeout(200)

  await expect(page.locator('.panel')).toBeVisible()
  const fullScreenButton = page.getByRole('button', { name: 'Full screen' })
  const fullscreenSupported = (await fullScreenButton.count()) > 0

  await page.keyboard.press('v')

  if (fullscreenSupported) {
    // studio -> full: zero chrome, real Fullscreen element.
    await expect(page.locator('.panel')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)

    // full -> studio.
    await page.keyboard.press('v')
    await expect(page.locator('.panel')).toBeVisible()
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false)
  } else {
    // No Fullscreen API (e.g. the iPhone Safari fallback this app targets):
    // there is nowhere else to go, so "V" is inert and studio stays put.
    await expect(page.locator('.panel')).toBeVisible()
  }

  expect(pageErrors).toEqual([])
})

/**
 * Bug fix regression test (relocated from the old "perform mode" test): the
 * CSS driving full mode's canvas used to be max-* only (no floor), which
 * never grows the canvas past its 960x540 attribute size — on a large
 * viewport, full mode showed a small centered rectangle rather than filling
 * the screen. With the strip gone, full mode is just the stage alone filling
 * the entire row — its bounding box must span (almost) the whole viewport.
 */
test('Full screen button enters real Fullscreen, fills the viewport, and fullscreenchange re-syncs to studio on exit', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/')
  await page.waitForTimeout(200)

  const fullScreenButton = page.getByRole('button', { name: 'Full screen' })
  if ((await fullScreenButton.count()) === 0) {
    // Fullscreen API unavailable in this environment — studio is the only
    // mode; nothing further to verify here.
    expect(pageErrors).toEqual([])
    return
  }

  await expect(fullScreenButton).toBeVisible()
  await fullScreenButton.click()

  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)
  // Zero chrome once truly fullscreen.
  await expect(page.locator('.panel')).toHaveCount(0)
  expect(await litPixelCount(page)).toBeGreaterThan(500)

  const viewport = page.viewportSize()
  expect(viewport).not.toBeNull()
  const canvasBox = await page.locator('canvas').boundingBox()
  expect(canvasBox).not.toBeNull()
  if (viewport && canvasBox) {
    expect(canvasBox.width).toBeGreaterThan(viewport.width * 0.95)
    expect(canvasBox.height).toBeGreaterThan(viewport.height * 0.95)
  }

  // Simulate the browser exiting fullscreen for any reason (Esc, OS gesture,
  // tab switch — this app can't tell them apart, which is why it listens for
  // `fullscreenchange` rather than only its own button).
  await page.evaluate(() => document.exitFullscreen())
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false)

  // viewMode re-synced to 'studio' (the only other mode there is now).
  await expect(page.locator('.panel')).toBeVisible()

  expect(pageErrors).toEqual([])
})
