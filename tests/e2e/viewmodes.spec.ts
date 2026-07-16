import { expect, test, type Page } from '@playwright/test'

/**
 * App.tsx's real UI shell (not the `?test=1` harness — see transport-ui.spec.ts
 * for why): the three view modes (studio / perform / full).
 *
 * No audio file is loaded in any of these tests (transport-ui.spec.ts already
 * established the repo's convention that loading a real fixture file headlessly
 * isn't practical without a user-gesture-gated AudioContext) — `playback.hasFile`
 * stays false throughout, so the transport row itself never renders (same as
 * studio mode with no file: `.transport-row` has count 0). What these tests
 * verify instead is the strip's *structure* (scene select + Record button +
 * view-mode buttons all present) and that switching to it doesn't blank the
 * canvas or leave the panel showing.
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
  await expect(page.getByRole('button', { name: 'Perform view' })).toBeVisible()
  // The panel is tabbed (SCENE | SESSION | INPUTS | CODE), SCENE active by
  // default — Signals (INPUTS) and Session (SESSION) are regrouped behind
  // tabs now, so each is only visible once its own tab is active.
  await expect(page.getByRole('tab', { name: 'SCENE' })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: 'INPUTS' }).click()
  await expect(page.locator('section', { has: page.locator('h2', { hasText: 'Signals' }) })).toBeVisible()
  await page.getByRole('tab', { name: 'SESSION' }).click()
  await expect(page.locator('section', { has: page.locator('h2', { hasText: 'Session' }) })).toBeVisible()
  await expect(page.locator('.perform-strip')).toHaveCount(0)
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

  const sceneTab = page.getByRole('tab', { name: 'SCENE' })
  const sessionTab = page.getByRole('tab', { name: 'SESSION' })
  const inputsTab = page.getByRole('tab', { name: 'INPUTS' })
  const codeTab = page.getByRole('tab', { name: 'CODE' })
  const keyboardHint = page.locator('.keyboard-hint')
  const signalsSection = page.locator('section', { has: page.locator('h2', { hasText: 'Signals' }) })
  const sessionSection = page.locator('section', { has: page.locator('h2', { hasText: 'Session' }) })
  const footerRecordButton = page.locator('.panel-footer').getByRole('button', { name: /Record|Arm/ })

  // SCENE (default): scene-only content visible, other tabs' content hidden
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

test('switching to perform mode hides the panel and shows the slim strip', async ({ page }) => {
  await page.goto('/')
  // Let the live engine render a few frames before switching, so the
  // non-blank check below isn't racing the very first paint.
  await page.waitForTimeout(200)

  await page.getByRole('button', { name: 'Perform view' }).click()

  await expect(page.locator('.panel')).toHaveCount(0)
  const strip = page.locator('.perform-strip')
  await expect(strip).toBeVisible()
  // .first(): the strip now also renders the scene-handoff target selector
  // (docs/HANDOFF.md §6), which reuses the `.scene-select` label style, so
  // .scene-select resolves to two elements — the cold-swap dropdown first,
  // then the hand-off target picker.
  await expect(strip.locator('.scene-select').first()).toBeVisible()
  await expect(strip.locator('.switch-control')).toBeVisible()
  await expect(strip.getByRole('button', { name: 'Record' })).toBeVisible()
  await expect(strip.getByRole('button', { name: 'Studio' })).toBeVisible()
  // Meters, MIDI section, shader editor etc. must not be rendered at all.
  await expect(page.locator('section', { has: page.locator('h2', { hasText: 'Signals' }) })).toHaveCount(0)
  await expect(page.locator('section', { has: page.locator('h2', { hasText: 'MIDI' }) })).toHaveCount(0)

  expect(await litPixelCount(page)).toBeGreaterThan(500)

  // The strip's own Studio button returns to studio.
  await strip.getByRole('button', { name: 'Studio' }).click()
  await expect(page.locator('.panel')).toBeVisible()
  await expect(page.locator('.perform-strip')).toHaveCount(0)
})

test('perform strip shows one rotary knob per current-scene param', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.panel')).toBeVisible()

  // Count the studio panel's param sliders first — avoids hardcoding a
  // scene-specific number that would go stale the moment a scene's param
  // list changes; the rotary row must track whatever the scene actually
  // exposes.
  const studioKnobCount = await page.locator('.knob').count()
  expect(studioKnobCount).toBeGreaterThan(0)

  await page.getByRole('button', { name: 'Perform view' }).click()
  const strip = page.locator('.perform-strip')
  await expect(strip).toBeVisible()

  const rotaries = strip.locator('.rotary-knob')
  await expect(rotaries).toHaveCount(studioKnobCount)
})

test('"V" cycles studio -> perform -> full -> studio', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))
  await page.goto('/')
  await page.waitForTimeout(200)

  await expect(page.locator('.panel')).toBeVisible()

  await page.keyboard.press('v')
  await expect(page.locator('.panel')).toHaveCount(0)
  const strip = page.locator('.perform-strip')
  await expect(strip).toBeVisible()

  const fullScreenButton = strip.getByRole('button', { name: 'Full screen' })
  const fullscreenSupported = (await fullScreenButton.count()) > 0

  await page.keyboard.press('v')
  if (fullscreenSupported) {
    // perform -> full: zero chrome, real Fullscreen element.
    await expect(page.locator('.perform-strip')).toHaveCount(0)
    await expect(page.locator('.panel')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)

    // full -> studio.
    await page.keyboard.press('v')
    await expect(page.locator('.panel')).toBeVisible()
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false)
  } else {
    // No Fullscreen API (e.g. the iPhone Safari fallback this app targets):
    // the cycle is a plain two-state toggle, perform -> studio directly.
    await expect(page.locator('.panel')).toBeVisible()
  }

  expect(pageErrors).toEqual([])
})

test('Full screen button enters real Fullscreen and fullscreenchange re-syncs to perform on exit', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))
  await page.goto('/')

  await page.getByRole('button', { name: 'Perform view' }).click()
  const strip = page.locator('.perform-strip')
  const fullScreenButton = strip.getByRole('button', { name: 'Full screen' })

  if ((await fullScreenButton.count()) === 0) {
    // Fullscreen API unavailable in this environment — perform mode is the
    // documented fallback; nothing further to verify here.
    expect(pageErrors).toEqual([])
    return
  }

  await expect(fullScreenButton).toBeVisible()
  await fullScreenButton.click()

  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)
  // Zero chrome once truly fullscreen.
  await expect(page.locator('.perform-strip')).toHaveCount(0)
  await expect(page.locator('.panel')).toHaveCount(0)

  // Simulate the browser exiting fullscreen for any reason (Esc, OS gesture,
  // tab switch — this app can't tell them apart, which is why it listens for
  // `fullscreenchange` rather than only its own button).
  await page.evaluate(() => document.exitFullscreen())
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false)

  // viewMode re-synced to 'perform', not stuck on 'full' or reset to 'studio'.
  await expect(page.locator('.perform-strip')).toBeVisible()
  await expect(page.locator('.panel')).toHaveCount(0)

  expect(pageErrors).toEqual([])
})

/**
 * Bug fix regression test: the CSS driving .app-perform/.app-full's canvas
 * used to be max-* only (no floor), which never grows the canvas past its
 * 960x540 attribute size — on a large viewport, perform/full mode showed a
 * small centered rectangle rather than filling the screen. The canvas's
 * rendered bounding box (its CSS box, independent of the letterboxed content
 * object-fit: contain draws inside it) must now span the viewport's width
 * almost exactly (the strip never eats into horizontal space).
 *
 * Task item (2): the strip used to be position: fixed, OVERLAYING the bottom
 * of a 100vh canvas — the dials covered the visuals. It's now in normal flow
 * below the stage, so the stage (and the canvas inside it) must shrink to
 * make room: canvas and strip may never intersect, and together their boxes
 * must cover (almost) the entire viewport height with no gap between them.
 */
