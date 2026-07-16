import { describe, expect, it } from 'vitest'
import { SessionRecorder, type SessionSnapshot } from '../../src/session/recorder'
import { SessionPlayer, type PlayerTarget } from '../../src/session/player'
import { serializeSession, parseSession } from '../../src/session/serialize'
import type { SessionDoc, SessionEvent } from '../../src/session/types'
import type { SourceEvent } from '../../src/mapping/types'

// --- Test harness ------------------------------------------------------------

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

function docWithEvents(events: SessionEvent[], overrides: Partial<SessionDoc> = {}): SessionDoc {
  return {
    version: 1,
    seed: 42,
    fps: 30,
    scene: { id: 'lissajous', params: { freqX: 3, freqY: 2 } },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames: 10,
    events,
    ...overrides,
  }
}

/** A fake PlayerTarget recording every call it receives, for order/dedup assertions. */
function fakeTarget() {
  const calls: Array<{ fn: string; args: unknown[] }> = []
  const target: PlayerTarget = {
    queueInput: (e) => calls.push({ fn: 'queueInput', args: [e] }),
    setInputSignal: (name, value) => calls.push({ fn: 'setInputSignal', args: [name, value] }),
    setParam: (name, value) => calls.push({ fn: 'setParam', args: [name, value] }),
    setBinding: (param, src) => calls.push({ fn: 'setBinding', args: [param, src] }),
    clearBinding: (param) => calls.push({ fn: 'clearBinding', args: [param] }),
    setShaderSource: (key, source) => calls.push({ fn: 'setShaderSource', args: [key, source] }),
  }
  return { target, calls }
}

// --- 1. SessionRecorder --------------------------------------------------------

describe('SessionRecorder', () => {
  it('1) finish() captures the initial snapshot into the doc', () => {
    const recorder = new SessionRecorder(
      baseSnapshot({ bindings: { drift: 'sin(t)' } }),
    )
    const doc = recorder.finish(0)
    expect(doc.version).toBe(1)
    expect(doc.seed).toBe(42)
    expect(doc.fps).toBe(30)
    expect(doc.scene).toEqual({ id: 'lissajous', params: { freqX: 3, freqY: 2 } })
    expect(doc.bindings).toEqual({ drift: 'sin(t)' })
    expect(doc.audio).toEqual({ kind: 'demo' })
    expect(doc.events).toEqual([])
  })

  it('2) recordInput/recordInputSignal/recordParam/recordBinding stamp events with the given frame', () => {
    const recorder = new SessionRecorder(baseSnapshot())
    recorder.recordInput(5, { type: 'trigger', index: 1 })
    recorder.recordInputSignal(6, 'pad.x', 0.5)
    recorder.recordParam(7, 'freqX', 4)
    recorder.recordBinding(8, 'drift', 'bass')
    recorder.recordBinding(9, 'drift', null)
    const doc = recorder.finish(10)
    expect(doc.events).toEqual([
      { frame: 5, type: 'input', event: { type: 'trigger', index: 1 } },
      { frame: 6, type: 'inputSignal', name: 'pad.x', value: 0.5 },
      { frame: 7, type: 'param', name: 'freqX', value: 4 },
      { frame: 8, type: 'binding', param: 'drift', src: 'bass' },
      { frame: 9, type: 'binding', param: 'drift', src: null },
    ])
  })

  it('3) finish() sets durationFrames to the frame passed in', () => {
    const recorder = new SessionRecorder(baseSnapshot())
    expect(recorder.finish(0).durationFrames).toBe(0)
    expect(new SessionRecorder(baseSnapshot()).finish(120).durationFrames).toBe(120)
  })

  it('4) preserves recording order across mixed event kinds', () => {
    const recorder = new SessionRecorder(baseSnapshot())
    recorder.recordParam(1, 'a', 1)
    recorder.recordInput(1, { type: 'key', key: 'x', edge: 'down' })
    recorder.recordInputSignal(2, 'pad.y', 0.1)
    const doc = recorder.finish(3)
    expect(doc.events.map((e) => e.type)).toEqual(['param', 'input', 'inputSignal'])
  })

  it('4b) recordShader stamps a shader event with the given frame/key/source', () => {
    const recorder = new SessionRecorder(baseSnapshot())
    recorder.recordShader(4, 'line-fs', 'void main() {}')
    const doc = recorder.finish(5)
    expect(doc.events).toEqual([{ frame: 4, type: 'shader', key: 'line-fs', source: 'void main() {}' }])
  })

  it('4c) scene.shaders is omitted (not even {}) when the snapshot has none', () => {
    const doc = new SessionRecorder(baseSnapshot()).finish(0)
    expect(doc.scene).toEqual({ id: 'lissajous', params: { freqX: 3, freqY: 2 } })
    expect('shaders' in doc.scene).toBe(false)
  })

  it('4d) scene.shaders carries the snapshot sources when provided', () => {
    const doc = new SessionRecorder(
      baseSnapshot({ shaders: { 'line-fs': 'A', 'fade-fs': 'B' } }),
    ).finish(0)
    expect(doc.scene.shaders).toEqual({ 'line-fs': 'A', 'fade-fs': 'B' })
  })
})

