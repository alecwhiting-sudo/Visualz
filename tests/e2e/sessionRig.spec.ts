import { expect, test, type Page } from '@playwright/test'

/**
 * Session rig (docs/SESSIONS.md, user decisions §7): per-algorithm memory —
 * knobs and expressions survive switching away and back within a session —
 * plus export/import as a JSON file, New session, and the localStorage
 * restore banner. Real-app specs throughout (the memory lives in App, not
 * the engine).
 */

async function boot(page: Page) {
  await page.goto('/')
  await expect(page.locator('.panel')).toBeVisible()
  await page.waitForFunction(() => window.__vizLive !== undefined)
}

async function handOffTo(page: Page, sceneId: string) {
  await page.locator('.switch-control select').selectOption(sceneId)
  await page.getByRole('button', { name: /Switch \(hand off\)/i }).click()
}

function getParam(page: Page, name: string): Promise<number> {
  return page.evaluate((n) => window.__vizLive!.getParam(n), name)
}

test('knobs and expressions survive switching away and back (per-algorithm memory)', async ({ page }) => {
  await boot(page)

  // Leave lissajous with a moved knob and a bound expression.
  await page.evaluate(() => window.__vizLive!.setParam('freqX', 9))
  const freqYRow = page.locator('.knob').filter({ hasText: 'Y frequency' })
  await freqYRow.locator('input.expr').fill('1 + bass * 11')
  await expect(freqYRow.locator('em')).toHaveText('ƒ(t)')

  await handOffTo(page, 'julia')
  // Julia starts from ITS defaults (fresh — never visited before).
  const juliaParam0 = await page.evaluate(() => window.__vizLive!.sceneParams()[0])
  expect(await getParam(page, juliaParam0.name)).toBeCloseTo(juliaParam0.default, 5)

  await handOffTo(page, 'lissajous')
  // Back home: knob and expression exactly as left.
  await expect.poll(() => getParam(page, 'freqX')).toBeCloseTo(9, 5)
  const restoredRow = page.locator('.knob').filter({ hasText: 'Y frequency' })
  await expect(restoredRow.locator('input.expr')).toHaveValue('1 + bass * 11')
  await expect(restoredRow.locator('em')).toHaveText('ƒ(t)')
})

test('session export -> New session -> import round-trips the rig', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => window.__vizLive!.setParam('freqX', 11))

  await page.getByRole('tab', { name: 'SESSION' }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export session', exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('visualz-session.json')
  const path = await download.path()

  // New session: everything back to defaults.
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  const param0 = await page.evaluate(() => window.__vizLive!.sceneParams()[0])
  await expect.poll(() => getParam(page, param0.name)).toBeCloseTo(param0.default, 5)

  // Import the exported file through the unified Load affordance.
  await page
    .locator('.session-file input[type=file]')
    .first()
    .setInputFiles(path!)
  await expect.poll(() => getParam(page, 'freqX')).toBeCloseTo(11, 5)
})

test('the restore banner offers a previous device-local session and applies it', async ({ page }) => {
  // Seed localStorage BEFORE the app boots — what a previous visit's
  // autosave would have left behind.
  await page.addInitScript(() => {
    localStorage.setItem(
      'visualz.session.v1',
      JSON.stringify({
        kind: 'session',
        version: 1,
        scenes: { lissajous: { params: { freqX: 8 } } },
        global: {},
      }),
    )
  })
  await boot(page)

  // Boot is pure defaults (user spec) — the banner only OFFERS.
  expect(await getParam(page, 'freqX')).toBeCloseTo(3, 5)

  await page.getByRole('tab', { name: 'SESSION' }).click()
  const banner = page.locator('.restore-banner')
  await expect(banner).toBeVisible()
  await banner.getByRole('button', { name: 'Restore' }).click()
  await expect(banner).toHaveCount(0)
  await expect.poll(() => getParam(page, 'freqX')).toBeCloseTo(8, 5)
})

test('the rig survives a replay longer than the autosave tick (review finding: replay-engine poisoning)', async ({
  page,
}) => {
  // The 3s autosave used to capture from the REPLAY engine (engineRef points
  // at it during replay), overwriting or deleting the user's per-scene
  // memory and persisting the damage. Guarded now by transport-mode checks.
  await boot(page)
  await page.evaluate(() => window.__vizLive!.setParam('freqX', 9))

  // Record a >3.5s demo-mode take so the autosave interval fires mid-replay.
  await page.getByRole('button', { name: 'Arm' }).click()
  await expect(page.getByRole('button', { name: 'End take' })).toBeVisible()
  await page.waitForTimeout(3800)
  await page.getByRole('button', { name: 'End take' }).click()

  await page.getByRole('tab', { name: 'SESSION' }).click()
  await page.getByRole('button', { name: 'Replay', exact: true }).click()
  // While replaying, the session controls must be inert.
  await expect(page.getByRole('button', { name: 'Export session' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'New session' })).toBeDisabled()
  // Let the replay outlive at least one autosave tick, then wait for it to end.
  await expect(page.getByRole('button', { name: 'Replay', exact: true })).toBeEnabled({ timeout: 20000 })

  // The customized value survives: leave and return to lissajous.
  await page.getByRole('tab', { name: 'PERFORM' }).click()
  await handOffTo(page, 'julia')
  await handOffTo(page, 'lissajous')
  await expect.poll(() => getParam(page, 'freqX')).toBeCloseTo(9, 5)
})

test('a mid-take return to a customized algorithm records the restore (replay-native)', async ({ page }) => {
  // Harness-level proof that App-layer restores ride the RECORDED seams:
  // not applicable in ?test=1 (no App), so assert on the real app's
  // recorded doc instead — the restore's param event must be in the log.
  await boot(page)
  await page.evaluate(() => window.__vizLive!.setParam('freqX', 10))
  await handOffTo(page, 'julia')

  // Record in demo mode (no track needed): Arm starts the take immediately.
  await page.getByRole('button', { name: 'Arm' }).click()
  await expect(page.getByRole('button', { name: 'End take' })).toBeVisible()
  await page.waitForTimeout(300)
  await handOffTo(page, 'lissajous') // mid-take return -> memory restore, recorded
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: 'End take' }).click()

  await expect.poll(() => page.evaluate(() => window.__vizLive!.lastSessionDoc() !== null)).toBe(true)
  const events = (await page.evaluate(() => window.__vizLive!.lastSessionDoc())) as {
    events: Array<{ type: string; name?: string; toScene?: string; value?: number }>
  }
  const switchIdx = events.events.findIndex((e) => e.type === 'switch' && e.toScene === 'lissajous')
  expect(switchIdx).toBeGreaterThanOrEqual(0)
  const restore = events.events
    .slice(switchIdx)
    .find((e) => e.type === 'param' && e.name === 'freqX' && e.value === 10)
  expect(restore).toBeDefined()
})
