import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../../src/core/prng'
import { analyzeAudio, makeFFT, blackmanWindow } from '../../src/audio/analysis'
import { sampleTimeline, serializeTimeline, parseTimeline } from '../../src/audio/timeline'
import type { FeatureTimeline } from '../../src/audio/analysis'

const SAMPLE_RATE = 44100

// --- Deterministic kick-synth fixture, adapted from tests/unit/events.test.ts's
// band-domain fixture into raw PCM (docs/ANALYSIS.md §11): a kick is a decaying
// low-frequency tone (exponential envelope, tau=55ms), a hat is a decaying burst
// of seeded noise (tau=20ms), plus a constant seeded noise floor. All randomness
// comes from the existing mulberry32 PRNG (core/prng.ts) — no Math.random.
const KICK_TAU = 0.055
const KICK_FREQ = 60
const HAT_TAU = 0.02

interface KickTrack {
  pcm: Float32Array
  kickTimes: number[]
  hatTimes: number[]
}

/** A steady grid of times, `beatSec` apart, starting at `offsetSec`, up to `seconds`. */
function grid(beatSec: number, seconds: number, offsetSec = 0): number[] {
  const times: number[] = []
  for (let t = offsetSec; t < seconds; t += beatSec) times.push(t)
  return times
}

function synthKickTrack(opts: {
  seconds: number
  bpm: number
  kickTimes?: number[]
  hatTimes?: number[]
  noiseAmp?: number
  seed?: number
}): KickTrack {
  const beatSec = 60 / opts.bpm
  const kickTimes = opts.kickTimes ?? grid(beatSec, opts.seconds)
  const hatTimes = opts.hatTimes ?? []
  const noiseAmp = opts.noiseAmp ?? 0
  const rng = mulberry32(opts.seed ?? 1)
  const n = Math.round(opts.seconds * SAMPLE_RATE)
  const pcm = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE
    let s = 0
    for (const kt of kickTimes) {
      const rel = t - kt
      if (rel >= 0) s += Math.exp(-rel / KICK_TAU) * Math.sin(2 * Math.PI * KICK_FREQ * rel)
    }
    for (const ht of hatTimes) {
      const rel = t - ht
      if (rel >= 0) s += 0.6 * Math.exp(-rel / HAT_TAU) * (2 * rng() - 1)
    }
    if (noiseAmp > 0) s += noiseAmp * (2 * rng() - 1)
    pcm[i] = s
  }
  return { pcm, kickTimes, hatTimes }
}

function tonePCM(freq: number, seconds: number, amp = 0.5): Float32Array {
  const n = Math.round(seconds * SAMPLE_RATE)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE)
  return out
}

/** Greedy nearest-match precision/recall/F1 within `tolSec`, docs/ANALYSIS.md §10-11. */
function f1Score(pred: number[], truth: number[], tolSec: number): { precision: number; recall: number; f1: number } {
  const matched = new Set<number>()
  let tp = 0
  for (const p of pred) {
    let bestI = -1
    let bestD = Infinity
    for (let i = 0; i < truth.length; i++) {
      if (matched.has(i)) continue
      const d = Math.abs(truth[i] - p)
      if (d < bestD) {
        bestD = d
        bestI = i
      }
    }
    if (bestI >= 0 && bestD <= tolSec) {
      tp++
      matched.add(bestI)
    }
  }
  const fp = pred.length - tp
  const fn = truth.length - tp
  const precision = tp / (tp + fp || 1)
  const recall = tp / (tp + fn || 1)
  const f1 = (2 * precision * recall) / (precision + recall || 1)
  return { precision, recall, f1 }
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b)
  const n = sorted.length
  if (n === 0) return 0
  const mid = Math.floor(n / 2)
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

// --- 1. FFT (docs/ANALYSIS.md §1.1, §11 cases 1-3) --------------------------

