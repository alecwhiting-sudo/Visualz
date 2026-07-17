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
  })

  it('advanceTo quantizes the frame counter to floor(time * fps), not a per-call tick', () => {
    const t = new Transport('live', 60)
    // 60fps: t=0.5s -> frame 30, regardless of how many advanceTo calls got there.
    expect(t.advanceTo(0.5).frame).toBe(30)
  })

  it('advanceTo frame counter is monotonic under a backward-moving clock (seek)', () => {
    const t = new Transport('live', 60)
    expect(t.advanceTo(1.0).frame).toBe(60)
    // Seek backward: dt clamps to 0 same as before, but the frame counter must
    // NOT rewind — downstream consumers (recorder, player cursor) key state off
    // frame monotonically increasing.
    const back = t.advanceTo(0.2)
    expect(back.dt).toBe(0)
    expect(back.frame).toBe(60)
    // Resuming forward past the pre-seek high-water mark advances normally again.
    expect(t.advanceTo(1.1).frame).toBe(66)
  })

  it('advanceTo can jump the frame counter by more than one on a slow tick', () => {
    const t = new Transport('live', 60)
    t.advanceTo(1 / 60)
    expect(t.advanceTo(4 / 60).frame).toBe(4)
  })

  it('two rAF ticks landing in the same fps bucket share one frame number', () => {
    const t = new Transport('live', 60)
    // Frame 1 spans [1/60, 2/60) = [0.0167, 0.0333) — both times land in it,
    // simulating two ticks on a 120Hz display within one nominal 60fps period.
    expect(t.advanceTo(0.02).frame).toBe(1)
    expect(t.advanceTo(0.024).frame).toBe(1)
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

  it('reset seeds the frame counter from a nonzero time (take-start baselining)', () => {
    const t = new Transport('live', 60)
    t.reset(2.5)
    expect(t.time).toBe(2.5)
    expect(t.frame).toBe(150) // round(2.5 * 60)

    // Immediately advancing to that same time should not double-count: the very
    // next advanceTo at the reset time itself stays at the seeded frame.
    expect(t.advanceTo(2.5).frame).toBe(150)
  })

  it('step()/advanceTo() agree on frame numbering for the same fps and elapsed time', () => {
    // Render mode's fixed-timestep step() and live mode's time-derived advanceTo()
    // must count frames the same way, so a session recorded live and replayed in
    // render mode numbers frames identically. Compared against `k/fps` computed
    // fresh by division for each `k` (not `render.step()`'s own accumulated `t`,
    // which drifts from repeated `+=` — an inherent float-accumulation artifact
    // unrelated to the frame-counting logic under test here).
    const render = new Transport('render', 60)
    for (let k = 1; k <= 100; k++) {
      const r = render.step()
      const live = new Transport('live', 60)
      expect(live.advanceTo(k / 60).frame).toBe(r.frame)
    }
  })
})
