import { describe, expect, it } from 'vitest'
import { Transport, framesToCatchUp } from '../../src/core/transport'

/**
 * Drives a live-mode Transport through the engine's fixed-timestep catch-up
 * loop (framesToCatchUp + stepLive) for a given sequence of rAF clock samples,
 * returning the total number of update() steps run (== the final frame). This
 * is the exact shape of Engine.advanceLiveTo, minus the scene work.
 */
function simulateLive(rafClockTimes: number[], fps: number, cap = 30): { updates: number; frame: number } {
  const t = new Transport('live', fps)
  let updates = 0
  for (const target of rafClockTimes) {
    const steps = framesToCatchUp(t.frame, target, fps, cap)
    for (let i = 0; i < steps; i++) {
      t.stepLive()
      updates++
    }
  }
  return { updates, frame: t.frame }
}

/**
 * Same as simulateLive but with Engine.advanceLiveTo's backward-jump snap: when
 * the audio clock drops below the sim clock (new track loaded / seek / loop),
 * the transport resets to it instead of stalling (the forward-only catch-up
 * can't rewind). `recording` disables the snap (a take's clock is monotonic).
 */
function simulateLiveWithReset(
  rafClockTimes: number[],
  fps: number,
  cap = 30,
  recording = false,
): { updates: number; frame: number } {
  const t = new Transport('live', fps)
  let updates = 0
  for (const target of rafClockTimes) {
    if (!recording && target < t.time - 1 / fps) t.reset(target)
    const steps = framesToCatchUp(t.frame, target, fps, cap)
    for (let i = 0; i < steps; i++) {
      t.stepLive()
      updates++
    }
  }
  return { updates, frame: t.frame }
}

function evenTicks(hz: number, seconds: number): number[] {
  const out: number[] = []
  const n = Math.round(hz * seconds)
  for (let i = 1; i <= n; i++) out.push(i / hz)
  return out
}

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

  it('advanceTo frame counter FOLLOWS a backward-moving clock (stop/seek rewind)', () => {
    const t = new Transport('live', 60)
    expect(t.advanceTo(1.0).frame).toBe(60)
    // Seek/stop backward: dt clamps to 0 and the counter follows time DOWN.
    // (An earlier monotonic clamp here froze the counter after any rewind —
    // user bug "Last take 0:00": rehearse to 133s, stop, arm, play meant the
    // whole take counted zero frames until the track re-passed 133s. Backward
    // time can only come from stop/seek, which are locked during recording,
    // so within a take the counter is monotonic anyway.)
    const back = t.advanceTo(0.2)
    expect(back.dt).toBe(0)
    expect(back.frame).toBe(12)
    // A take armed right after the rewind measures from the rewound position.
    expect(t.advanceTo(1.2).frame).toBe(72)
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

  it('stepLive advances one fixed timestep, dt is fixed, time is pinned to frame/fps', () => {
    const t = new Transport('live', 60)
    const a = t.stepLive()
    const b = t.stepLive()
    expect([a.frame, b.frame]).toEqual([1, 2])
    expect(a.dt).toBeCloseTo(1 / 60, 12)
    expect(b.dt).toBeCloseTo(1 / 60, 12) // NEVER a real-elapsed dt — that is the fix
    expect(b.time).toBeCloseTo(2 / 60, 12)
    expect(() => new Transport('render', 60).stepLive()).toThrow()
  })

  // THE fix for live-vs-export divergence: the number of update() steps to reach
  // a given audio time depends ONLY on that time, never on the rAF/display rate.
  it('fixed-timestep catch-up reaches the same frame regardless of display refresh rate', () => {
    const fps = 60
    const seconds = 2
    const expected = Math.floor(seconds * fps) // 120
    const at60 = simulateLive(evenTicks(60, seconds), fps)
    const at120 = simulateLive(evenTicks(120, seconds), fps) // high-refresh monitor
    const at144 = simulateLive(evenTicks(144, seconds), fps)
    const at30 = simulateLive(evenTicks(30, seconds), fps) // slow / throttled

    // Every refresh rate runs the SAME number of updates to reach 2s of audio —
    // so a per-call-clocked scene (terrain scroll, whip physics, GPGPU sims) is
    // in the identical state at 2s live and on a fixed-fps export. Before the
    // fix, the 120Hz run did ~2x the updates the 60fps export does: the bug.
    for (const r of [at60, at120, at144, at30]) {
      expect(r.updates).toBe(expected)
      expect(r.frame).toBe(expected)
    }
  })

  it('catch-up is jitter-proof (irregular rAF timing still lands on floor(time*fps))', () => {
    const fps = 60
    // A gnarly irregular clock: uneven gaps, a couple of tiny sub-frame ticks
    // (two rAFs in one bucket), summing to exactly 1.0s.
    const jitter = [0.005, 0.02, 0.021, 0.05, 0.11, 0.2, 0.201, 0.4, 0.66, 0.9, 0.95, 1.0]
    const r = simulateLive(jitter, fps)
    expect(r.frame).toBe(60)
    expect(r.updates).toBe(60)
  })

  it('a stutter recovers over multiple rAFs without skipping frames (cap bounds the burst)', () => {
    const fps = 60
    const cap = 30
    // Steady 60Hz ticks across 2s, but the rAF loop FREEZES for 600ms (ticks in
    // [0.1, 0.7) never fire — a GC pause / backgrounded compositor). When ticks
    // resume, the clock is 36 frames ahead; the cap (30) bounds the recovery
    // burst so it drains across a couple of rAFs — but NO frame is skipped, so
    // the sim still reaches floor(2.0*60) and stays locked to the audio clock.
    const t = new Transport('live', fps)
    let updates = 0
    let maxBurst = 0
    for (let i = 1; i <= 120; i++) {
      const target = i / fps
      if (target > 0.1 && target < 0.7) continue // frozen window: no rAF
      const steps = framesToCatchUp(t.frame, target, fps, cap)
      maxBurst = Math.max(maxBurst, steps)
      for (let s = 0; s < steps; s++) {
        t.stepLive()
        updates++
      }
    }
    expect(t.frame).toBe(120) // fully caught up after the freeze — nothing lost
    expect(updates).toBe(120)
    expect(maxBurst).toBe(cap) // the freeze recovery did hit the cap, then drained
  })

  it('loading a track after a long demo run does NOT freeze the sim (backward-jump snap)', () => {
    const fps = 60
    // Demo mode ran for ~100s (frame ~6000), THEN a track loads and its clock
    // starts near 0 and plays forward. Without the backward-jump snap the
    // forward-only catch-up would stall at frame 6000 forever — the "loading a
    // song froze it" bug. With it, the transport snaps to the track and advances.
    const demo = evenTicks(60, 100) // ~6000 frames of demo
    const track = evenTicks(60, 2).map((s) => s) // track from 0 to 2s
    const r = simulateLiveWithReset([...demo, ...track], fps)
    // After the snap it tracks the NEW clock: 2s of track = frame 120, not stuck
    // at the ~6000 the demo had climbed to.
    expect(r.frame).toBe(120)
  })

  it('a backward-jump snap is suppressed while recording (monotonic take clock)', () => {
    const fps = 60
    // A pathological backward blip mid-recording must NOT reset the take clock.
    const times = [...evenTicks(60, 1), 0.2 /* blip back */, ...evenTicks(60, 1).map((s) => 1 + s)]
    const rec = simulateLiveWithReset(times, fps, 30, true)
    // No snap: the counter only ever moved forward (the blip advanced 0 frames),
    // ending where the final forward ticks left it — never rewound.
    expect(rec.frame).toBe(120)
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
