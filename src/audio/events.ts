/**
 * Onset/beat detection (docs/EVENTS.md). Two fully independent paths selected by
 * `demoMode`: a pure analytic 120 BPM grid when there's no audio, and a live
 * spectral-flux onset detector + autocorrelation tempo estimator driving a
 * two-speed phase-locked loop when there is. Wired by the engine: reads
 * `bass/mid/high` off the SignalBus, publishes `onset/beat/beatPhase/onsetStrength`
 * back onto it every frame.
 *
 * No `Date.now()`/`performance.now()`/`Math.random()` — all state advances from
 * the `dt`/`time` the caller passes in, so replay is frame-identical.
 */

const CFG = {
  // flux (band novelty)
  wBass: 1.0,
  wMid: 0.6,
  wHigh: 0.35, // band weights on positive first-difference

  // adaptive threshold
  thWinSec: 1.0, // trailing stats window → 60 frames @60fps
  k: 2.2, // threshold = mean + k·std
  floor: 0.012, // minimum threshold (silence guard)

  // refractory
  refractorySec: 0.1, // min inter-onset interval (~6 frames)

  // tempo (autocorrelation)
  acWinSec: 2.5, // novelty history window → 150 frames @60fps
  acUpdateSec: 0.15, // recompute cadence
  acFillFrac: 0.75, // window fill fraction required before first estimate
  bpmMin: 60,
  bpmMax: 180,
  bpmPref: 120,
  bpmPrefSigma: 0.8, // log-tempo preference
  periodSmoothAcq: 0.5,
  periodSmoothTrack: 0.15, // period EMA (unlocked/locked)

  // phase-locked loop
  kPhaseAcq: 0.5, // phase-correction gain while unlocked (fast acquire)
  kPhaseTrack: 0.12, // phase-correction gain when locked
  captureWin: 0.18, // |phase-error| ≤ this counts as on-beat evidence
  confUp: 0.1,
  confDown: 0.05, // confidence increments

  // misc
  dtEma: 0.05, // dt EMA → running fps for lag↔seconds conversion
  fpsNominal: 60, // ring-buffer sizing only
} as const

export interface AudioEventResult {
  onset: boolean
  beat: boolean
  beatPhase: number
  onsetStrength: number
}

interface SignalsLike {
  get(name: string, fallback?: number): number
}

export class AudioEventDetector {
  // Ring buffer capacities, fixed at construction from CFG.fpsNominal.
  private readonly thN: number
  private readonly acN: number

  // band history
  private prevBass = 0
  private prevMid = 0
  private prevHigh = 0
  private firstFrame = true
  private prevFlux = 0

  // threshold ring buffer (preallocated)
  private readonly thBuf: Float32Array
  private thHead = 0
  private thCount = 0

  // autocorrelation novelty ring buffer + scratch (all preallocated → alloc-free)
  private readonly acBuf: Float32Array // novelty history
  private readonly acLinear: Float32Array // scratch: chronological, mean-removed copy
  private readonly acScores: Float32Array // scratch: raw autocorr per lag (parabolic refine)
  private acHead = 0
  private acCount = 0
  private sinceAcUpdate = Infinity

  // timing / tempo / phase (LIVE path only — the demo path is fully independent)
  private avgDt = 1 / CFG.fpsNominal
  private _period = 60 / CFG.bpmPref // seconds per beat (= 0.5)
  private _phase = 0 // beatPhase, [0,1)
  private _confidence = 0 // lock quality, [0,1]
  private lastOnsetTime = -Infinity

  // demo path
  private demoIdx: number | null = null

  constructor() {
    this.thN = Math.round(CFG.thWinSec * CFG.fpsNominal)
    this.acN = Math.round(CFG.acWinSec * CFG.fpsNominal)
    this.thBuf = new Float32Array(this.thN)
    this.acBuf = new Float32Array(this.acN)
    this.acLinear = new Float32Array(this.acN)
    this.acScores = new Float32Array(this.acN + 1)
    this.reset()
  }

