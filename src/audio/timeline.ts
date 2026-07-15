import type { FeatureTimeline } from './analysis'

/**
 * `FeatureTimeline` lookup + serialization (docs/ANALYSIS.md §§6-7). Pure and
 * seek-free: every method is a stateless function of `(timeline, time[, dt])` —
 * no cross-call state, so replay/seek/export never need to reset anything here.
 */

export interface TimelineSample {
  rms: number
  bass: number
  mid: number
  high: number
  /** 1 on the frame an onset falls in `(time-dt, time]`, else 0. */
  onset: number
  /** 1 on the frame a beat falls in `(time-dt, time]`, else 0. */
  beat: number
  /** 0→1 sawtooth, resets on each beat. */
  beatPhase: number
  onsetStrength: number
}

/**
 * Samples a `FeatureTimeline` at `time` (seconds since the timeline's origin).
 *
 * Bands (`rms`/`bass`/`mid`/`high`/`onsetStrength`) are linearly interpolated
 * between adjacent feature frames, clamped to the timeline's extent.
 *
 * `onset`/`beat` are exactly-once pulses over the half-open window
 * `(time-dt, time]`: an event fires on the first sample whose window contains
 * it and never again (docs/ANALYSIS.md §6). Two events landing in the same
 * `dt` still produce a single boolean pulse — the caller only learns "at least
 * one fired," matching docs/EVENTS.md's contract for `onset`/`beat`.
 *
 * CONTRACT: `dt` must be the true elapsed time since the caller's *previous*
 * `sampleTimeline` call at this timeline — i.e. exactly what `Transport`
 * hands scenes each frame. Passing an arbitrary/stale `dt` breaks the
 * exactly-once guarantee (events can double-fire or be skipped). `dt <= 0`
 * yields an empty window, so no pulse ever fires.
 */
export function sampleTimeline(tl: FeatureTimeline, time: number, dt: number): TimelineSample {
  return {
    rms: lerpBand(tl.rms, tl, time),
    bass: lerpBand(tl.bass, tl, time),
    mid: lerpBand(tl.mid, tl, time),
    high: lerpBand(tl.high, tl, time),
    onset: pulseFired(tl.onsets, time, dt),
    beat: pulseFired(tl.beats, time, dt),
    beatPhase: beatPhaseAt(tl.beats, time),
    onsetStrength: lerpBand(tl.onsetEnv, tl, time),
  }
}

function lerpBand(arr: Float32Array, tl: FeatureTimeline, time: number): number {
  if (tl.frames === 0) return 0
  const x = time / tl.hopSec
  const xc = Math.min(tl.frames - 1, Math.max(0, x))
  const i0 = Math.floor(xc)
  const i1 = Math.min(tl.frames - 1, i0 + 1)
  const frac = xc - i0
  const v0 = arr[i0]
  const v1 = arr[i1]
  return v0 + (v1 - v0) * frac
}

/** Count of ascending `events` (seconds) that are `<= t`, via binary search. */
function countLE(events: Float32Array, t: number): number {
  let lo = 0
  let hi = events.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (events[mid] <= t) lo = mid + 1
    else hi = mid
  }
  return lo
}

function pulseFired(events: Float32Array, time: number, dt: number): number {
  return countLE(events, time) > countLE(events, time - dt) ? 1 : 0
}

function beatPhaseAt(beats: Float32Array, time: number): number {
  const n = beats.length
  if (n === 0) return 0
  if (time < beats[0]) return 0
  if (time >= beats[n - 1]) return 1
  // Largest i with beats[i] <= time (i <= n-2, guaranteed by the guards above).
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (beats[mid] <= time) lo = mid
    else hi = mid - 1
  }
  const i0 = lo
  const i1 = i0 + 1
  return (time - beats[i0]) / (beats[i1] - beats[i0])
}

// --- §7 Serialization ---------------------------------------------------

