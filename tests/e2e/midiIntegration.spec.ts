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

/** Sends a note-on (velocity 100) — the only kind that fires a trigger (see
 * `decodeMidiMessage`: velocity-0 note-on folds to note-off). */
function noteOn(page: Page, num: number) {
  return page.evaluate((n) => window.__fakeMidi!.send([0x90, n, 100]), num)
}

async function getParam(page: Page, name: string): Promise<number> {
  return page.evaluate((n) => window.__vizLive!.getParam(n), name)
}

async function getFxParam(page: Page, passId: string, name: string): Promise<number> {
  return page.evaluate(([p, n]) => window.__vizLive!.getFxParam(p, n), [passId, name])
}

test('macro-mapped hardware knobs keep driving params across a handoff', async ({ page }) => {
  await bootWithFakeMidi(page)

  // Map controls: CC 21 -> slot 1, CC 22 -> slot 2 (Launchkey knob CCs).
  await page.getByRole('button', { name: 'Map controls…' }).click()
  await cc(page, 21, 10)
  await cc(page, 21, 12) // burst dedup: same CC again must NOT claim slot 2
  await cc(page, 22, 10)
  await page.getByRole('button', { name: /Stop mapping/ }).click()
  await expect(page.locator('.macro-slot-cc', { hasText: 'CC 21' })).toBeVisible()
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

/**
 * Regression for the sequential-learn dedup guard bug (App.tsx
 * `acceptLaunchkeyMap` / DISTINCT-CC guard fix at the sequential-learn CC
 * handler ~line 1406): with a pre-populated table (the Launchkey auto-map
 * having already claimed all 8 slots — CC 21-28), running "Map controls…"
 * again and sweeping the same 8 CCs must still complete all 8 slots and
 * drive params. Before the `already < macro.slot - 1` fix, `already >= 0`
 * alone made every "already mapped" CC a no-op forever, so slot 1 (armed
 * first) matched CC 21 (already at slot 0 = "already mapped") and the whole
 * sequential pass deadlocked — "manual midi-learn not biting".
 */
test('sequential learn remaps over a pre-populated table', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'visualz.midi.macroSlots.v1',
      JSON.stringify([21, 22, 23, 24, 25, 26, 27, 28]),
    )
  })
  await bootWithFakeMidi(page)
  await expect(page.locator('.macro-slot-cc', { hasText: 'CC 21' })).toBeVisible()
  await expect(page.locator('.macro-slot-cc', { hasText: 'CC 28' })).toBeVisible()

  await page.getByRole('button', { name: 'Map controls…' }).click()
  for (let n = 21; n <= 28; n++) await cc(page, n, 10)
  // A completed 8-slot sequential pass ends itself (spec: auto-stop after the
  // last slot) — "Map controls…" is back, not "Stop mapping".
  await expect(page.getByRole('button', { name: 'Map controls…' })).toBeVisible()

  // All 8 slots still show their (unchanged, since it's the same CCs) rows.
  // Scoped to the Controls 1-8 block — Frame notes / FX notes render their
  // own `.macro-slot-cc` rows in the same disclosure now.
  const controlsBlock = page.locator('.macro-controls', { has: page.locator('h3', { hasText: 'Controls 1-8' }) })
  const slotCcs = await controlsBlock.locator('.macro-slot-cc').allTextContents()
  expect(slotCcs).toEqual(['CC 21', 'CC 22', 'CC 23', 'CC 24', 'CC 25', 'CC 26', 'CC 27', 'CC 28'])

  // And the mapping actually drives params: slot 1 (CC 21) engages the
  // current scene's first param.
  const param0 = await page.evaluate(() => window.__vizLive!.sceneParams()[0])
  await cc(page, 21, 127)
  await expect.poll(() => getParam(page, param0.name)).toBeCloseTo(param0.max, 1)
})

/**
 * Note -> Frame (task): a learned note fires the same `applyFrame` path a
 * frame button's own click does — pressing the stored PERFORM value while
 * the param is elsewhere, learning a note for F1, then playing that note
 * jumps the param straight back to the stored value.
 */
test('learning a note for F1 makes that note jump the stored frame', async ({ page }) => {
  await bootWithFakeMidi(page)
  const param0 = await page.evaluate(() => window.__vizLive!.sceneParams()[0])

  // Store the current (default) position into F1 from the PERFORM tab.
  await page.locator('.panel-tabs button', { hasText: 'PERFORM' }).click()
  await page.getByRole('button', { name: 'Store' }).click()
  await page.getByRole('button', { name: 'F1', exact: true }).click()

  // Move the param away, back in INPUTS, learn note 60 (C4) for F1.
  await page.evaluate((n) => window.__vizLive!.setParam(n, 0), param0.name)
  await page.locator('.panel-tabs button', { hasText: 'INPUTS' }).click()
  await page.getByRole('button', { name: 'Map frames…' }).click()
  await noteOn(page, 60)
  // A single-slot sweep leaves the pass armed at slot 2 (only 8-of-8 auto-
  // stops) — end it explicitly.
  await page.getByRole('button', { name: /Stop mapping/ }).click()
  await expect(page.locator('.macro-slot-cc', { hasText: 'C4' })).toBeVisible()

  // Move the param away again, THEN play the learned note.
  await page.evaluate((n) => window.__vizLive!.setParam(n, 0), param0.name)
  expect(await getParam(page, param0.name)).toBeCloseTo(0, 4)
  await noteOn(page, 60)
  await expect.poll(() => getParam(page, param0.name)).toBeCloseTo(param0.default, 2)
})