  get period(): number {
    return this._period
  }

  get phase(): number {
    return this._phase
  }

  get confidence(): number {
    return this._confidence
  }

  update(dt: number, time: number, signals: SignalsLike, demoMode: boolean): AudioEventResult {
    return demoMode ? this.updateDemo(time) : this.updateLive(dt, time, signals)
  }

  /** Restores cold-start state. Zeros preallocated buffers without reallocating. */
  reset(): void {
    this.prevBass = 0
    this.prevMid = 0
    this.prevHigh = 0
    this.firstFrame = true
    this.prevFlux = 0

    this.thBuf.fill(0)
    this.thHead = 0
    this.thCount = 0

    this.acBuf.fill(0)
    this.acLinear.fill(0)
    this.acScores.fill(0)
    this.acHead = 0
    this.acCount = 0
    this.sinceAcUpdate = Infinity

    this.avgDt = 1 / CFG.fpsNominal
    this._period = 60 / CFG.bpmPref
    this._phase = 0
    this._confidence = 0
    this.lastOnsetTime = -Infinity

    this.demoIdx = null
  }

  // --- DEMO path (docs/EVENTS.md §7) ------------------------------------------

  private updateDemo(time: number): AudioEventResult {
    const t2 = time * 2
    const idx = Math.floor(t2)
    const phase = t2 - idx // = fract(time*2)
    // First frame after reset: only exactly on a beat; otherwise any index change fires.
    const fired = this.demoIdx === null ? phase === 0 : idx !== this.demoIdx
    this.demoIdx = idx
    return { onset: fired, beat: fired, beatPhase: phase, onsetStrength: fired ? 1 : 0 }
  }

  // --- LIVE path (docs/EVENTS.md §5) ------------------------------------------

  private updateLive(dt: number, time: number, signals: SignalsLike): AudioEventResult {
    const bass = signals.get('bass', 0)
    const mid = signals.get('mid', 0)
    const high = signals.get('high', 0)

    // (1) Flux (band novelty).
    let flux: number
    if (this.firstFrame) {
      flux = 0
      this.firstFrame = false
    } else {
      flux =
        CFG.wBass * Math.max(0, bass - this.prevBass) +
        CFG.wMid * Math.max(0, mid - this.prevMid) +
        CFG.wHigh * Math.max(0, high - this.prevHigh)
    }
    this.prevBass = bass
    this.prevMid = mid
    this.prevHigh = high

    // (2) Adaptive threshold from the trailing window, excluding the current flux.
    let thr: number
    if (this.thCount === 0) {
      thr = CFG.floor
    } else {
      let mean = 0
      for (let i = 0; i < this.thCount; i++) mean += this.thBuf[i]
      mean /= this.thCount
      let variance = 0
      for (let i = 0; i < this.thCount; i++) {
        const d = this.thBuf[i] - mean
        variance += d * d
      }
      variance /= this.thCount
      thr = Math.max(CFG.floor, mean + CFG.k * Math.sqrt(variance))
    }

    // (3) Onset decision — rising edge over threshold, past refractory.
    const rising = flux > this.prevFlux
    const onset = flux > thr && rising && time - this.lastOnsetTime >= CFG.refractorySec
    if (onset) this.lastOnsetTime = time

    // (4) Push current flux into the threshold ring buffer; update prevFlux.
    this.thBuf[this.thHead] = flux
    this.thHead = (this.thHead + 1) % this.thN
    if (this.thCount < this.thN) this.thCount++
    this.prevFlux = flux

    // (5) Push flux into the autocorr buffer; update avgDt.
    this.acBuf[this.acHead] = flux
    this.acHead = (this.acHead + 1) % this.acN
    if (this.acCount < this.acN) this.acCount++
    this.avgDt += CFG.dtEma * (dt - this.avgDt)

    // (6) Periodic tempo estimate (throttled, once window ≥ 75% full).
    this.sinceAcUpdate += dt
    if (this.sinceAcUpdate >= CFG.acUpdateSec && this.acCount >= CFG.acFillFrac * this.acN) {
      this.sinceAcUpdate = 0
      this.estimateTempo()
    }

    // (7) PLL phase advance + beat pulse.
    let beat = false
    this._phase += dt / this._period
    if (this._phase >= 1) {
      this._phase -= Math.floor(this._phase) // floor() handles multi-wrap
      beat = true
    }

    // (8) Phase correction from onset (two-speed PLL; never gated off by confidence).
    if (onset) {
      let e = this._phase
      if (e > 0.5) e -= 1 // signed distance to nearest beat
      const g = CFG.kPhaseTrack + (CFG.kPhaseAcq - CFG.kPhaseTrack) * (1 - this._confidence)
      this._phase -= g * e
      this._phase = ((this._phase % 1) + 1) % 1 // wrap into [0,1)
      if (Math.abs(e) <= CFG.captureWin) {
        this._confidence = Math.min(1, this._confidence + CFG.confUp)
      } else {
        this._confidence = Math.max(0, this._confidence - CFG.confDown)
      }
    }

    // (9) Output.
    const onsetStrength = Math.min(1, flux / (2 * thr))

    return { onset, beat, beatPhase: this._phase, onsetStrength }
  }