// --- 2. SessionPlayer -----------------------------------------------------------

describe('SessionPlayer', () => {
  it('5) applies events at or before the given frame, in recorded order', () => {
    const doc = docWithEvents([
      { frame: 0, type: 'param', name: 'a', value: 1 },
      { frame: 2, type: 'param', name: 'a', value: 2 },
      { frame: 2, type: 'param', name: 'a', value: 3 },
    ])
    const player = new SessionPlayer(doc)
    const { target, calls } = fakeTarget()
    player.applyUpTo(2, target)
    expect(calls).toEqual([
      { fn: 'setParam', args: ['a', 1] },
      { fn: 'setParam', args: ['a', 2] },
      { fn: 'setParam', args: ['a', 3] },
    ])
  })

  it('6) events at frame 5 are not applied when applyUpTo(4)', () => {
    const doc = docWithEvents([{ frame: 5, type: 'param', name: 'a', value: 1 }])
    const player = new SessionPlayer(doc)
    const { target, calls } = fakeTarget()
    player.applyUpTo(4, target)
    expect(calls).toEqual([])
    player.applyUpTo(5, target)
    expect(calls).toEqual([{ fn: 'setParam', args: ['a', 1] }])
  })

  it('7) never re-applies an already-applied event across repeated applyUpTo calls', () => {
    const doc = docWithEvents([{ frame: 1, type: 'param', name: 'a', value: 1 }])
    const player = new SessionPlayer(doc)
    const { target, calls } = fakeTarget()
    player.applyUpTo(1, target)
    player.applyUpTo(5, target)
    player.applyUpTo(10, target)
    expect(calls).toEqual([{ fn: 'setParam', args: ['a', 1] }])
  })

  it('8) events recorded at frame 0 apply on the very first applyUpTo(0) call, before any step', () => {
    const doc = docWithEvents([{ frame: 0, type: 'inputSignal', name: 'pad.x', value: 0.5 }])
    const player = new SessionPlayer(doc)
    const { target, calls } = fakeTarget()
    player.applyUpTo(0, target)
    expect(calls).toEqual([{ fn: 'setInputSignal', args: ['pad.x', 0.5] }])
  })

  it('9) done is false until every event has been applied, then true', () => {
    const doc = docWithEvents([
      { frame: 0, type: 'param', name: 'a', value: 1 },
      { frame: 3, type: 'param', name: 'a', value: 2 },
    ])
    const player = new SessionPlayer(doc)
    const { target } = fakeTarget()
    expect(player.done).toBe(false)
    player.applyUpTo(0, target)
    expect(player.done).toBe(false)
    player.applyUpTo(3, target)
    expect(player.done).toBe(true)
  })

  it('10) an empty event log is done immediately', () => {
    const player = new SessionPlayer(docWithEvents([]))
    expect(player.done).toBe(true)
  })

  it('11) routes each event kind to its matching target method, binding src:null routes to clearBinding', () => {
    const doc = docWithEvents([
      { frame: 0, type: 'input', event: { type: 'key', key: 'a', edge: 'down' } },
      { frame: 0, type: 'binding', param: 'drift', src: 'bass' },
      { frame: 0, type: 'binding', param: 'drift', src: null },
    ])
    const player = new SessionPlayer(doc)
    const { target, calls } = fakeTarget()
    player.applyUpTo(0, target)
    expect(calls).toEqual([
      { fn: 'queueInput', args: [{ type: 'key', key: 'a', edge: 'down' }] },
      { fn: 'setBinding', args: ['drift', 'bass'] },
      { fn: 'clearBinding', args: ['drift'] },
    ])
  })

  it('11b) routes a shader event to setShaderSource', () => {
    const doc = docWithEvents([{ frame: 0, type: 'shader', key: 'line-fs', source: 'void main() {}' }])
    const player = new SessionPlayer(doc)
    const { target, calls } = fakeTarget()
    player.applyUpTo(0, target)
    expect(calls).toEqual([{ fn: 'setShaderSource', args: ['line-fs', 'void main() {}'] }])
  })
})

// --- 3. serialize / parse -------------------------------------------------------