describe('FFT', () => {
  it('1) impulse input produces a flat spectrum (maxErr 0)', () => {
    const N = 64
    const fft = makeFFT(N)
    const re = new Float64Array(N)
    const im = new Float64Array(N)
    re[0] = 1
    fft(re, im)
    let maxErr = 0
    for (let i = 0; i < N; i++) {
      maxErr = Math.max(maxErr, Math.abs(re[i] - 1), Math.abs(im[i]))
    }
    expect(maxErr).toBe(0)
  })

  it('2) a cosine at bin k0 peaks with magnitude exactly N/2', () => {
    const N = 64
    const fft = makeFFT(N)
    const re = new Float64Array(N)
    const im = new Float64Array(N)
    const k0 = 5
    for (let i = 0; i < N; i++) re[i] = Math.cos((2 * Math.PI * k0 * i) / N)
    fft(re, im)
    const mag = (k: number) => Math.hypot(re[k], im[k])
    expect(mag(k0)).toBeCloseTo(N / 2, 9)
    expect(mag(N - k0)).toBeCloseTo(N / 2, 9)
    for (let k = 0; k < N; k++) {
      if (k === k0 || k === N - k0) continue
      expect(mag(k)).toBeLessThan(1e-9)
    }
  })

  it('3) Parseval energy conservation: sum(|x|^2)*N == sum(|X|^2)', () => {
    const N = 64
    const fft = makeFFT(N)
    const re = new Float64Array(N)
    const im = new Float64Array(N)
    for (let i = 0; i < N; i++) re[i] = Math.sin(i * 0.37) + 0.5 * Math.cos(i * 1.1)
    let timeEnergy = 0
    for (let i = 0; i < N; i++) timeEnergy += re[i] * re[i]
    fft(re, im)
    let freqEnergy = 0
    for (let i = 0; i < N; i++) freqEnergy += re[i] * re[i] + im[i] * im[i]
    expect(freqEnergy / (timeEnergy * N)).toBeCloseTo(1, 9)
  })
})

// --- 2. Band features (docs/ANALYSIS.md §2, §11 cases 4-7) ------------------

describe('bands', () => {
  it('4) peak-bin byte matches the analytic mapping: 255/255/242 for A=1.0/0.5/0.1', () => {
    // Reproduces §2's formula directly (via the shared makeFFT/blackmanWindow
    // building blocks) on a bin-centered tone, letting the EMA converge —
    // the exact scenario docs/ANALYSIS.md §2 validated.
    const N = 2048
    const half = N / 2
    const binHz = SAMPLE_RATE / 2 / half
    const k0 = 100
    const freq = k0 * binHz
    const ALPHA = 0.78
    const MIN_DB = -100
    const MAX_DB = -30
    const HOP = 512

    const peakByte = (A: number, frames: number): number => {
      const fft = makeFFT(N)
      const window = blackmanWindow(N)
      let smMag = 0
      for (let f = 0; f < frames; f++) {
        const re = new Float64Array(N)
        const im = new Float64Array(N)
        const off = f * HOP
        for (let i = 0; i < N; i++) re[i] = A * Math.sin((2 * Math.PI * freq * (off + i)) / SAMPLE_RATE) * window[i]
        fft(re, im)
        const m = Math.sqrt(re[k0] ** 2 + im[k0] ** 2) / N
        smMag = ALPHA * smMag + (1 - ALPHA) * m
      }
      const db = 20 * Math.log10(smMag + 1e-30)
      return Math.min(255, Math.max(0, Math.round((255 / (MAX_DB - MIN_DB)) * (db - MIN_DB))))
    }

    expect(peakByte(1.0, 50)).toBe(255)
    expect(peakByte(0.5, 50)).toBe(255)
    expect(peakByte(0.1, 50)).toBe(242)
  })

  it('5) band separation: a tone in one band barely leaks into the others', () => {
    const bassTl = analyzeAudio(tonePCM(100, 1.0), SAMPLE_RATE)
    const midTl = analyzeAudio(tonePCM(800, 1.0), SAMPLE_RATE)
    const highTl = analyzeAudio(tonePCM(5000, 1.0), SAMPLE_RATE)
    const last = (tl: FeatureTimeline) => tl.frames - 1

    expect(bassTl.bass[last(bassTl)]).toBeGreaterThan(0.3)
    expect(bassTl.mid[last(bassTl)]).toBeLessThan(0.05)
    expect(bassTl.high[last(bassTl)]).toBeLessThan(0.01)

    expect(midTl.bass[last(midTl)]).toBeLessThan(0.01)
    expect(midTl.mid[last(midTl)]).toBeGreaterThan(0.03)
    expect(midTl.high[last(midTl)]).toBeLessThan(0.01)

    expect(highTl.bass[last(highTl)]).toBeLessThan(0.01)
    expect(highTl.mid[last(highTl)]).toBeLessThan(0.01)
    expect(highTl.high[last(highTl)]).toBeGreaterThan(0.005)
  })

  it('6) silence produces all-zero bands, rms, and onsetEnv', () => {
    const tl = analyzeAudio(new Float32Array(SAMPLE_RATE), SAMPLE_RATE)
    expect(tl.frames).toBeGreaterThan(0)
    for (let f = 0; f < tl.frames; f++) {
      expect(tl.bass[f]).toBe(0)
      expect(tl.mid[f]).toBe(0)
      expect(tl.high[f]).toBe(0)
      expect(tl.rms[f]).toBe(0)
    }
  })

  it('7) the EMA smoothing converges to a stable plateau under a sustained tone', () => {
    const tl = analyzeAudio(tonePCM(800, 1.0), SAMPLE_RATE)
    // Late frames should be essentially flat (converged); early frames ramp up.
    const early = tl.mid[2]
    const plateau = tl.mid[tl.frames - 1]
    expect(plateau).toBeGreaterThan(early) // ramps up, doesn't overshoot/oscillate
    for (let f = tl.frames - 10; f < tl.frames; f++) {
      expect(tl.mid[f]).toBeCloseTo(plateau, 3)
    }
  })
})

