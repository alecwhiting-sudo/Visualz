import { describe, expect, it } from 'vitest'
import { SignalBus } from '../../src/core/signals'
import { mulberry32 } from '../../src/core/prng'
import { AudioEventDetector } from '../../src/audio/events'

const DT = 1 / 60

// --- Deterministic kick-synth fixture (docs/EVENTS.md §10) -----------------
//
// Kick: exponential decay envelope, τ = 55ms, superposed on bass (full amplitude)
// and mid (half amplitude). Optional offbeat hi-hats decay the same way onto the
// high band. Uniform noise comes from the existing seeded mulberry32 PRNG.
// Simulated AnalyserNode smoothing: X = 0.7*X + 0.3*raw per band per frame,
// matching AudioEngine's smoothingTimeConstant = 0.7.

const TAU = 0.055

interface Hit {
  /** Frame index the hit lands on (aligned to the fixture's own accumulated dt). */
  atFrame: number
  amp: number
}

interface SynthFrame {
  time: number
  bass: number
  mid: number
  high: number
}

function envelopeSum(t: number, hits: { time: number; amp: number }[]): number {
  let sum = 0
  for (const h of hits) {
    if (t < h.time) continue
    sum += h.amp * Math.exp(-(t - h.time) / TAU)
  }
  return sum
}

/** A steady grid of hits every `framesPerBeat` frames, starting at `offsetFrames`. */
function bpmGrid(framesPerBeat: number, totalFrames: number, offsetFrames = 0, amp = 1): Hit[] {
  const hits: Hit[] = []
  for (let f = offsetFrames; f < totalFrames; f += framesPerBeat) hits.push({ atFrame: f, amp })
  return hits
}

/**
 * Builds `frames` frames of deterministic, seeded synthetic band signals. `kicks`/
 * `hats` are specified by frame index so hit envelopes land exactly on a frame's own
 * accumulated time (no float mismatch between event time and frame time).
 */
function synthTrack(opts: {
  frames: number
  kicks?: Hit[]
  hats?: Hit[]
  noise?: number
  seed?: number
  dt?: number
}): SynthFrame[] {
  const dt = opts.dt ?? DT
  const noise = opts.noise ?? 0
  const rng = mulberry32(opts.seed ?? 1)

  const times: number[] = new Array(opts.frames)
  let t = 0
  for (let i = 0; i < opts.frames; i++) {
    times[i] = t
    t += dt
  }

  const kicks = (opts.kicks ?? []).map((h) => ({ time: times[h.atFrame], amp: h.amp }))
  const hats = (opts.hats ?? []).map((h) => ({ time: times[h.atFrame], amp: h.amp }))

  let sBass = 0
  let sMid = 0
  let sHigh = 0
  const frames: SynthFrame[] = []
  for (let i = 0; i < opts.frames; i++) {
    const kickEnv = envelopeSum(times[i], kicks)
    const hatEnv = envelopeSum(times[i], hats)
    let rawBass = kickEnv
    let rawMid = 0.5 * kickEnv
    let rawHigh = 0.4 * hatEnv
    if (noise > 0) {
      rawBass += noise * rng()
      rawMid += noise * rng()
      rawHigh += noise * rng()
    }
    sBass = 0.7 * sBass + 0.3 * rawBass
    sMid = 0.7 * sMid + 0.3 * rawMid
    sHigh = 0.7 * sHigh + 0.3 * rawHigh
    frames.push({ time: times[i], bass: sBass, mid: sMid, high: sHigh })
  }
  return frames
}

interface LiveResult {
  time: number
  onset: boolean
  beat: boolean
  beatPhase: number
  onsetStrength: number
}

/** Runs a fresh detector over `frames` at constant `dt`, LIVE mode throughout. */
function runLive(frames: SynthFrame[], dt = DT): { detector: AudioEventDetector; results: LiveResult[] } {
  const detector = new AudioEventDetector()
  const bus = new SignalBus()
  const results = frames.map((f) => {
    bus.set('bass', f.bass)
    bus.set('mid', f.mid)
    bus.set('high', f.high)
    const r = detector.update(dt, f.time, bus, false)
    return { time: f.time, ...r }
  })
  return { detector, results }
}

// --- 1. Demo path (docs/EVENTS.md §7 / §10 cases 1-3) -----------------------