export interface SerializedTimeline {
  version: 1
  sampleRate: number
  hopSec: number
  frames: number
  bpm: number
  rms: string
  bass: string
  mid: string
  high: string
  onsetEnv: string
  onsets: string
  beats: string
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_INDEX = (() => {
  const idx = new Map<string, number>()
  for (let i = 0; i < B64_CHARS.length; i++) idx.set(B64_CHARS[i], i)
  return idx
})()

/**
 * Manual base64 codec (no `Buffer`, no `btoa`/`atob`): the same code runs in
 * the browser and under vitest's node environment, and avoids the call-stack
 * risk of `String.fromCharCode(...bigArray)` on large per-frame arrays.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  const len = bytes.length
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < len ? bytes[i + 1] : 0
    const b2 = i + 2 < len ? bytes[i + 2] : 0
    const triple = (b0 << 16) | (b1 << 8) | b2
    out += B64_CHARS[(triple >> 18) & 0x3f]
    out += B64_CHARS[(triple >> 12) & 0x3f]
    out += i + 1 < len ? B64_CHARS[(triple >> 6) & 0x3f] : '='
    out += i + 2 < len ? B64_CHARS[triple & 0x3f] : '='
  }
  return out
}

function base64ToBytes(b64: string): Uint8Array {
  if (b64.length % 4 !== 0) throw new Error('base64 string length must be a multiple of 4')
  if (b64.length === 0) return new Uint8Array(0)
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  const byteLength = (b64.length / 4) * 3 - padding
  const bytes = new Uint8Array(byteLength)
  let p = 0
  for (let i = 0; i < b64.length; i += 4) {
    const c0 = charVal(b64[i])
    const c1 = charVal(b64[i + 1])
    const c2 = b64[i + 2] === '=' ? 0 : charVal(b64[i + 2])
    const c3 = b64[i + 3] === '=' ? 0 : charVal(b64[i + 3])
    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3
    if (p < byteLength) bytes[p++] = (triple >> 16) & 0xff
    if (p < byteLength) bytes[p++] = (triple >> 8) & 0xff
    if (p < byteLength) bytes[p++] = triple & 0xff
  }
  return bytes
}

function charVal(c: string): number {
  const v = B64_INDEX.get(c)
  if (v === undefined) throw new Error(`invalid base64 character: ${JSON.stringify(c)}`)
  return v
}

function float32ToBase64(arr: Float32Array): string {
  return bytesToBase64(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength))
}

export function serializeTimeline(tl: FeatureTimeline): SerializedTimeline {
  return {
    version: 1,
    sampleRate: tl.sampleRate,
    hopSec: tl.hopSec,
    frames: tl.frames,
    bpm: tl.bpm,
    rms: float32ToBase64(tl.rms),
    bass: float32ToBase64(tl.bass),
    mid: float32ToBase64(tl.mid),
    high: float32ToBase64(tl.high),
    onsetEnv: float32ToBase64(tl.onsetEnv),
    onsets: float32ToBase64(tl.onsets),
    beats: float32ToBase64(tl.beats),
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Decodes a base64 field to bytes, wrapping any decode error with the field name. */
function decodeField(raw: Record<string, unknown>, field: string): Uint8Array {
  const v = raw[field]
  if (typeof v !== 'string') throw new Error(`Timeline ${field} must be a base64 string`)
  let bytes: Uint8Array
  try {
    bytes = base64ToBytes(v)
  } catch (e) {
    throw new Error(`Timeline ${field} is not valid base64: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (bytes.byteLength % 4 !== 0) {
    throw new Error(`Timeline ${field} must decode to a whole number of float32s (got ${bytes.byteLength} bytes)`)
  }
  return bytes
}

function decodePerFrame(raw: Record<string, unknown>, field: string, frames: number): Float32Array {
  const bytes = decodeField(raw, field)
  const arr = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
  if (arr.length !== frames) {
    throw new Error(`Timeline ${field} must decode to exactly ${frames} frames (got ${arr.length})`)
  }
  return arr
}

function decodeEvents(raw: Record<string, unknown>, field: string): Float32Array {
  const bytes = decodeField(raw, field)
  const arr = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
  let prev = -Infinity
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) throw new Error(`Timeline ${field}[${i}] must be finite`)
    if (arr[i] < prev) throw new Error(`Timeline ${field} must be ascending (index ${i})`)
    prev = arr[i]
  }
  return arr
}

/**
 * Validates and decodes a serialized timeline (mirrors session/serialize.ts's
 * style: descriptive `Error`s, thorough validation since this crosses a trust
 * boundary — a hand-edited or corrupted session file). Raw byte copies mean
 * `parseTimeline(serializeTimeline(tl))` round-trips bit-exact.
 */
export function parseTimeline(raw: unknown): FeatureTimeline {
  if (!isRecord(raw)) throw new Error('Timeline must be a JSON object')
  if (raw.version !== 1) {
    throw new Error(`Unsupported timeline version: ${JSON.stringify(raw.version)} (expected 1)`)
  }
  if (!isFiniteNumber(raw.sampleRate) || raw.sampleRate <= 0) {
    throw new Error('Timeline sampleRate must be a positive finite number')
  }
  if (!isFiniteNumber(raw.hopSec) || raw.hopSec <= 0) {
    throw new Error('Timeline hopSec must be a positive finite number')
  }
  if (!Number.isInteger(raw.frames) || (raw.frames as number) < 0) {
    throw new Error('Timeline frames must be a non-negative integer')
  }
  if (!isFiniteNumber(raw.bpm)) {
    throw new Error('Timeline bpm must be a finite number')
  }
  const frames = raw.frames as number

  const rms = decodePerFrame(raw, 'rms', frames)
  const bass = decodePerFrame(raw, 'bass', frames)
  const mid = decodePerFrame(raw, 'mid', frames)
  const high = decodePerFrame(raw, 'high', frames)
  const onsetEnv = decodePerFrame(raw, 'onsetEnv', frames)
  const onsets = decodeEvents(raw, 'onsets')
  const beats = decodeEvents(raw, 'beats')

  return {
    version: 1,
    sampleRate: raw.sampleRate as number,
    hopSec: raw.hopSec as number,
    frames,
    rms,
    bass,
    mid,
    high,
    onsetEnv,
    onsets,
    beats,
    bpm: raw.bpm as number,
  }
}
