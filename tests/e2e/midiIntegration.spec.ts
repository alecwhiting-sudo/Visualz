import { expect, test, type Page } from '@playwright/test'

/**
 * Full-chain MIDI integration against the REAL app shell: a fake
 * `navigator.requestMIDIAccess` is injected via addInitScript BEFORE the app
 * boots, so attachMidi subscribes to a fake device and every layer between
 * "hardware" and pixels runs for real — decode → App sink wrapper → macro
 * CC→ctl republish → Engine.setInputSignal → MacroRouter pickup → positional
 * param drive — including across an in-place handoff switch, which is the
 * exact chain a user-reported bug ("mapping of knobs does not survive hand
 * offs", Launchkey Mini) lives on and which no other spec could exercise
 * (midi.spec.ts documents that WebMIDI always rejects headlessly without this).
 */

declare global {
  interface Window {
    __fakeMidi?: { send(bytes: number[]): void }
  }
}

async function bootWithFakeMidi(page: Page) {
  await page.addInitScript(() => {
    const input = {
      id: 'fake-1',
      name: 'Launchkey Mini MK3 MIDI',
      type: 'input',
      onmidimessage: null as null | ((ev: { data: Uint8Array }) => void),
    }
    const access = {
      inputs: { forEach: (cb: (i: typeof input) => void) => cb(input) },
      onstatechange: null,
    }
    ;(navigator as unknown as { requestMIDIAccess: () => Promise<unknown> }).requestMIDIAccess = () =>
      Promise.resolve(access)
    window.__fakeMidi = {
      send: (bytes: number[]) => input.onmidimessage?.({ data: new Uint8Array(bytes) }),
    }
  })
  await page.goto('/')
  // Device list reflects the fake input once access resolves.
  await page.locator('.panel-tabs button', { hasText: 'INPUTS' }).click()
  await page.getByRole('button', { name: 'MIDI' }).click()
  await expect(page.getByText('Launchkey Mini MK3 MIDI')).toBeVisible()
}

function cc(page: Page, num: number, value: number) {
  return page.evaluate(([n, v]) => window.__fakeMidi!.send([0xb0, n, v]), [num, value])
}

async function getParam(page: Page, name: string): Promise<number> {
  return page.evaluate((n) => window.__vizLive!.getParam(n), name)
}

test('macro-mapped hardware knobs keep driving params across a handoff', async ({ page }) => {
  await bootWithFakeMidi(page)

  // Map controls: CC 21 -> slot 1, CC 22 -> slot 2 (Launchkey knob CCs).
  await page.getByRole('button', { name: 'Map controls…' }).click()
  await cc(page, 21, 10)
  await cc(page, 21, 12) // burst dedup: same CC again must NOT claim slot 2
  await cc(page, 22, 10)
  await page.getByRole('button', { name: /Stop mapping/ }).click()
  await expect(page.getByText('CC 21')).toBeVisible()
  await expect(page.getByText('CC 22')).toBeVisible()

  // Slot 1 drives the current scene's first param to its schema max at CC 127.
  const lissParam1 = await page.evaluate(() => window.__vizLive!.sceneParams()[0])
  await cc(page, 21, 127)
  await expect.poll(() => getParam(page, lissParam1.name)).toBeCloseTo(lissParam1.max, 1)

  // Hand off (PERFORM tab -> Switch button targets Flow Field by default).
  await page.locator('.panel-tabs button', { hasText: 'PERFORM' }).click()
  await page.getByRole('button', { name: /Switch \(hand off\)/i }).click()

  // Dormant after the switch: the new scene's first param holds its default.
  const flowParam1 = await page.evaluate(() => {
    const api = window.__vizLive!
    return api.sceneParams()[0]
  })
  expect(await getParam(page, flowParam1.name)).toBeCloseTo(flowParam1.default, 4)

  // Touch the SAME hardware knob: slot 1 must engage and drive the NEW
  // scene's first param — this is "the mapping survives the handoff".
  await cc(page, 21, 127)
  await expect
    .poll(() => getParam(page, flowParam1.name))
    .toBeCloseTo(flowParam1.max, 1)
})

/**
 * MIDI setup persistence (user report: "mapped all 8 controls, then knobs
 * went dead" — a page reload was wiping the session-scoped macroCcBySlot
 * table). `bootWithFakeMidi`'s `addInitScript` re-applies to every
 * subsequent navigation on the same page, so `page.reload()` still lands on
 * the fake MIDIAccess.
 */
test('macro mapping persists across a page reload', async ({ page }) => {
  await bootWithFakeMidi(page)

  await page.getByRole('button', { name: 'Map controls…' }).click()
  await cc(page, 31, 10)
  await page.getByRole('button', { name: /Stop mapping/ }).click()
  await expect(page.getByText('CC 31')).toBeVisible()

  await page.reload()
  await page.locator('.panel-tabs button', { hasText: 'INPUTS' }).click()
  await page.getByRole('button', { name: 'MIDI' }).click()
  await expect(page.getByText('CC 31')).toBeVisible()

  // Not just a display artifact: the restored mapping actually drives params.
  const param0 = await page.evaluate(() => window.__vizLive!.sceneParams()[0])
  await cc(page, 31, 127)
  await expect.poll(() => getParam(page, param0.name)).toBeCloseTo(param0.max, 1)
})

test('seeding localStorage before boot restores the Controls 1-8 rows', async ({ page }) => {
  // The Controls 1-8 block only renders once `midiSupported` is true, which
  // headless Chromium's real WebMIDI never is (midi.spec.ts) — layer the
  // localStorage seed in BEFORE `bootWithFakeMidi`'s own addInitScript+goto;
  // Playwright applies every registered init script, in order, to each
  // subsequent navigation, so both take effect on the same first load.
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'visualz.midi.macroSlots.v1',
      JSON.stringify([40, 41, null, null, null, null, null, null]),
    )
  })
  await bootWithFakeMidi(page)
  await expect(page.getByText('CC 40')).toBeVisible()
  await expect(page.getByText('CC 41')).toBeVisible()
})

test('"Clear mapping" resets all 8 slots, and the reset itself persists across a reload', async ({ page }) => {
  await bootWithFakeMidi(page)

  await page.getByRole('button', { name: 'Map controls…' }).click()
  await cc(page, 50, 10)
  await page.getByRole('button', { name: /Stop mapping/ }).click()
  await expect(page.getByText('CC 50')).toBeVisible()

  await page.getByRole('button', { name: 'Clear mapping' }).click()
  await expect(page.getByText('CC 50')).toHaveCount(0)

  await page.reload()
  await page.locator('.panel-tabs button', { hasText: 'INPUTS' }).click()
  await page.getByRole('button', { name: 'MIDI' }).click()
  await expect(page.getByText('CC 50')).toHaveCount(0)
})
