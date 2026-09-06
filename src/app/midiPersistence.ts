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

// --- Launchkey Mini auto-map (user request) ----------------------------------

/** Whether a MIDI input port belongs to a Launchkey Mini. Ports report names
 * like "Launchkey Mini MK3 MIDI" / "Launchkey Mini MK3 DAW" — match both
 * "launchkey" and "mini" (case-insensitive) so it's specific to the Mini and
 * not, say, a full-size Launchkey. */
export function isLaunchkeyMini(name: string): boolean {
  return /launchkey/i.test(name) && /mini/i.test(name)
}

/** CC->slot table mapping Controls 1..8 to the Launchkey Mini's knobs CC21..28
 * (slot i, 0-based, <- CC 21+i). Length is MACRO_SLOT_COUNT. */
export const LAUNCHKEY_MACRO_CC: number[] = Array.from({ length: MACRO_SLOT_COUNT }, (_, i) => 21 + i)

// --- Note -> Frame / FX-toggle persistence -----------------------------------
// MIDI notes and mapped keys already fire the T1-T4 trigger pads (a note
// number IS a trigger index, per mapping/midi.ts); these two tables let a
// note ALSO jump a Frame (F1-F8) or toggle an FX pass's `enabled` flag,
// exactly mirroring the CC->slot table above (versioned localStorage keys,
// pure/unit-tested parsing, garbage-tolerant). A note can be claimed by at
// most one of {a frame slot, an FX pass} at a time — App.tsx's learn flow
// enforces that by clearing the note out of whichever table already held it
// before writing the new claim (same "learning steals it" behavior as the
// Controls 1-8 CC learn).

export const FRAME_NOTE_STORAGE_KEY = 'visualz.midi.frameNotes.v1'
export const FX_NOTE_STORAGE_KEY = 'visualz.midi.fxNotes.v1'

/** Fixed, ordered built-in FX pass ids (mirrors `buildFxPasses()`'s order in
 * `fx/chain.ts` — that order is a session/UI contract there, so it's safe to
 * duplicate literally here rather than import GPU-touching pass factories
 * into this dependency-free persistence module). */
export const FX_NOTE_PASS_IDS = ['kaleido', 'mirror', 'rgbshift', 'pixelate', 'posterize', 'zoompulse'] as const

/** An all-null table of the correct length — both the default and the
 * fallback for anything malformed. */
export function blankFrameNoteBySlot(): (number | null)[] {
  return new Array(MACRO_SLOT_COUNT).fill(null)
}

/** Parses a stored `frameNoteBySlot` JSON string, same tolerance rules as
 * `parseMacroCcBySlot`. */
export function parseFrameNoteBySlot(raw: string | null): (number | null)[] {
  if (!raw) return blankFrameNoteBySlot()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length !== MACRO_SLOT_COUNT) return blankFrameNoteBySlot()
    if (!parsed.every((v) => v === null || (typeof v === 'number' && Number.isFinite(v)))) return blankFrameNoteBySlot()
    return parsed as (number | null)[]
  } catch {
    return blankFrameNoteBySlot()
  }
}

/** An all-null map keyed by every known FX pass id — the default and the
 * fallback for anything malformed. */
export function blankFxNoteByPassId(): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  for (const id of FX_NOTE_PASS_IDS) out[id] = null
  return out
}

/**
 * Parses a stored `fxNoteByPassId` JSON string (FX pass id -> learned note,
 * or null). Unknown keys are dropped; a missing known pass id is filled in
 * as null rather than invalidating the whole map — garbage-tolerant like
 * every other table here.
 */
export function parseFxNoteByPassId(raw: string | null): Record<string, number | null> {
  if (!raw) return blankFxNoteByPassId()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return blankFxNoteByPassId()
    const out = blankFxNoteByPassId()
    for (const id of FX_NOTE_PASS_IDS) {
      const v = (parsed as Record<string, unknown>)[id]
      if (v === null || (typeof v === 'number' && Number.isFinite(v))) out[id] = v
    }
    return out
  } catch {
    return blankFxNoteByPassId()
  }
}

/** Human-readable MIDI note name (e.g. `36` -> `"C2"`), standard MIDI
 * convention (note 60 = C4/middle C, octave = floor(n/12) - 1). Falls back to
 * `"note N"` for out-of-range values so a garbage/foreign note number never
 * renders something nonsensical. */
export function midiNoteName(note: number): string {
  if (!Number.isInteger(note) || note < 0 || note > 127) return `note ${note}`
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const octave = Math.floor(note / 12) - 1
  return `${NAMES[note % 12]}${octave}`
}
