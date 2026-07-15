import { describe, expect, it } from 'vitest'
import { SignalBus } from '../../src/core/signals'
import { publishDemoSignals } from '../../src/audio/engine'

describe('SignalBus', () => {
  it('stores, reads, and falls back', () => {
    const bus = new SignalBus()
    bus.set('bass', 0.7)
    expect(bus.get('bass')).toBe(0.7)
    expect(bus.get('missing')).toBe(0)
    expect(bus.get('missing', 0.5)).toBe(0.5)
  })

  it('snapshot is a detached copy', () => {
    const bus = new SignalBus()
    bus.set('rms', 0.3)
    const snap = bus.snapshot()
    bus.set('rms', 0.9)
    expect(snap.rms).toBe(0.3)
  })
})

describe('publishDemoSignals', () => {
  it('is a pure function of time (replayable)', () => {
    const a = new SignalBus()
    const b = new SignalBus()
    publishDemoSignals(a, 1.2345)
    publishDemoSignals(b, 1.2345)
    expect(a.snapshot()).toEqual(b.snapshot())
  })

  it('publishes the core audio signal names in [0, 1]', () => {
    const bus = new SignalBus()
    for (let t = 0; t < 5; t += 0.01) {
      publishDemoSignals(bus, t)
      for (const name of ['rms', 'bass', 'mid', 'high']) {
        const v = bus.get(name)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
    }
  })
})