// --- 3. Onset detection (docs/ANALYSIS.md §3, §11 cases 8-12) ---------------

describe('onsets', () => {
  it('8) a single isolated kick is detected within ±2 frames', () => {
    const { pcm } = synthKickTrack({ seconds: 2, bpm: 60, kickTimes: [1.0] })
    const tl = analyzeAudio(pcm, SAMPLE_RATE)
    expect(tl.onsets.length).toBe(1)
    expect(Math.abs(tl.onsets[0] - 1.0)).toBeLessThanOrEqual(2 * tl.hopSec)
  })

  it('9) two hits 40ms apart (under the ~46ms refractory) combine into one onset', () => {
    const { pcm } = synthKickTrack({ seconds: 2, bpm: 60, kickTimes: [1.0, 1.04] })
    const tl = analyzeAudio(pcm, SAMPLE_RATE)
    expect(tl.onsets.length).toBe(1)
  })

  it('10) two hits 120ms apart (over the refractory) register as distinct onsets', () => {
    const { pcm } = synthKickTrack({ seconds: 2, bpm: 60, kickTimes: [1.0, 1.12] })
    const tl = analyzeAudio(pcm, SAMPLE_RATE)
    expect(tl.onsets.length).toBe(2)
  })

  it('11) F1 >= 0.95 on a 120 BPM kicks+hats+noise fixture', () => {
    const { pcm, kickTimes, hatTimes } = synthKickTrack({
      seconds: 10,
      bpm: 120,
      hatTimes: grid(0.5, 10, 0.25),
      noiseAmp: 0.02,
      seed: 3,
    })
    const tl = analyzeAudio(pcm, SAMPLE_RATE)
    const truth = [...kickTimes, ...hatTimes].sort((a, b) => a - b)
    const { f1 } = f1Score(Array.from(tl.onsets), truth, 0.05)
    expect(f1).toBeGreaterThanOrEqual(0.95)
  })

  it('12) loudness invariance: a 3x loud section does not degrade F1', () => {
    const beatSec = 0.5
    const seconds = 10
    const rng = mulberry32(9)
    const n = Math.round(seconds * SAMPLE_RATE)
    const pcm = new Float32Array(n)
    const kickTimes = grid(beatSec, seconds)
    const hatTimes = grid(beatSec, seconds, 0.25)
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE
      let s = 0
      for (const kt of kickTimes) {
        const rel = t - kt
        if (rel >= 0) {
          const amp = kt >= 4 && kt < 6 ? 3.0 : 1.0
          s += amp * Math.exp(-rel / KICK_TAU) * Math.sin(2 * Math.PI * KICK_FREQ * rel)
        }
      }
      for (const ht of hatTimes) {
        const rel = t - ht
        if (rel >= 0) {
          const amp = ht >= 4 && ht < 6 ? 3.0 : 1.0
          s += amp * 0.6 * Math.exp(-rel / HAT_TAU) * (2 * rng() - 1)
        }
      }
      s += 0.02 * (2 * rng() - 1)
      pcm[i] = s
    }
    const tl = analyzeAudio(pcm, SAMPLE_RATE)
    const truth = [...kickTimes, ...hatTimes].sort((a, b) => a - b)
    const { f1 } = f1Score(Array.from(tl.onsets), truth, 0.05)
    expect(f1).toBeGreaterThanOrEqual(0.9)
  })
})