test('perform mode scales the canvas to fill the stage, with the strip in flow below it (no overlap)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/')
  await page.waitForTimeout(200)

  await page.getByRole('button', { name: 'Perform view' }).click()
  await expect(page.locator('.perform-strip')).toBeVisible()

  const canvasBox = await page.locator('canvas').boundingBox()
  const stripBox = await page.locator('.perform-strip').boundingBox()
  expect(canvasBox).not.toBeNull()
  expect(stripBox).not.toBeNull()
  const viewport = page.viewportSize()
  expect(viewport).not.toBeNull()
  if (!canvasBox || !stripBox || !viewport) return

  // Width: the strip only ever eats into vertical space, never horizontal —
  // a looser tolerance keeps this robust to scrollbar/DPR rounding.
  expect(canvasBox.width).toBeGreaterThan(viewport.width * 0.95)

  // No overlap: the canvas's bottom edge sits at or above the strip's top.
  expect(canvasBox.y + canvasBox.height).toBeLessThanOrEqual(stripBox.y + 1)
  // The strip must be FULLY INSIDE the viewport — not merely non-overlapping.
  // (The original coverage-style assertions passed tautologically when the
  // strip sat at exactly y === viewport height, i.e. entirely off-screen:
  // "canvas.bottom <= strip.top" is trivially true for an invisible strip.
  // Caught by the architect's screenshot pass, hence this hard bound.)
  expect(stripBox.y + stripBox.height).toBeLessThanOrEqual(viewport.height + 1)
  // Strip has real on-screen height (dials + controls, not a collapsed sliver).
  expect(stripBox.height).toBeGreaterThan(40)
  // Together they cover (almost) the full viewport height: the canvas starts
  // at the top and the strip's bottom reaches (almost) the viewport's bottom,
  // with no dead gap between them.
  expect(canvasBox.y).toBeLessThan(1)
  expect(stripBox.y + stripBox.height).toBeGreaterThan(viewport.height - 40)
})