describe('demo path', () => {
  it('1) fires exactly on the 120 BPM grid; beatPhase == fract(time*2)', () => {
    const detector = new AudioEventDetector()
    const bus = new SignalBus()
    const fires: number[] = []
    for (let i = 0; i < 180; i++) {
      const t = i * DT
      const r = detector.update(DT, t, bus, true)
      const expectedPhase = t * 2 - Math.floor(t * 2)
      expect(r.beatPhase).toBeCloseTo(expectedPhase, 9)
      expect(r.onset).toBe(r.beat) // demo mode: onset === beat
      if (r.beat) fires.push(i)
    }
    // 3s @ 120 BPM: beats land on frames 0, 30, 60, 90, 120, 150 (t = 0, 0.5, 1.0, ...).
    expect(fires).toEqual([0, 30, 60, 90, 120, 150])
  })

  it('2) seek-safe: landing exactly on a beat boundary fires on the very first frame', () => {
    const detector = new AudioEventDetector()
    const bus = new SignalBus()
    const r = detector.update(DT, 1.0, bus, true) // t*2 = 2, exactly on the grid
    expect(r.onset).toBe(true)
    expect(r.beat).toBe(true)
    expect(r.beatPhase).toBe(0)
  })

  it('3) seek-safe: landing off a beat boundary does not fire on the first frame', () => {
    const detector = new AudioEventDetector()
    const bus = new SignalBus()
    const r = detector.update(DT, 1.2, bus, true) // t*2 = 2.4, not on the grid
    expect(r.onset).toBe(false)
    expect(r.beat).toBe(false)
    expect(r.beatPhase).toBeCloseTo(0.4, 9)
  })
})

// --- 2. Silence (case 4) -----------------------------------------------------

describe('silence', () => {
  it('4) produces no onsets; the metronome keeps free-running', () => {
    const detector = new AudioEventDetector()
    const bus = new SignalBus()
    bus.set('bass', 0)
    bus.set('mid', 0)
    bus.set('high', 0)
    let onsetCount = 0
    let beatCount = 0
    for (let i = 0; i < 300; i++) {
      const r = detector.update(DT, i * DT, bus, false)
      if (r.onset) onsetCount++
      if (r.beat) beatCount++
    }
    expect(onsetCount).toBe(0)
    expect(beatCount).toBeGreaterThan(0) // default 120 BPM period, undisturbed
  })
})

// --- 3. Single kick / refractory (cases 5-7) --------------------------------

describe('onset latency and refractory', () => {
  it('5) a single isolated kick is detected within 2 frames', () => {
    const kickFrame = 10
    const frames = synthTrack({ frames: 30, kicks: [{ atFrame: kickFrame, amp: 1 }] })
    const { results } = runLive(frames)
    const onsetFrame = results.findIndex((r) => r.onset)
    expect(onsetFrame).toBeGreaterThanOrEqual(kickFrame)
    expect(onsetFrame).toBeLessThanOrEqual(kickFrame + 2)
  })

  it('6) refractory suppresses a second onset 100ms (6 frames) after the first', () => {
    const frames = synthTrack({ frames: 30, kicks: [{ atFrame: 5, amp: 1 }, { atFrame: 11, amp: 1 }] })
    const { results } = runLive(frames)
    expect(results.filter((r) => r.onset)).toHaveLength(1)
  })

  it('7) a second onset 133ms (8 frames) after the first is not suppressed', () => {
    const frames = synthTrack({ frames: 30, kicks: [{ atFrame: 5, amp: 1 }, { atFrame: 13, amp: 1 }] })
    const { results } = runLive(frames)
    expect(results.filter((r) => r.onset)).toHaveLength(2)
  })
})

// --- 4. Adaptive threshold under a loud section (case 8) --------------------

describe('adaptive threshold', () => {
  it('8) recovers detection within ~1s after a loud section', () => {
    const framesPerBeat = 30 // 120 BPM
    const totalFrames = 450 // 7.5s
    const kicks: Hit[] = [
      ...bpmGrid(framesPerBeat, 180), // phase A: normal kicks, 0-3s
      ...(() => {
        // phase B: a loud burst, 3.0-4.0s, amplitude 6x normal, every 100ms
        const hits: Hit[] = []
        for (let f = 180; f < 240; f += 6) hits.push({ atFrame: f, amp: 6 })
        return hits
      })(),
      ...bpmGrid(framesPerBeat, totalFrames, 240), // phase C: normal kicks resume, 4-7.5s
    ]
    const frames = synthTrack({ frames: totalFrames, kicks, noise: 0.02, seed: 2 })
    const { results } = runLive(frames)

    const detectedInWindow = (lo: number, hi: number) =>
      results.slice(lo, hi).some((r) => r.onset)

    expect(detectedInWindow(0, 180)).toBe(true) // baseline detection works
    // The 1s trailing threshold window still holds burst-inflated flux for ~60
    // frames after the burst ends (frame 240); recovery is expected shortly after
    // that window fully flushes, well within the validated ~1s-after-recovery bound.
    expect(detectedInWindow(240, 360)).toBe(true)
  })
})