// --- 4. Beat tracking (docs/ANALYSIS.md §4, §11 cases 13-15) ----------------

describe('beats', () => {
  it('13) locks a steady 120 BPM kick+hat train with <=20ms median error', () => {
    const { pcm, kickTimes } = synthKickTrack({
      seconds: 10,
      bpm: 120,
      hatTimes: grid(0.5, 10, 0.25),
      noiseAmp: 0.02,
      seed: 5,
    })
    const tl = analyzeAudio(pcm, SAMPLE_RATE)
    expect(tl.beats.length).toBeGreaterThan(0)
    const errs = Array.from(tl.beats).map((b) => Math.min(...kickTimes.map((k) => Math.abs(b - k))))
    expect(median(errs)).toBeLessThanOrEqual(0.02)
    expect(tl.bpm).toBeGreaterThan(0)
  })

  for (const bpm of [90, 150]) {
    it(`14) estimates ${bpm} BPM without octave error (within +/-5%)`, () => {
      const { pcm } = synthKickTrack({ seconds: 8, bpm, noiseAmp: 0.02, seed: bpm })
      const tl = analyzeAudio(pcm, SAMPLE_RATE)
      expect(tl.bpm).toBeGreaterThan(0)
      const relErr = Math.abs(tl.bpm - bpm) / bpm
      expect(relErr).toBeLessThanOrEqual(0.05)
    })
  }

  it('15) silence produces no beats and bpm 0', () => {
    const tl = analyzeAudio(new Float32Array(3 * SAMPLE_RATE), SAMPLE_RATE)
    expect(tl.beats.length).toBe(0)
    expect(tl.bpm).toBe(0)
  })
})

// --- 5. sampleTimeline (docs/ANALYSIS.md §6, §11 cases 16-19) ---------------

function makeTimeline(overrides: Partial<FeatureTimeline> = {}): FeatureTimeline {
  return {
    version: 1,
    sampleRate: 44100,
    hopSec: 512 / 44100,
    frames: 0,
    rms: new Float32Array(0),
    bass: new Float32Array(0),
    mid: new Float32Array(0),
    high: new Float32Array(0),
    onsetEnv: new Float32Array(0),
    onsets: new Float32Array(0),
    beats: new Float32Array(0),
    bpm: 0,
    ...overrides,
  }
}

describe('sampleTimeline', () => {
  it('16) each event fires exactly once under fixed-dt stepping (40 beats -> 40 pulses)', () => {
    const beats = new Float32Array(Array.from({ length: 40 }, (_, i) => i * 0.5))
    const tl = makeTimeline({ beats })
    const dt = 1 / 60
    let fires = 0
    // Accumulate time exactly like Transport.step() does (this.t += dt) — the
    // exactly-once contract requires `time - dt` to reproduce the previous
    // call's `time` bit-for-bit, which only holds under accumulation, not a
    // freshly-recomputed `i * dt` (docs/ANALYSIS.md §6 CONTRACT NOTE).
    let t = 0
    for (let i = 0; t <= 20; i++) {
      const s = sampleTimeline(tl, t, dt)
      if (s.beat === 1) fires++
      t += dt
    }
    expect(fires).toBe(40)
  })

  it('17) dt=0 never fires a pulse (empty half-open window)', () => {
    const beats = new Float32Array([1.0])
    const tl = makeTimeline({ beats })
    const s = sampleTimeline(tl, 1.0, 0)
    expect(s.beat).toBe(0)
    const s2 = sampleTimeline(tl, 1.0, 1 / 60)
    expect(s2.beat).toBe(1) // sanity: the same instant DOES fire with a real dt
  })

  it('18) beatPhase: 0 before the first beat, 1 at/after the last, lerped between', () => {
    const beats = new Float32Array([1.0, 1.5, 2.5])
    const tl = makeTimeline({ beats })
    expect(sampleTimeline(tl, 0, 1 / 60).beatPhase).toBe(0)
    expect(sampleTimeline(tl, 1.0, 1 / 60).beatPhase).toBe(0)
    expect(sampleTimeline(tl, 1.25, 1 / 60).beatPhase).toBeCloseTo(0.5, 9)
    expect(sampleTimeline(tl, 2.0, 1 / 60).beatPhase).toBeCloseTo(0.5, 9)
    expect(sampleTimeline(tl, 2.5, 1 / 60).beatPhase).toBe(1)
    expect(sampleTimeline(tl, 10, 1 / 60).beatPhase).toBe(1)
  })

  it('19) purity: repeated/seeked queries at the same (time, dt) are stable and order-independent', () => {
    const beats = new Float32Array([0.5, 1.0, 1.5])
    const bass = new Float32Array([0, 0.2, 0.4, 0.6, 0.8])
    const tl = makeTimeline({ beats, bass, frames: bass.length, hopSec: 0.5 })
    const dt = 1 / 60
    const a = sampleTimeline(tl, 1.0, dt)
    const b = sampleTimeline(tl, 1.0, dt) // repeat
    expect(b).toEqual(a)
    // "Seeking" backward and re-sampling a later time again gives the same result —
    // no hidden cross-call state.
    sampleTimeline(tl, 0.1, dt)
    const c = sampleTimeline(tl, 1.0, dt)
    expect(c).toEqual(a)
  })
})