describe('serializeSession / parseSession round-trip', () => {
  it('12) parseSession(serializeSession(doc)) deep-equals the original doc', () => {
    const doc = docWithEvents([
      { frame: 0, type: 'input', event: { type: 'trigger', index: 2 } },
      { frame: 1, type: 'inputSignal', name: 'pad.x', value: 0.25 },
      { frame: 2, type: 'param', name: 'freqX', value: 5 },
      { frame: 3, type: 'binding', param: 'drift', src: '0.5 + bass' },
      { frame: 4, type: 'binding', param: 'drift', src: null },
    ])
    expect(parseSession(serializeSession(doc))).toEqual(doc)
  })

  it('12b) round-trips a shader event and scene.shaders', () => {
    const doc = docWithEvents(
      [{ frame: 0, type: 'shader', key: 'line-fs', source: 'void main() { outColor = vec4(1.0); }' }],
      { scene: { id: 'lissajous', params: { freqX: 3, freqY: 2 }, shaders: { 'line-fs': 'X', 'fade-fs': 'Y' } } },
    )
    expect(parseSession(serializeSession(doc))).toEqual(doc)
  })
})

describe('parseSession validation', () => {
  it('13) rejects wrong version', () => {
    const doc = { ...docWithEvents([]), version: 2 }
    expect(() => parseSession(JSON.stringify(doc))).toThrow(/version/i)
  })

  it('14) rejects non-array events', () => {
    const doc = { ...docWithEvents([]), events: { not: 'an array' } }
    expect(() => parseSession(JSON.stringify(doc))).toThrow(/events/i)
  })

  it('15) rejects descending frames', () => {
    const doc = docWithEvents([
      { frame: 3, type: 'param', name: 'a', value: 1 },
      { frame: 1, type: 'param', name: 'a', value: 2 },
    ])
    expect(() => parseSession(JSON.stringify(doc))).toThrow(/ascending/i)
  })

  it('16) rejects an unknown event type', () => {
    const doc = { ...docWithEvents([]), events: [{ frame: 0, type: 'bogus' }] }
    expect(() => parseSession(JSON.stringify(doc))).toThrow(/unknown event type/i)
  })

  it('17) rejects a non-finite seed', () => {
    const doc = { ...docWithEvents([]), seed: Number.NaN }
    expect(() => parseSession(JSON.stringify(doc))).toThrow(/seed/i)
  })

  it('18) rejects malformed JSON entirely', () => {
    expect(() => parseSession('{not json')).toThrow(/JSON/i)
  })

  it('18b) rejects a shader event with a non-string source', () => {
    const doc = { ...docWithEvents([]), events: [{ frame: 0, type: 'shader', key: 'line-fs', source: 123 }] }
    expect(() => parseSession(JSON.stringify(doc))).toThrow(/source/i)
  })

  it('18c) rejects a shader event with a non-string key', () => {
    const doc = { ...docWithEvents([]), events: [{ frame: 0, type: 'shader', key: 7, source: 'x' }] }
    expect(() => parseSession(JSON.stringify(doc))).toThrow(/key/i)
  })

  it('18d) rejects a shader event whose source exceeds the max length', () => {
    const doc = {
      ...docWithEvents([]),
      events: [{ frame: 0, type: 'shader', key: 'line-fs', source: 'x'.repeat(100_001) }],
    }
    expect(() => parseSession(JSON.stringify(doc))).toThrow(/exceeds max length/i)
  })

  it('18e) accepts a shader event within the max length', () => {
    const doc = {
      ...docWithEvents([]),
      events: [{ frame: 0, type: 'shader', key: 'line-fs', source: 'x'.repeat(100_000) }],
    }
    expect(() => parseSession(JSON.stringify(doc))).not.toThrow()
  })

  it('18f) rejects scene.shaders that is not an object', () => {
    const doc = {
      ...docWithEvents([]),
      scene: { id: 'lissajous', params: {}, shaders: 'not an object' },
    }
    expect(() => parseSession(JSON.stringify(doc))).toThrow(/scene\.shaders/i)
  })

  it('18g) rejects scene.shaders with a non-string value', () => {
    const doc = {
      ...docWithEvents([]),
      scene: { id: 'lissajous', params: {}, shaders: { 'line-fs': 42 } },
    }
    expect(() => parseSession(JSON.stringify(doc))).toThrow(/scene\.shaders\.line-fs/i)
  })

  it('18h) accepts a session with no scene.shaders at all (backward compatible)', () => {
    const doc = docWithEvents([])
    expect(() => parseSession(JSON.stringify(doc))).not.toThrow()
    expect(parseSession(JSON.stringify(doc)).scene.shaders).toBeUndefined()
  })
})

// --- scene.image validation (Photo Swarm task) ----------------------------

/** Base64 of `width*height*4` arbitrary bytes, for image-field fixtures. */
function imageBase64(width: number, height: number): string {
  const bytes = new Uint8Array(width * height * 4)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256
  return btoa(String.fromCharCode(...bytes))
}

