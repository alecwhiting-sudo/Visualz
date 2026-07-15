/**
 * Offline whole-track audio analysis (docs/ANALYSIS.md). Pure function of
 * `(samples, sampleRate, opts)` — no `Date.now()`/`performance.now()`/
 * `Math.random()`/host access — so a session's stored `FeatureTimeline` replays
 * identically in live playback and export (ARCHITECTURE.md §1). This offline
 * pass produces strictly-better beat tracking than the live `AudioEventDetector`
 * (docs/EVENTS.md) because it sees the whole track (non-causal), at the cost of
 * needing the file up front.
 */

export interface AnalysisOpts {
  /** STFT frame size. Must match AnalyserNode's fftSize (2048) for band-value
   * parity with the live path. Default 2048. */
  frameSize?: number
  /** STFT hop size in samples. Default 512 (75% overlap at frameSize 2048). */
  hop?: number
  /**
   * Progress callback, invoked with a fraction in [0, 1] every ~256 STFT frames
   * during the front-end pass (the dominant cost). Purely observational — the
   * analysis output is bit-identical with or without it.
   */
  onProgress?: (fraction: number) => void
}

export interface FeatureTimeline {
  version: 1
  sampleRate: number
  /** Seconds per feature frame (`hop / sampleRate`). Frame `i`'s band values
   * are start-aligned: time `i * hopSec` (docs/ANALYSIS.md §3.3/§12). */
  hopSec: number
  frames: number
  rms: Float32Array
  bass: Float32Array
  mid: Float32Array
  high: Float32Array
  /** Full-spectrum log-flux novelty, normalized by its 99.5th-percentile value
   * and clamped to [0,1]. */
  onsetEnv: Float32Array
  /** Ascending onset times in seconds, window-center corrected (§3.3). */
  onsets: Float32Array
  /** Ascending beat times in seconds, window-center corrected (§3.3, §4.3). */
  beats: Float32Array
  /** `60 / median(inter-beat interval)`, or 0 if no beats were found. */
  bpm: number
}

// --- 0. Constants (docs/ANALYSIS.md §§1-4) ----------------------------------

const FRAME_SIZE = 2048
const HOP = 512

// Band chain (§2) — Chrome getByteFrequencyData replica.
const ALPHA = 0.78
const MIN_DB = -100
const MAX_DB = -30

// Novelty (§3.1).
const GAMMA = 1000

// Onset peak-picking (§3.2), validated F1=0.994 at 86.1Hz feature rate.
const PRE_MAX = 3
const POST_MAX = 3
const WIN_PRE = 12
const WIN_POST = 12
const ONSET_K = 1.8
const COMBINE_FRAMES = 4
const ONSET_FLOOR_SCALE = 1e-6

// Beat novelty bands (§4.1) — bin-count-normalized, bass-weighted.
const BEAT_BANDS = [
  { lo: 20, hi: 160, w: 1.0 },
  { lo: 160, hi: 2000, w: 0.6 },
  { lo: 2000, hi: 12000, w: 0.35 },
] as const

// Tempo autocorrelation (§4.2).
const BPM_MIN = 60
const BPM_MAX = 180
const BPM_PREF = 120
const BPM_PREF_SIGMA = 0.8

// Ellis 2007 global DP (§4.3).
const TIGHTNESS = 100

// Onset/beat normalization percentile (§5.5).
const NORMALIZE_PERCENTILE = 0.995

// --- 1. FFT (docs/ANALYSIS.md §1.1, verbatim) --------------------------------