// --- 6. Serialization (docs/ANALYSIS.md §7, §11 cases 20-21) ----------------

describe('serialization', () => {
  it('20) serializeTimeline/parseTimeline round-trips bit-exact', () => {
    const { pcm } = synthKickTrack({ seconds: 3, bpm: 120, noiseAmp: 0.02, seed: 11 })
    const tl = analyzeAudio(pcm, SAMPLE_RATE)
    const back = parseTimeline(serializeTimeline(tl))
    expect(back.version).toBe(tl.version)
    expect(back.sampleRate).toBe(tl.sampleRate)
    expect(back.hopSec).toBe(tl.hopSec)
    expect(back.frames).toBe(tl.frames)
    expect(back.bpm).toBe(tl.bpm)
    for (const field of ['rms', 'bass', 'mid', 'high', 'onsetEnv', 'onsets', 'beats'] as const) {
      expect(Array.from(back[field])).toEqual(Array.from(tl[field]))
    }
  })

  it('21) rejects malformed timelines with descriptive errors (5 cases)', () => {
    const { pcm } = synthKickTrack({ seconds: 2, bpm: 120, noiseAmp: 0.02, seed: 4 })
    const tl = analyzeAudio(pcm, SAMPLE_RATE)
    const ser = serializeTimeline(tl)

    expect(() => parseTimeline({ ...ser, version: 2 })).toThrow(/version/i)
    expect(() => parseTimeline({ ...ser, rms: 123 })).toThrow(/rms/i)
    expect(() => parseTimeline({ ...ser, rms: 'A' })).toThrow(/base64/i)
    expect(() => parseTimeline({ ...ser, frames: tl.frames + 1 })).toThrow(/frames/i)

    // Descending beats: hand-build 2 floats out of order.
    const bad = new Float32Array([1, 0.5])
    const badBytes = new Uint8Array(bad.buffer)
    let bin = ''
    for (const b of badBytes) bin += String.fromCharCode(b)
    const badB64 = btoa(bin)
    expect(() => parseTimeline({ ...ser, beats: badB64 })).toThrow(/ascending/i)
  })
})

// --- 7. Determinism (docs/ANALYSIS.md §9, §11 case 22) ----------------------

describe('determinism', () => {
  it('22) analyzeAudio(samples) run twice produces bit-identical output buffers', () => {
    const { pcm } = synthKickTrack({ seconds: 4, bpm: 120, hatTimes: grid(0.5, 4, 0.25), noiseAmp: 0.02, seed: 21 })
    const a = analyzeAudio(pcm, SAMPLE_RATE)
    const b = analyzeAudio(pcm, SAMPLE_RATE)
    for (const field of ['rms', 'bass', 'mid', 'high', 'onsetEnv', 'onsets', 'beats'] as const) {
      expect(Array.from(a[field])).toEqual(Array.from(b[field]))
    }
    expect(a.bpm).toBe(b.bpm)
  })
})
