import { describe, expect, it } from 'vitest'
import { blankMacroCcBySlot, parseDeviceActiveMap, parseMacroCcBySlot } from '../../src/app/midiPersistence'

describe('parseMacroCcBySlot', () => {
  it('returns a blank (all-null) table for null/absent input', () => {
    expect(parseMacroCcBySlot(null)).toEqual(blankMacroCcBySlot())
  })

  it('parses a valid stored table back out unchanged', () => {
    const stored = [21, null, 22, null, null, null, null, null]
    expect(parseMacroCcBySlot(JSON.stringify(stored))).toEqual(stored)
  })

  it('falls back to blank for malformed JSON', () => {
    expect(parseMacroCcBySlot('{not json')).toEqual(blankMacroCcBySlot())
  })

  it('falls back to blank for the wrong length', () => {
    expect(parseMacroCcBySlot(JSON.stringify([1, 2, 3]))).toEqual(blankMacroCcBySlot())
  })

  it('falls back to blank for non-array JSON', () => {
    expect(parseMacroCcBySlot(JSON.stringify({ a: 1 }))).toEqual(blankMacroCcBySlot())
  })

  it('falls back to blank if any element is neither a number nor null', () => {
    const bad = [1, 2, 3, 4, 5, 6, 7, 'not-a-number']
    expect(parseMacroCcBySlot(JSON.stringify(bad))).toEqual(blankMacroCcBySlot())
  })

  it('falls back to blank for NaN/Infinity entries', () => {
    const bad = [NaN, null, null, null, null, null, null, null]
    // JSON.stringify(NaN) -> "null", so build the string directly to exercise the guard.
    expect(parseMacroCcBySlot('[NaN,null,null,null,null,null,null,null]')).toEqual(blankMacroCcBySlot())
    expect(bad[0]).toBeNaN() // sanity on the fixture itself
  })
})

describe('parseDeviceActiveMap', () => {
  it('returns {} for null/absent input', () => {
    expect(parseDeviceActiveMap(null)).toEqual({})
  })

  it('parses a valid stored map back out unchanged', () => {
    const stored = { 'device-1': true, 'device-2': false }
    expect(parseDeviceActiveMap(JSON.stringify(stored))).toEqual(stored)
  })

  it('falls back to {} for malformed JSON', () => {
    expect(parseDeviceActiveMap('{not json')).toEqual({})
  })

  it('falls back to {} for a non-object (array/primitive) JSON value', () => {
    expect(parseDeviceActiveMap(JSON.stringify([1, 2, 3]))).toEqual({})
    expect(parseDeviceActiveMap(JSON.stringify('hello'))).toEqual({})
  })

  it('drops individual non-boolean entries rather than invalidating the whole map', () => {
    const raw = JSON.stringify({ 'device-1': true, 'device-2': 'yes', 'device-3': false })
    expect(parseDeviceActiveMap(raw)).toEqual({ 'device-1': true, 'device-3': false })
  })
})

import { isLaunchkeyMini, LAUNCHKEY_MACRO_CC } from '../../src/app/midiPersistence'
import { MACRO_SLOT_COUNT } from '../../src/engine/macroRouter'

describe('isLaunchkeyMini', () => {
  it('matches Launchkey Mini port name variants', () => {
    for (const n of ['Launchkey Mini MK3 MIDI', 'launchkey mini mk3 daw', 'MIDIIN2 (Launchkey Mini MK3 MIDI)', 'Launchkey  Mini']) {
      expect(isLaunchkeyMini(n)).toBe(true)
    }
  })
  it('does not match a full-size Launchkey or unrelated devices', () => {
    for (const n of ['Launchkey 49 MK3', 'Launchpad Mini', 'Faderfox EC4', 'MPK Mini', '']) {
      expect(isLaunchkeyMini(n)).toBe(false)
    }
  })
})

describe('LAUNCHKEY_MACRO_CC', () => {
  it('maps Controls 1..8 to CC 21..28', () => {
    expect(LAUNCHKEY_MACRO_CC).toEqual([21, 22, 23, 24, 25, 26, 27, 28])
    expect(LAUNCHKEY_MACRO_CC.length).toBe(MACRO_SLOT_COUNT)
  })
})
