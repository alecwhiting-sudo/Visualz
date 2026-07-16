import { describe, expect, it } from 'vitest'
import { decodeMidiMessage } from '../../src/mapping/midi'
import { SessionRecorder, type SessionSnapshot } from '../../src/session/recorder'
import { serializeSession, parseSession } from '../../src/session/serialize'

// --- 1. decodeMidiMessage: the pure decode core ------------------------------

describe('decodeMidiMessage', () => {
  it('1) decodes a CC message (0xB0), normalizing channel out of the low nibble', () => {
    expect(decodeMidiMessage(new Uint8Array([0xb3, 74, 100]))).toEqual({
      kind: 'cc',
      channel: 3,
      num: 74,
      value: 100,
    })
  })

  it('2) CC channel 0 decodes correctly (nibble 0x0)', () => {
    expect(decodeMidiMessage(new Uint8Array([0xb0, 7, 0]))).toEqual({
      kind: 'cc',
      channel: 0,
      num: 7,
      value: 0,
    })
  })

  it('3) CC channel 15 decodes correctly (nibble 0xf)', () => {
    expect(decodeMidiMessage(new Uint8Array([0xbf, 1, 127]))).toEqual({
      kind: 'cc',
      channel: 15,
      num: 1,
      value: 127,
    })
  })

  it('4) decodes a note-on (0x90) with velocity > 0', () => {
    expect(decodeMidiMessage(new Uint8Array([0x91, 60, 100]))).toEqual({
      kind: 'noteon',
      channel: 1,
      num: 60,
      velocity: 100,
    })
  })

  it('5) folds a note-on with velocity 0 into note-off (universal MIDI convention)', () => {
    expect(decodeMidiMessage(new Uint8Array([0x90, 60, 0]))).toEqual({
      kind: 'noteoff',
      channel: 0,
      num: 60,
    })
  })

  it('6) decodes a real note-off (0x80) regardless of its velocity byte', () => {
    expect(decodeMidiMessage(new Uint8Array([0x82, 60, 64]))).toEqual({
      kind: 'noteoff',
      channel: 2,
      num: 60,
    })
  })

  it('7) ignores clock (0xF8)', () => {
    expect(decodeMidiMessage(new Uint8Array([0xf8]))).toEqual({ kind: 'ignored' })
  })

  it('8) ignores pitchbend (0xE0)', () => {
    expect(decodeMidiMessage(new Uint8Array([0xe0, 0, 64]))).toEqual({ kind: 'ignored' })
  })

  it('9) ignores polyphonic aftertouch (0xA0)', () => {
    expect(decodeMidiMessage(new Uint8Array([0xa0, 60, 50]))).toEqual({ kind: 'ignored' })
  })

  it('10) ignores channel aftertouch (0xD0)', () => {
    expect(decodeMidiMessage(new Uint8Array([0xd0, 50]))).toEqual({ kind: 'ignored' })
  })

  it('11) ignores program change (0xC0)', () => {
    expect(decodeMidiMessage(new Uint8Array([0xc0, 5]))).toEqual({ kind: 'ignored' })
  })

  it('12) ignores a message with no status byte at all', () => {
    expect(decodeMidiMessage(new Uint8Array([]))).toEqual({ kind: 'ignored' })
  })

  it('13) ignores a stray data byte (< 0x80) with no status byte', () => {
    expect(decodeMidiMessage(new Uint8Array([64, 100]))).toEqual({ kind: 'ignored' })
  })

  it('14) missing trailing data bytes default to 0 (a short CC reads value 0)', () => {
    expect(decodeMidiMessage(new Uint8Array([0xb0, 7]))).toEqual({
      kind: 'cc',
      channel: 0,
      num: 7,
      value: 0,
    })
  })
})

// --- 2. session round-trip for a MIDI-shaped inputSignal --------------------
// The generic inputSignal replay path is already heavily tested (session.test.ts,
// mirrored here) — this just proves a `midi.cc.<n>`-named signal isn't special-
// cased anywhere and rides the exact same recorder -> serialize -> parse path
// pad.x/pad.y already cover.

describe('midi.cc.<n> inputSignal round-trips through a recorded session', () => {
  function baseSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
    return {
      seed: 42,
      fps: 30,
      sceneId: 'lissajous',
      params: { freqX: 3, freqY: 2 },
      bindings: {},
      ...overrides,
    }
  }

  it('15) recordInputSignal captures a midi.cc.7 event, and it survives a serialize/parse round-trip', () => {
    const recorder = new SessionRecorder(baseSnapshot())
    recorder.recordInputSignal(12, 'midi.cc.7', 0.7874015748031497) // 100/127
    const doc = recorder.finish(20)
    expect(doc.events).toEqual([{ frame: 12, type: 'inputSignal', name: 'midi.cc.7', value: 0.7874015748031497 }])

    const roundTripped = parseSession(serializeSession(doc))
    expect(roundTripped).toEqual(doc)
    expect(roundTripped.events[0]).toEqual({
      frame: 12,
      type: 'inputSignal',
      name: 'midi.cc.7',
      value: 0.7874015748031497,
    })
  })

  it('16) a midi.note.<n> event round-trips the same way, alongside its trigger input event', () => {
    const recorder = new SessionRecorder(baseSnapshot())
    recorder.recordInput(5, { type: 'trigger', index: 60 })
    recorder.recordInputSignal(5, 'midi.note.60', 100 / 127)
    const doc = recorder.finish(10)
    const roundTripped = parseSession(serializeSession(doc))
    expect(roundTripped.events).toEqual([
      { frame: 5, type: 'input', event: { type: 'trigger', index: 60 } },
      { frame: 5, type: 'inputSignal', name: 'midi.note.60', value: 100 / 127 },
    ])
  })
})
