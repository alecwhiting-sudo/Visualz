import { describe, expect, it } from 'vitest'
import { Transport } from '../../src/core/transport'

describe('Transport', () => {
  it('render mode advances by exact fixed timesteps', () => {
    const t = new Transport('render', 30)
    const frames = [t.step(), t.step(), t.step()]
    expect(frames.map((f) => f.frame)).toEqual([1, 2, 3])
    expect(frames[2].time).toBeCloseTo(3 / 30, 12)
    for (const f of frames) expect(f.dt).toBeCloseTo(1 / 30, 12)
  })

  it('two render transports produce identical timelines (determinism)', () => {
    const a = new Transport('render', 60)
    const b = new Transport('render', 60)
    for (let i = 0; i < 500; i++) {
      expect(a.step()).toEqual(b.step())
    }
  })

  it('live mode follows the external clock and never goes backwards in dt', () => {
    const t = new Transport('live')
    expect(t.advanceTo(0.5).dt).toBeCloseTo(0.5)
    expect(t.advanceTo(0.4).dt).toBe(0) // clock hiccup clamps, not negative dt
    expect(t.frame).toBe(2)
  })

  it('mode-mismatched calls throw', () => {
    expect(() => new Transport('live').step()).toThrow()
    expect(() => new Transport('render').advanceTo(1)).toThrow()
  })

  it('reset rewinds time and frame counter', () => {
    const t = new Transport('render', 30)
    t.step()
    t.step()
    t.reset()
    expect(t.time).toBe(0)
    expect(t.frame).toBe(0)
  })
})