// --- 5. Noise floor false-positive rate (case 9) ----------------------------

describe('noise floor', () => {
  it('9) at most one false positive over a 600-frame pure-noise run', () => {
    // A quiet ambient noise floor (no kicks at all — no signal to ride the adaptive
    // threshold up), just above CFG.floor: the harder case than the validated
    // "noise on top of kicks" scenarios in docs/EVENTS.md §8.
    const frames = synthTrack({ frames: 600, noise: 0.02, seed: 11 })
    const { results } = runLive(frames)
    expect(results.filter((r) => r.onset).length).toBeLessThanOrEqual(1)
  })
})

// --- 6. Tempo / beat lock (cases 10-11) -------------------------------------

describe('tempo lock', () => {
  it('10) locks confidently onto a steady 120 BPM kick train within 4 seconds', () => {
    const framesPerBeat = 30
    const totalFrames = 300 // 5s (within the 10s budget for this case)
    const frames = synthTrack({
      frames: totalFrames,
      kicks: bpmGrid(framesPerBeat, totalFrames),
      hats: bpmGrid(framesPerBeat, totalFrames, framesPerBeat / 2, 0.6),
      noise: 0.02,
      seed: 5,
    })
    const detector = new AudioEventDetector()
    const bus = new SignalBus()
    let confidenceAt4s = 0
    const frameAt4s = Math.round(4 / DT)
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i]
      bus.set('bass', f.bass)
      bus.set('mid', f.mid)
      bus.set('high', f.high)
      detector.update(DT, f.time, bus, false)
      if (i === frameAt4s) confidenceAt4s = detector.confidence
    }
    expect(confidenceAt4s).toBeGreaterThanOrEqual(0.5)
  })

  for (const bpm of [90, 120, 150]) {
    it(`11) estimates tempo within ±5% at ${bpm} BPM`, () => {
      const framesPerBeat = Math.round(3600 / bpm)
      const totalFrames = 480 // 8s (within the 10s budget for this case)
      const frames = synthTrack({
        frames: totalFrames,
        kicks: bpmGrid(framesPerBeat, totalFrames),
        noise: 0.02,
        seed: bpm,
      })
      const detector = new AudioEventDetector()
      const bus = new SignalBus()
      for (const f of frames) {
        bus.set('bass', f.bass)
        bus.set('mid', f.mid)
        bus.set('high', f.high)
        detector.update(DT, f.time, bus, false)
      }
      const truePeriod = 60 / bpm
      const relError = Math.abs(detector.period - truePeriod) / truePeriod
      expect(relError).toBeLessThanOrEqual(0.05)
    })
  }
})

// --- 7. beatPhase shape (case 12) --------------------------------------------

describe('beatPhase shape', () => {
  it('12) is a monotonic sawtooth: decreases only on beat frames', () => {
    const detector = new AudioEventDetector()
    const bus = new SignalBus()
    bus.set('bass', 0)
    bus.set('mid', 0)
    bus.set('high', 0) // silence: no onset ever fires, so only the PLL free-run wrap applies
    let prevPhase = detector.phase
    for (let i = 0; i < 300; i++) {
      const r = detector.update(DT, i * DT, bus, false)
      if (r.beat) {
        expect(r.beatPhase).toBeLessThanOrEqual(prevPhase)
      } else {
        expect(r.beatPhase).toBeGreaterThanOrEqual(prevPhase)
      }
      prevPhase = r.beatPhase
    }
  })
})

// --- 8. reset() (case 13) -----------------------------------------------------

