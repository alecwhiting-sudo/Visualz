import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AudioEngine } from '../../src/audio/engine'

/**
 * AudioEngine's pause/resume/seek/stop transitions (the transport feature),
 * exercised against a fake Web Audio graph — vitest's `environment: 'node'`
 * (vitest.config.ts) has no real `AudioContext`, and playFile/decodeAudioData
 * work the same way regardless of what's actually decoding, so a fake with
 * the same shape drives the real state machine in `engine.ts` end to end
 * (this deliberately does NOT bypass private state via casts for the control
 * flow — only `startSourceAt`'s current node is peeked at, to simulate a
 * natural end-of-track, which nothing else in this module can trigger).
 */

const FAKE_DURATION = 30

type EndedHandler = (() => void) | null

class FakeSourceNode {
  buffer: unknown = null
  onended: EndedHandler = null
  private stopped = false
  connect(): void {}
  start(): void {}
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    // Real AudioBufferSourceNode.onended fires asynchronously after stop() —
    // a microtask is enough to exercise the stale-callback guard.
    queueMicrotask(() => this.onended?.())
  }
}

class FakeAnalyserNode {
  fftSize = 2048
  smoothingTimeConstant = 0.7
  frequencyBinCount = 1024
  connect(): void {}
  getByteFrequencyData(arr: Uint8Array): void {
    arr.fill(0)
  }
}

class FakeAudioContext {
  currentTime = 0
  state: 'running' | 'suspended' | 'closed' = 'running'
  sampleRate = 44100
  createAnalyser(): FakeAnalyserNode {
    return new FakeAnalyserNode()
  }
  createBufferSource(): FakeSourceNode {
    return new FakeSourceNode()
  }
  decodeAudioData(): Promise<unknown> {
    return Promise.resolve({
      duration: FAKE_DURATION,
      numberOfChannels: 1,
      sampleRate: 44100,
      length: 1,
      getChannelData: () => new Float32Array(1),
    })
  }
  resume(): Promise<void> {
    this.state = 'running'
    return Promise.resolve()
  }
}

const fakeFile = { name: 'fixture.wav', arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) } as unknown as File

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

let originalAudioContext: unknown

