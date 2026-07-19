import { describe, expect, it } from 'vitest'
import { SessionRecorder } from '../../src/session/recorder'

describe('finish() data-loss guard (user lost a 6-minute take to a stalled transport)', () => {
  it('recovers duration from the last event when the frame counter stalled at the start frame', () => {
    const rec = new SessionRecorder({ seed: 1, fps: 60, sceneId: 'lissajous', params: {}, bindings: {} }, 500)
    rec.recordParam(500, 'freqX', 5) // relative frame 0 — the stall pins everything here...
    rec.recordParam(500, 'freqX', 9)
    // ...but ANY recorded event means the take is not empty. Duration =
    // last event frame + 1s tail, never 0.
    const doc = rec.finish(500)
    expect(doc.durationFrames).toBe(60)
    expect(doc.events).toHaveLength(2)
  })

  it('recovers from a stall that started mid-take (events beyond the final frame reading)', () => {
    const rec = new SessionRecorder({ seed: 1, fps: 60, sceneId: 'lissajous', params: {}, bindings: {} }, 100)
    rec.recordParam(400, 'freqX', 5) // relative frame 300, recorded before the counter rewound
    const doc = rec.finish(100) // transport read back at the start frame
    expect(doc.durationFrames).toBe(360) // 300 + 60-frame tail
  })

  it('a take with no events and no frames is still genuinely empty (0)', () => {
    const rec = new SessionRecorder({ seed: 1, fps: 60, sceneId: 'lissajous', params: {}, bindings: {} }, 500)
    expect(rec.finish(500).durationFrames).toBe(0)
  })

  it('healthy takes are untouched: frame-based duration wins when the transport advanced', () => {
    const rec = new SessionRecorder({ seed: 1, fps: 60, sceneId: 'lissajous', params: {}, bindings: {} }, 100)
    rec.recordParam(150, 'freqX', 5)
    expect(rec.finish(700).durationFrames).toBe(600) // exactly transport-derived
  })
})