  /** Autocorrelation → period (docs/EVENTS.md §6). Alloc-free: uses scratch fields only. */
  private estimateTempo(): void {
    const n = this.acCount

    // Linearize ring into acLinear chronologically; subtract mean.
    if (this.acCount < this.acN) {
      for (let i = 0; i < n; i++) this.acLinear[i] = this.acBuf[i]
    } else {
      for (let i = 0; i < this.acN; i++) this.acLinear[i] = this.acBuf[(this.acHead + i) % this.acN]
    }
    let mean = 0
    for (let i = 0; i < n; i++) mean += this.acLinear[i]
    mean /= n
    for (let i = 0; i < n; i++) this.acLinear[i] -= mean

    const fps = 1 / this.avgDt
    const lagMin = Math.max(2, Math.floor((60 / CFG.bpmMax) * fps))
    const lagMax = Math.min(n - 1, Math.ceil((60 / CFG.bpmMin) * fps))

    let bestLag = -1
    let bestWeighted = -Infinity
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let sum = 0
      for (let i = lag; i < n; i++) sum += this.acLinear[i] * this.acLinear[i - lag]
      const s = sum / (n - lag)
      this.acScores[lag] = s
      const bpm = 60 / (lag * this.avgDt)
      const w = Math.exp(-(Math.log2(bpm / CFG.bpmPref) ** 2) / (2 * CFG.bpmPrefSigma ** 2))
      const weighted = s * w
      if (weighted > bestWeighted) {
        bestWeighted = weighted
        bestLag = lag
      }
    }
    if (bestLag < 0 || bestWeighted <= 0) return // no positive best: leave period untouched

    // Parabolic peak interpolation → sub-frame lag (fixes high-tempo quantization).
    let lagRef = bestLag
    if (bestLag > lagMin && bestLag < lagMax) {
      const y0 = this.acScores[bestLag - 1]
      const y1 = this.acScores[bestLag]
      const y2 = this.acScores[bestLag + 1]
      const denom = y0 - 2 * y1 + y2
      if (denom !== 0) {
        const delta = (y0 - y2) / (2 * denom)
        if (Math.abs(delta) < 1) lagRef = bestLag + delta
      }
    }

    const newPeriod = lagRef * this.avgDt
    const ps = CFG.periodSmoothTrack + (CFG.periodSmoothAcq - CFG.periodSmoothTrack) * (1 - this._confidence)
    this._period += ps * (newPeriod - this._period)
    this._period = Math.min(60 / CFG.bpmMin, Math.max(60 / CFG.bpmMax, this._period))
  }
}