/**
 * Note -> FX toggle (task): per-row Learn arms a note for one pass's
 * `enabled` flag, mirroring the FX tab's own checkbox path
 * (`engine.setFxParam(passId, 'enabled', …)`) — first press turns it on,
 * second press turns it off.
 */
test('learning a note for an FX pass toggles it on then off', async ({ page }) => {
  await bootWithFakeMidi(page)
  const kaleidoRow = page.locator('.macro-slot', { hasText: 'Kaleido' })
  await kaleidoRow.getByRole('button', { name: 'Learn' }).click()
  await noteOn(page, 64) // E4
  await expect(kaleidoRow.locator('.macro-slot-cc')).toHaveText('E4')

  expect(await getFxParam(page, 'kaleido', 'enabled')).toBe(0)
  await noteOn(page, 64)
  await expect.poll(() => getFxParam(page, 'kaleido', 'enabled')).toBe(1)
  await noteOn(page, 64)
  await expect.poll(() => getFxParam(page, 'kaleido', 'enabled')).toBe(0)
})

/**
 * Re-learn over a populated table (task: "re-learn over an existing table
 * must work — apply the same pass-scoped dedup rule as the CC learn fix").
 * Seeds F1<-note 40 via localStorage, then a fresh sequential "Map frames…"
 * sweep over the SAME note for F1 must still complete (not deadlock on the
 * "already mapped" guard) and land the table unchanged.
 */
test('sequential frame-note re-learn remaps over a pre-populated table', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('visualz.midi.frameNotes.v1', JSON.stringify([40, null, null, null, null, null, null, null]))
  })
  await bootWithFakeMidi(page)
  await expect(page.locator('.macro-slot-cc', { hasText: 'E2' })).toBeVisible() // midiNoteName(40) === 'E2'

  await page.getByRole('button', { name: 'Map frames…' }).click()
  await noteOn(page, 40) // re-claims slot 1 with the SAME note it already held
  await page.getByRole('button', { name: /Stop mapping/ }).click()
  await expect(page.locator('.macro-slot-cc', { hasText: 'E2' })).toBeVisible()
})

/** A note claims at most one target across BOTH tables: learning it for an
 * FX pass after it was already a Frame note steals it away from the frame. */
test('learning a note already mapped to a frame steals it for the FX pass', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('visualz.midi.frameNotes.v1', JSON.stringify([60, null, null, null, null, null, null, null]))
  })
  await bootWithFakeMidi(page)
  await expect(page.locator('.macro-slot-cc', { hasText: 'C4' })).toBeVisible()

  const mirrorRow = page.locator('.macro-slot', { hasText: 'Mirror' })
  await mirrorRow.getByRole('button', { name: 'Learn' }).click()
  await noteOn(page, 60)
  await expect(mirrorRow.locator('.macro-slot-cc')).toHaveText('C4')
  // F1's row no longer shows it.
  const f1Row = page.locator('.macro-slot', { hasText: 'F1' }).first()
  await expect(f1Row.locator('.macro-slot-cc')).toHaveText('—')
})

test('"Clear mapping" resets all 8 slots, and the reset itself persists across a reload', async ({ page }) => {
  await bootWithFakeMidi(page)

  await page.getByRole('button', { name: 'Map controls…' }).click()
  await cc(page, 50, 10)
  await page.getByRole('button', { name: /Stop mapping/ }).click()
  await expect(page.getByText('CC 50')).toBeVisible()

  // Scoped to the Controls 1-8 block — Frame notes / FX notes have their own
  // "Clear mapping" button in the same disclosure now.
  const controlsBlock = page.locator('.macro-controls', { has: page.locator('h3', { hasText: 'Controls 1-8' }) })
  await controlsBlock.getByRole('button', { name: 'Clear mapping' }).click()
  await expect(page.getByText('CC 50')).toHaveCount(0)

  await page.reload()
  await page.locator('.panel-tabs button', { hasText: 'INPUTS' }).click()
  await page.getByRole('button', { name: 'MIDI' }).click()
  await expect(page.getByText('CC 50')).toHaveCount(0)
})