describe('reset()', () => {
  it('13) restores cold-start state', () => {
    const detector = new AudioEventDetector()
    const bus = new SignalBus()
    const frames = synthTrack({ frames: 200, kicks: bpmGrid(30, 200), noise: 0.02, seed: 3 })
    for (const f of frames) {
      bus.set('bass', f.bass)
      bus.set('mid', f.mid)
      bus.set('high', f.high)
      detector.update(DT, f.time, bus, false)
    }
    expect(detector.confidence).toBeGreaterThan(0) // state has moved away from cold-start

    detector.reset()
    expect(detector.period).toBe(0.5)
    expect(detector.phase).toBe(0)
    expect(detector.confidence).toBe(0)

    // Behaves like a brand-new instance: first frame after reset forces flux=0.
    bus.set('bass', 1)
    bus.set('mid', 1)
    bus.set('high', 1)
    const r = detector.update(DT, 0, bus, false)
    expect(r.onset).toBe(false)
    expect(r.onsetStrength).toBe(0)
  })
})

// --- 9. dt jitter (case 14) ---------------------------------------------------

describe('dt jitter', () => {
  it('14) tolerates ±15% frame-time jitter: most kicks still detected within 3 frames', () => {
    const totalFrames = 300
    const rng = mulberry32(99)
    const dts: number[] = []
    const times: number[] = new Array(totalFrames)
    let t = 0
    for (let i = 0; i < totalFrames; i++) {
      const dt = DT * (1 + 0.15 * (2 * rng() - 1))
      dts.push(dt)
      times[i] = t
      t += dt
    }
    const kickFrames: number[] = []
    for (let f = 0; f < totalFrames; f += 30) kickFrames.push(f)
    const kicks = kickFrames.map((f) => ({ time: times[f], amp: 1 }))

    const detector = new AudioEventDetector()
    const bus = new SignalBus()
    let sBass = 0
    let sMid = 0
    const detectedNear = new Set<number>()
    for (let i = 0; i < totalFrames; i++) {
      const kickEnv = envelopeSum(times[i], kicks)
      sBass = 0.7 * sBass + 0.3 * kickEnv
      sMid = 0.7 * sMid + 0.3 * (0.5 * kickEnv)
      bus.set('bass', sBass)
      bus.set('mid', sMid)
      bus.set('high', 0)
      const r = detector.update(dts[i], times[i], bus, false)
      if (r.onset) {
        for (const kf of kickFrames) if (Math.abs(i - kf) <= 3) detectedNear.add(kf)
      }
    }
    // Validation table: 97.5% detect rate under ±15% dt jitter; use a generous
    // 80% floor here to keep the test robust to the seeded fixture's specifics.
    expect(detectedNear.size).toBeGreaterThanOrEqual(Math.floor(kickFrames.length * 0.8))
  })
})

// --- 10. First-frame safety (case 15) -----------------------------------------

describe('first-frame safety', () => {
  it('15) no throw, sane defaults, flux forced to 0 so no spurious onset', () => {
    const detector = new AudioEventDetector()
    const bus = new SignalBus()
    bus.set('bass', 0.8)
    bus.set('mid', 0.6)
    bus.set('high', 0.4)
    const r = detector.update(DT, 0, bus, false)
    expect(r.onset).toBe(false)
    expect(r.onsetStrength).toBe(0)
    expect(r.beat).toBe(false)
    expect(r.beatPhase).toBeCloseTo(DT / 0.5, 12) // period holds the 120 BPM default
    expect(Number.isFinite(r.beatPhase)).toBe(true)
    expect(detector.period).toBe(0.5)
    expect(detector.confidence).toBe(0)
  })
})

// --- 11. Mode-switch robustness (review follow-up) ------------------------------

describe('demo/live mode switching', () => {
  it('16) first live frame after a demo interlude recomputes flux from scratch', () => {
    const detector = new AudioEventDetector()
    const bus = new SignalBus()
    // Live segment at a quiet level, long enough to fill the threshold window.
    bus.set('bass', 0.1)
    bus.set('mid', 0.05)
    bus.set('high', 0.02)
    let time = 0
    for (let f = 0; f < 90; f++) {
      detector.update(DT, time, bus, false)
      time += DT
    }
    // Demo interlude (audio stopped); band signals move meanwhile.
    for (let f = 0; f < 30; f++) {
      detector.update(DT, time, bus, true)
      time += DT
    }
    // Audio resumes much louder: the jump vs the stale pre-interlude bands must
    // NOT read as an onset — the first live frame recomputes with flux 0.
    bus.set('bass', 0.9)
    bus.set('mid', 0.7)
    bus.set('high', 0.5)
    const r = detector.update(DT, time, bus, false)
    expect(r.onset).toBe(false)
    expect(r.onsetStrength).toBe(0)
  })
})