/** Precompute once per size. re/im are Float64Array(N); transform is in-place. */
export function makeFFT(N: number): (re: Float64Array, im: Float64Array) => void {
  if ((N & (N - 1)) !== 0) throw new Error('N must be a power of 2')
  const levels = Math.log2(N)
  const rev = new Uint32Array(N)
  for (let i = 0; i < N; i++) {
    let x = i
    let r = 0
    for (let j = 0; j < levels; j++) {
      r = (r << 1) | (x & 1)
      x >>= 1
    }
    rev[i] = r
  }
  const cos = new Float64Array(N / 2)
  const sin = new Float64Array(N / 2)
  for (let i = 0; i < N / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / N)
    sin[i] = Math.sin((-2 * Math.PI * i) / N)
  }
  return (re, im) => {
    for (let i = 0; i < N; i++) {
      const j = rev[i]
      if (j > i) {
        let t = re[i]
        re[i] = re[j]
        re[j] = t
        t = im[i]
        im[i] = im[j]
        im[j] = t
      }
    }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1
      const step = N / size
      for (let i = 0; i < N; i += size) {
        for (let k = 0; k < half; k++) {
          const tw = k * step
          const c = cos[tw]
          const s = sin[tw]
          const a = i + k
          const b = a + half
          const rb = re[b] * c - im[b] * s
          const ib = re[b] * s + im[b] * c
          re[b] = re[a] - rb
          im[b] = im[a] - ib
          re[a] += rb
          im[a] += ib
        }
      }
    }
  }
}

/** Blackman window (a0=0.42, a1=0.5, a2=0.08), denominator N (matches Chrome). */
export function blackmanWindow(N: number): Float64Array {
  const w = new Float64Array(N)
  for (let n = 0; n < N; n++) {
    w[n] = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / N) + 0.08 * Math.cos((4 * Math.PI * n) / N)
  }
  return w
}

// --- helpers ------------------------------------------------------------

interface BinRange {
  lo: number
  hi: number
}

function binRange(loHz: number, hiHz: number, binHz: number, half: number): BinRange {
  const lo = Math.max(0, Math.floor(loHz / binHz))
  const hi = Math.min(half - 1, Math.ceil(hiHz / binHz))
  return { lo, hi }
}

function bandValue(byte: Float64Array, r: BinRange): number {
  let sum = 0
  for (let k = r.lo; k <= r.hi; k++) sum += byte[k]
  return sum / ((r.hi - r.lo + 1) * 255)
}

function percentile(sortedAsc: Float64Array, p: number): number {
  const n = sortedAsc.length
  if (n === 0) return 0
  const idx = Math.min(n - 1, Math.max(0, Math.floor(p * n)))
  return sortedAsc[idx]
}