beforeEach(() => {
  originalAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext
  ;(globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext
})

afterEach(() => {
  ;(globalThis as { AudioContext?: unknown }).AudioContext = originalAudioContext
})

describe('AudioEngine transport', () => {
  it('loads a file playing from 0, with the right duration', async () => {
    const engine = new AudioEngine()
    await engine.playFile(fakeFile)
    expect(engine.hasFile).toBe(true)
    expect(engine.duration).toBe(FAKE_DURATION)
    expect(engine.isPlaying).toBe(true)
    expect(engine.isPaused).toBe(false)
    expect(engine.time).toBeCloseTo(0)
  })

  it('time advances with the context clock while playing', async () => {
    const engine = new AudioEngine()
    await engine.playFile(fakeFile)
    const ctx = (engine as unknown as { ctx: FakeAudioContext }).ctx
    ctx.currentTime = 4
    expect(engine.time).toBeCloseTo(4)
  })

  it('pause freezes time regardless of the context clock moving on', async () => {
    const engine = new AudioEngine()
    await engine.playFile(fakeFile)
    const ctx = (engine as unknown as { ctx: FakeAudioContext }).ctx
    ctx.currentTime = 3
    engine.pause()
    expect(engine.isPlaying).toBe(false)
    expect(engine.isPaused).toBe(true)
    expect(engine.time).toBeCloseTo(3)

    ctx.currentTime = 50 // wall/context time keeps moving; playback is paused
    expect(engine.time).toBeCloseTo(3)
    expect(engine.time).toBeCloseTo(3) // repeated reads: no discontinuity
  })

  it('resume continues from the paused position', async () => {
    const engine = new AudioEngine()
    await engine.playFile(fakeFile)
    const ctx = (engine as unknown as { ctx: FakeAudioContext }).ctx
    ctx.currentTime = 3
    engine.pause()
    ctx.currentTime = 10 // time passes while paused
    engine.resume()
    expect(engine.isPlaying).toBe(true)
    expect(engine.isPaused).toBe(false)
    expect(engine.time).toBeCloseTo(3) // resumes right where it paused

    ctx.currentTime = 12
    expect(engine.time).toBeCloseTo(5) // 3 + (12 - 10)
  })

  it('seek while playing restarts at the new offset and keeps playing', async () => {
    const engine = new AudioEngine()
    await engine.playFile(fakeFile)
    const ctx = (engine as unknown as { ctx: FakeAudioContext }).ctx
    ctx.currentTime = 2
    engine.seek(15)
    expect(engine.isPlaying).toBe(true)
    expect(engine.time).toBeCloseTo(15)

    ctx.currentTime = 5
    expect(engine.time).toBeCloseTo(18) // 15 + (5 - 2)
  })

  it('seek while paused just moves the held position', async () => {
    const engine = new AudioEngine()
    await engine.playFile(fakeFile)
    engine.pause()
    engine.seek(20)
    expect(engine.isPaused).toBe(true)
    expect(engine.time).toBeCloseTo(20)
  })

  it('seek clamps to [0, duration]', async () => {
    const engine = new AudioEngine()
    await engine.playFile(fakeFile)
    engine.pause()
    engine.seek(-5)
    expect(engine.time).toBe(0)
    engine.seek(FAKE_DURATION + 100)
    expect(engine.time).toBe(FAKE_DURATION)
  })

  it('stop rewinds to 0 and clears playing/paused', async () => {
    const engine = new AudioEngine()
    await engine.playFile(fakeFile)
    engine.pause()
    engine.seek(12)
    engine.stop()
    expect(engine.isPlaying).toBe(false)
    expect(engine.isPaused).toBe(false)
    expect(engine.time).toBe(0)
    expect(engine.hasFile).toBe(true) // stop rewinds; it doesn't unload the file
  })

  it('pause/resume/seek are no-ops with no file loaded', () => {
    const engine = new AudioEngine()
    engine.pause()
    engine.resume()
    engine.seek(5)
    expect(engine.hasFile).toBe(false)
    expect(engine.isPlaying).toBe(false)
    expect(engine.isPaused).toBe(false)
    expect(engine.time).toBe(0)
  })

  it('CRITICAL: a stale onended from a pause-killed source does not clear playback state', async () => {
    const engine = new AudioEngine()
    await engine.playFile(fakeFile)
    const ctx = (engine as unknown as { ctx: FakeAudioContext }).ctx
    ctx.currentTime = 6
    engine.pause() // stops the old source; its onended is now pending
    await flush() // let the stale onended actually fire

    // If the guard failed, this stale callback would have reset paused=false
    // and offsetSeconds=0 — asserting the opposite proves it didn't.
    expect(engine.isPaused).toBe(true)
    expect(engine.isPlaying).toBe(false)
    expect(engine.time).toBeCloseTo(6)
  })

  it('CRITICAL: a stale onended from a seek-killed source does not clear playback state', async () => {
    const engine = new AudioEngine()
    await engine.playFile(fakeFile)
    engine.seek(9) // while playing: kills the old source, starts a new one
    await flush()

    expect(engine.isPlaying).toBe(true)
    expect(engine.time).toBeCloseTo(9)
  })

  it('a genuine natural end (no pause/seek/stop in between) clears playback state', async () => {
    const engine = new AudioEngine()
    await engine.playFile(fakeFile)
    const node = (engine as unknown as { source: FakeSourceNode }).source
    // Simulate the track finishing on its own — nothing else touched `source`
    // in between, so this is a real natural end, not a stale callback.
    node.onended?.()

    expect(engine.isPlaying).toBe(false)
    expect(engine.isPaused).toBe(false)
    expect(engine.time).toBe(0)
    expect(engine.hasFile).toBe(true) // the file itself stays loaded
  })
})