describe('parseSession scene.image validation', () => {
  it('19a) accepts a session with no scene.image at all (backward compatible)', () => {
    const doc = docWithEvents([])
    expect(() => parseSession(JSON.stringify(doc))).not.toThrow()
    expect(parseSession(JSON.stringify(doc)).scene.image).toBeUndefined()
  })

  it('19b) accepts a well-formed scene.image and round-trips it exactly', () => {
    const doc = {
      ...docWithEvents([]),
      scene: { id: 'lissajous', params: {}, image: { width: 2, height: 3, data: imageBase64(2, 3) } },
    }
    const parsed = parseSession(JSON.stringify(doc))
    expect(parsed.scene.image).toEqual(doc.scene.image)
  })

  it('19c) rejects scene.image that is not an object', () => {
    const doc = { ...docWithEvents([]), scene: { id: 'lissajous', params: {}, image: 'nope' } }
    expect(() => parseSession(JSON.stringify(doc))).toThrow(/scene\.image/i)
  })

  it('19d) rejects a non-positive or non-integer width', () => {
    for (const width of [0, -1, 1.5]) {
      const doc = {
        ...docWithEvents([]),
        scene: { id: 'lissajous', params: {}, image: { width, height: 2, data: imageBase64(2, 2) } },
      }
      expect(() => parseSession(JSON.stringify(doc))).toThrow(/width/i)
    }
  })

  it('19e) rejects a non-positive or non-integer height', () => {
    for (const height of [0, -1, 2.5]) {
      const doc = {
        ...docWithEvents([]),
        scene: { id: 'lissajous', params: {}, image: { width: 2, height, data: imageBase64(2, 2) } },
      }
      expect(() => parseSession(JSON.stringify(doc))).toThrow(/height/i)
    }
  })

  it('19f) rejects width*height exceeding the 65536-pixel limit', () => {
    const doc = {
      ...docWithEvents([]),
      scene: { id: 'lissajous', params: {}, image: { width: 300, height: 300, data: '' } },
    }
    expect(() => parseSession(JSON.stringify(doc))).toThrow(/65536/)
  })

  it('19g) rejects non-string data', () => {
    const doc = {
      ...docWithEvents([]),
      scene: { id: 'lissajous', params: {}, image: { width: 2, height: 2, data: 42 } },
    }
    expect(() => parseSession(JSON.stringify(doc))).toThrow(/data/i)
  })

  it('19h) rejects data that is not valid base64', () => {
    const doc = {
      ...docWithEvents([]),
      scene: { id: 'lissajous', params: {}, image: { width: 2, height: 2, data: '!!!not base64!!!' } },
    }
    expect(() => parseSession(JSON.stringify(doc))).toThrow(/base64/i)
  })

  it('19i) rejects data whose decoded length does not match width*height*4', () => {
    const doc = {
      ...docWithEvents([]),
      scene: { id: 'lissajous', params: {}, image: { width: 4, height: 4, data: imageBase64(2, 2) } },
    }
    expect(() => parseSession(JSON.stringify(doc))).toThrow(/decodes to/i)
  })
})

// --- 4. End-to-end determinism (fake engine) ------------------------------------

describe('determinism (fake PlayerTarget end-to-end)', () => {
  it('19) driving a fake PlayerTarget twice from the same doc produces identical call logs', () => {
    const doc = docWithEvents(
      [
        { frame: 0, type: 'param', name: 'freqX', value: 3 },
        { frame: 0, type: 'input', event: { type: 'key', key: '4', edge: 'down' } },
        { frame: 2, type: 'input', event: { type: 'trigger', index: 1 } },
        { frame: 2, type: 'inputSignal', name: 'pad.x', value: 0.4 },
        { frame: 5, type: 'binding', param: 'drift', src: 'bass' },
        { frame: 5, type: 'binding', param: 'drift', src: null },
      ],
      { durationFrames: 5 },
    )

    const run = () => {
      const player = new SessionPlayer(doc)
      const { target, calls } = fakeTarget()
      // Mirrors Engine's "applyUpTo(current completed frame) before stepping" loop.
      for (let frame = 0; frame <= doc.durationFrames; frame++) {
        player.applyUpTo(frame, target)
      }
      expect(player.done).toBe(true)
      return calls
    }

    expect(run()).toEqual(run())
  })

  it('20) an unrecognized SourceEvent shape still round-trips opaquely through the player', () => {
    const event: SourceEvent = { type: 'key', key: ' ', edge: 'up' }
    const doc = docWithEvents([{ frame: 0, type: 'input', event }])
    const player = new SessionPlayer(doc)
    const { target, calls } = fakeTarget()
    player.applyUpTo(0, target)
    expect(calls).toEqual([{ fn: 'queueInput', args: [event] }])
  })
})