function median(values: number[]): number {
  const n = values.length
  if (n === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = Math.floor(n / 2)
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

// --- 3.2 Onset peak-picking --------------------------------------------------

/** Returns onset frame indices (into `env`), per docs/ANALYSIS.md §3.2. */
function pickPeaks(env: Float32Array): number[] {
  const n = env.length
  let globalMax = 0
  for (let i = 0; i < n; i++) if (env[i] > globalMax) globalMax = env[i]
  const floor = ONSET_FLOOR_SCALE * globalMax

  const onsets: number[] = []
  let lastOnsetFrame = -Infinity
  for (let m = 0; m < n; m++) {
    const loM = Math.max(0, m - PRE_MAX)
    const hiM = Math.min(n - 1, m + POST_MAX)
    let isMax = true
    for (let i = loM; i <= hiM; i++) {
      if (env[i] > env[m]) {
        isMax = false
        break
      }
    }
    if (!isMax) continue

    const loW = Math.max(0, m - WIN_PRE)
    const hiW = Math.min(n - 1, m + WIN_POST)
    let mean = 0
    let cnt = 0
    for (let i = loW; i <= hiW; i++) {
      mean += env[i]
      cnt++
    }
    mean /= cnt
    let variance = 0
    for (let i = loW; i <= hiW; i++) {
      const d = env[i] - mean
      variance += d * d
    }
    variance /= cnt
    const threshold = mean + ONSET_K * Math.sqrt(variance)

    if (env[m] >= threshold && env[m] > floor && m - lastOnsetFrame >= COMBINE_FRAMES) {
      onsets.push(m)
      lastOnsetFrame = m
    }
  }
  return onsets
}

// --- 4.2 Tempo estimation ----------------------------------------------------

interface TempoEstimate {
  /** Sub-frame period, in feature frames. */
  periodFrames: number
}

function estimateTempo(beatNov: Float32Array, hopSec: number): TempoEstimate | null {
  const n = beatNov.length
  if (n < 2) return null

  let mean = 0
  for (let i = 0; i < n; i++) mean += beatNov[i]
  mean /= n
  const x = new Float64Array(n)
  for (let i = 0; i < n; i++) x[i] = beatNov[i] - mean

  const lagMin = Math.max(2, Math.floor(60 / BPM_MAX / hopSec))
  const lagMax = Math.min(n - 1, Math.ceil(60 / BPM_MIN / hopSec))
  if (lagMax < lagMin) return null

  const scores = new Float64Array(lagMax + 2)
  let bestScore = 0
  let bestLag = -1
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let sum = 0
    for (let i = lag; i < n; i++) sum += x[i] * x[i - lag]
    const s = sum / (n - lag)
    scores[lag] = s
    const bpm = 60 / (lag * hopSec)
    const w = Math.exp(-(Math.log2(bpm / BPM_PREF) ** 2) / (2 * BPM_PREF_SIGMA ** 2))
    const weighted = s * w
    if (weighted > bestScore) {
      bestScore = weighted
      bestLag = lag
    }
  }
  if (bestLag < 0) return null

  let lagRef = bestLag
  if (bestLag > lagMin && bestLag < lagMax) {
    const y0 = scores[bestLag - 1]
    const y1 = scores[bestLag]
    const y2 = scores[bestLag + 1]
    const denom = y0 - 2 * y1 + y2
    if (denom !== 0) {
      const delta = (y0 - y2) / (2 * denom)
      if (Math.abs(delta) < 1) lagRef = bestLag + delta
    }
  }

  return { periodFrames: lagRef }
}

// --- 4.3 Ellis 2007 global DP -------------------------------------------------

/** Returns beat frame indices (into `beatNov`, non-integer positions rounded
 * by construction since DP operates on integer frame indices). */
function ellisBeatTrack(beatNov: Float32Array, tau: number): number[] {
  const n = beatNov.length
  if (n === 0) return []

  const loOff = Math.round(tau / 2)
  const hiOff = Math.round(2 * tau)
  const C = new Float64Array(n)
  const B = new Int32Array(n).fill(-1)

  for (let t = 0; t < n; t++) {
    const loTp = Math.max(0, t - hiOff)
    const hiTp = t - loOff
    let best = -Infinity
    let bestTp = -1
    for (let tp = loTp; tp <= hiTp; tp++) {
      const delta = (t - tp) / tau
      const cost = C[tp] - TIGHTNESS * Math.log(delta) ** 2
      if (cost > best) {
        best = cost
        bestTp = tp
      }
    }
    C[t] = beatNov[t] + (bestTp >= 0 ? best : 0)
    B[t] = bestTp
  }

  const startT = Math.max(0, n - Math.round(tau) - 1)
  let endT = startT
  let bestC = -Infinity
  for (let t = startT; t < n; t++) {
    if (C[t] > bestC) {
      bestC = C[t]
      endT = t
    }
  }

  const path: number[] = []
  let t = endT
  while (t >= 0) {
    path.push(t)
    t = B[t]
  }
  path.reverse()
  return path
}

// --- 5. analyzeAudio (evaluation order) --------------------------------------

export function analyzeAudio(samples: Float32Array, sampleRate: number, opts: AnalysisOpts = {}): FeatureTimeline {
  const N = opts.frameSize ?? FRAME_SIZE
  const hop = opts.hop ?? HOP
  const half = N / 2
  const hopSec = hop / sampleRate
  const nFrames = Math.max(0, Math.floor((samples.length - N) / hop) + 1)

  const fft = makeFFT(N)
  const window = blackmanWindow(N)
  const nyquist = sampleRate / 2
  const binHz = nyquist / half

  const rms = new Float32Array(nFrames)
  const bass = new Float32Array(nFrames)
  const mid = new Float32Array(nFrames)
  const high = new Float32Array(nFrames)
  const onsetEnvRaw = new Float32Array(nFrames)
  const beatNov = new Float32Array(nFrames)

  if (nFrames === 0) {
    return {
      version: 1,
      sampleRate,
      hopSec,
      frames: 0,
      rms,
      bass,
      mid,
      high,
      onsetEnv: onsetEnvRaw,
      onsets: new Float32Array(0),
      beats: new Float32Array(0),
      bpm: 0,
    }
  }

  const bassRange = binRange(20, 160, binHz, half)
  const midRange = binRange(160, 2000, binHz, half)
  const highRange = binRange(2000, 12000, binHz, half)
  const beatBandRanges = BEAT_BANDS.map((b) => ({ ...binRange(b.lo, b.hi, binHz, half), w: b.w }))

  // Cross-frame state (§2, §3.1) — the only persistent arrays across frames.
  const smMag = new Float64Array(half)
  const compPrev = new Float64Array(half)

  // Per-frame scratch (alloc-free across the frame loop).
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  const mag = new Float64Array(half)
  const byte = new Float64Array(half)
  const diffs = new Float64Array(half)

  const onProgress = opts.onProgress
  for (let f = 0; f < nFrames; f++) {
    if (onProgress && (f & 255) === 0) onProgress(f / nFrames)
    const off = f * hop
    for (let i = 0; i < N; i++) {
      re[i] = samples[off + i] * window[i]
      im[i] = 0
    }
    fft(re, im)

    for (let k = 0; k < half; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / N
      mag[k] = m
      smMag[k] = ALPHA * smMag[k] + (1 - ALPHA) * m
      const db = 20 * Math.log10(smMag[k] + 1e-30)
      let b = Math.round((255 / (MAX_DB - MIN_DB)) * (db - MIN_DB))
      if (b < 0) b = 0
      else if (b > 255) b = 255
      byte[k] = b
    }

    bass[f] = bandValue(byte, bassRange)
    mid[f] = bandValue(byte, midRange)
    high[f] = bandValue(byte, highRange)

    let sumSq = 0
    for (let k = 0; k < half; k++) sumSq += byte[k] * byte[k]
    rms[f] = Math.sqrt(sumSq / half) / 255

    // Novelty (§3.1): comp[k] on UNSMOOTHED mag; positive first-difference.
    let flux = 0
    for (let k = 0; k < half; k++) {
      const comp = Math.log(1 + GAMMA * mag[k])
      const d = comp - compPrev[k]
      const pos = d > 0 ? d : 0
      diffs[k] = pos
      flux += pos
      compPrev[k] = comp
    }
    onsetEnvRaw[f] = flux

    // Beat novelty (§4.1): band-averaged, bass-weighted, from the same diffs.
    let bn = 0
    for (const band of beatBandRanges) {
      let s = 0
      for (let k = band.lo; k <= band.hi; k++) s += diffs[k]
      bn += band.w * (s / (band.hi - band.lo + 1))
    }
    beatNov[f] = bn
  }

  // 3. Peak-pick onsetEnv (raw) → onsets, center-corrected.
  const onsetFrames = pickPeaks(onsetEnvRaw)
  const onsets = new Float32Array(onsetFrames.length)
  for (let i = 0; i < onsetFrames.length; i++) {
    onsets[i] = (onsetFrames[i] * hop + N / 2) / sampleRate
  }

  // 4. Tempo → Ellis DP → beats, bpm.
  const tempo = estimateTempo(beatNov, hopSec)
  let beats: Float32Array
  let bpm: number
  if (tempo === null) {
    beats = new Float32Array(0)
    bpm = 0
  } else {
    const beatFrames = ellisBeatTrack(beatNov, tempo.periodFrames)
    beats = new Float32Array(beatFrames.length)
    for (let i = 0; i < beatFrames.length; i++) {
      beats[i] = (beatFrames[i] * hop + N / 2) / sampleRate
    }
    if (beats.length >= 2) {
      const intervals: number[] = []
      for (let i = 1; i < beats.length; i++) intervals.push(beats[i] - beats[i - 1])
      bpm = 60 / median(intervals)
    } else if (beats.length === 1) {
      bpm = 60 / (tempo.periodFrames * hopSec)
    } else {
      bpm = 0
    }
  }

  // 5. Normalize stored onsetEnv by p99.5, clamp [0,1].
  const sortedForPercentile = Float64Array.from(onsetEnvRaw).sort()
  const p995 = percentile(sortedForPercentile, NORMALIZE_PERCENTILE)
  const onsetEnv = new Float32Array(nFrames)
  if (p995 > 0) {
    for (let f = 0; f < nFrames; f++) {
      const v = onsetEnvRaw[f] / p995
      onsetEnv[f] = v < 0 ? 0 : v > 1 ? 1 : v
    }
  }

  return { version: 1, sampleRate, hopSec, frames: nFrames, rms, bass, mid, high, onsetEnv, onsets, beats, bpm }
}
