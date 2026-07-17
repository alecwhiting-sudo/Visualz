/**
 * localStorage persistence for the MIDI hardware setup (user report:
 * "mapped all 8 controls, then knobs went dead" — root cause: a page reload
 * wipes the session-scoped `macroCcBySlot` table; the mapping code path
 * itself was already sound). REQUIREMENTS.md §6 calls for mappings
 * persisting locally — this supersedes the earlier "session-scoped only"
 * decision for the CC->slot table and per-device active flags specifically
 * (docs/MACROS.md §7's "storing hardware mappings in session docs" is a
 * different thing and stays out of scope: this persists to localStorage,
 * never into a `SessionDoc`, so export/replay determinism is untouched).
 *
 * Parsing/validation is kept pure and dependency-free (no `localStorage`
 * reference here at all) so it's cheaply unit-testable; the actual
 * reads/writes live in tiny try/catch wrappers in App.tsx (localStorage can
 * throw — quota, private-browsing Safari — and a storage hiccup must never
 * crash the app).
 */

import { MACRO_SLOT_COUNT } from '../engine/macroRouter'

export const MACRO_CC_STORAGE_KEY = 'visualz.midi.macroSlots.v1'
export const DEVICE_ACTIVE_STORAGE_KEY = 'visualz.midi.deviceActive.v1'

/** An all-null table of the correct length — both the default and the
 * fallback for anything malformed. */
export function blankMacroCcBySlot(): (number | null)[] {
  return new Array(MACRO_SLOT_COUNT).fill(null)
}

/**
 * Parses a stored `macroCcBySlot` JSON string. Returns `blankMacroCcBySlot()`
 * for anything malformed (wrong length, wrong element types, non-JSON,
 * absent) rather than throwing — a corrupt or foreign value under this key
 * must never crash the app on boot.
 */
export function parseMacroCcBySlot(raw: string | null): (number | null)[] {
  if (!raw) return blankMacroCcBySlot()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length !== MACRO_SLOT_COUNT) return blankMacroCcBySlot()
    if (!parsed.every((v) => v === null || (typeof v === 'number' && Number.isFinite(v)))) return blankMacroCcBySlot()
    return parsed as (number | null)[]
  } catch {
    return blankMacroCcBySlot()
  }
}

/**
 * Parses a stored device-active-flags JSON string (Web MIDI port id ->
 * active). Returns `{}` for anything malformed; non-boolean entries are
 * dropped individually rather than invalidating the whole map.
 */
export function parseDeviceActiveMap(raw: string | null): Record<string, boolean> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'boolean') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}
