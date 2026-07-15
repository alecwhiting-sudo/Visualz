# Offline Audio Analysis Pass — v1 Specification

Design by the reasoner tier (2026-07-15), accepted by the architect. Target files:
`src/audio/analysis.ts` (pure, node-testable), `src/audio/timeline.ts` (lookup +
serialization). Companion to `docs/EVENTS.md` — this offline pass replaces the
AnalyserNode file path with precomputed feature timelines: deterministic by
construction, strictly better beat tracking (whole-track, non-causal).

All numbers validated in design-time scratch prototypes (§10).

## 0. Decisions

| Fork | Decision | Why |
|---|---|---|
| FFT | Self-contained iterative radix-2 Cooley–Tukey, precomputed bit-reversal + twiddles, in-place, complex with zero imaginary input | Zero deps; exact (impulse error 0, Parseval holds); 1527ms front-end for a 3-min track |
| frameSize | **2048** | Must equal AnalyserNode `fftSize=2048` or band values don't match (at 1024 bass reads 0.958 vs the analyser's 0.656) |
| hopSize | **512** (75% overlap) | Feature rate 44100/512 = **86.1 Hz** ≫ 60fps; hop quantization ±5.8ms well under the 20ms beat target |
| Window | **Blackman** (a0=0.42, a1=0.5, a2=0.08), shared by band + novelty | Band-matching requires the analyser's Blackman window; also improved onset F1 and beat error vs Hann. One window ⇒ one FFT pass |
| Band chain | Replicate Chrome `getByteFrequencyData` exactly: linear-mag → 1/N scale → time-EMA → dB → [-100,-30]→[0,255] byte → /255 → band average | `bass/mid/high` behave identically via analyser or timeline |
| Novelty | **Two** curves from one FFT: full-spectrum log-flux (→ onsets, stored `onsetEnv`) + band-averaged bass-weighted flux (→ tempo + beats, internal) | Full-spectrum flux over-weights broadband hi-hats by bin count (928 high bins vs 13 bass) and locks beats onto offbeats |
| Onset picker | Scale-invariant local-max + `mean + k·std` adaptive threshold | F1=0.994, invariant to a 3× loud section, insensitive to k∈[1.5,2.2] |
| Beat tracker | Autocorrelation tempo (log-Gaussian 120-BPM prior, same as EVENTS.md) → **Ellis 2007 global DP** | Non-causal whole-track optimum; follows moderate drift via soft transition penalty |

## 1. STFT front-end

### 1.1 FFT (validated: impulse→flat maxErr 0.0, cosine→peak exactly N/2, leakage 1.7e-12, Parseval exact)

```ts
// Precompute once per size. re/im are Float64Array(N); transform is in-place.
function makeFFT(N: number): (re: Float64Array, im: Float64Array) => void {
  if ((N & (N - 1)) !== 0) throw new Error('N must be a power of 2')
  const levels = Math.log2(N)
  const rev = new Uint32Array(N)
  for (let i = 0; i < N; i++) { let x = i, r = 0; for (let j = 0; j < levels; j++){ r=(r<<1)|(x&1); x>>=1 } rev[i]=r }
  const cos = new Float64Array(N/2), sin = new Float64Array(N/2)
  for (let i = 0; i < N/2; i++){ cos[i]=Math.cos(-2*Math.PI*i/N); sin[i]=Math.sin(-2*Math.PI*i/N) }
  return (re, im) => {
    for (let i = 0; i < N; i++){ const j=rev[i]; if(j>i){ let t=re[i];re[i]=re[j];re[j]=t; t=im[i];im[i]=im[j];im[j]=t } }
    for (let size = 2; size <= N; size <<= 1){
      const half = size>>1, step = N/size
      for (let i = 0; i < N; i += size)
        for (let k = 0; k < half; k++){
          const tw=k*step, c=cos[tw], s=sin[tw], a=i+k, b=a+half
          const rb=re[b]*c-im[b]*s, ib=re[b]*s+im[b]*c
          re[b]=re[a]-rb; im[b]=im[a]-ib; re[a]+=rb; im[a]+=ib
        }
    }
  }
}
```
(An RFFT optimization is possible later; the complex FFT already meets budget — ship it.)

**Window** (Blackman, denominator N not N−1, matching Chrome):
`w[n] = 0.42 − 0.5·cos(2πn/N) + 0.08·cos(4πn/N)`, precomputed `Float64Array(N)`.

### 1.2 Single pass

`nFrames = floor((samples.length − N) / HOP) + 1`. For each frame `f` at `off = f·HOP`:
window into `re`, zero `im`, FFT, derive ALL features from that one spectrum (bands,
both novelties, rms). Frame `f`'s band value stores at index `f` (time `f·hopSec`,
`hopSec = HOP/sampleRate`). Arbitrary sampleRate works: everything is expressed via
`binHz = sampleRate/2 / (N/2)` and seconds.

## 2. Band features — analyser-exact

Replicate Chrome's `getByteFrequencyData` from linear magnitudes. Constants:
`MIN_DB=-100`, `MAX_DB=-30`, magnitude scale `1/N`.

Per frame, per bin `k∈[0,N/2)`:
```
mag[k]   = sqrt(re[k]² + im[k]²) / N          // 1/N normalization
smMag[k] = ALPHA·smMag[k] + (1−ALPHA)·mag[k]  // time-EMA on LINEAR magnitude
db       = 20·log10(smMag[k] + 1e-30)
byte     = clamp(round( 255/(MAX_DB−MIN_DB) · (db − MIN_DB) ), 0, 255)
```
`smMag` is a persistent `Float64Array(N/2)` across frames (the only cross-frame band state).

**EMA rate-match — `ALPHA = 0.78`.** The analyser applies 0.7 retention per render frame
(~60fps → τ = −(1/60)/ln 0.7 = 46.7ms). Offline runs at 86.1Hz, so
`ALPHA = 0.7^((1/86.1)/(1/60)) = 0.780`. Smoothing in the LINEAR domain (before dB),
exactly like the analyser.

**Band values** (same formula as src/audio/engine.ts):
```
band(loHz,hiHz): lo=max(0,floor(loHz/binHz)); hi=min(N/2−1,ceil(hiHz/binHz))
                 bass:(20,160)  mid:(160,2000)  high:(2000,12000)
                 value = (Σ_{k=lo..hi} byte[k]) / ((hi−lo+1)·255)
rms:  sqrt( (Σ byte[k]²) / (N/2) ) / 255
```

Validation: peak-bin byte for a bin-centered tone measured 255/255/242 for A=1.0/0.5/0.1 —
matches analytic `byte(20·log10(0.21·A))` exactly (Blackman coherent gain 0.42, /2
one-sided, ×1/N). Band separation and silence→0 verified (§10).

## 3. Onset detection

### 3.1 Novelty (stored as `onsetEnv`) — full-spectrum log-flux, `GAMMA=1000`
```
comp[k] = log(1 + GAMMA·mag[k])              // mag unsmoothed
flux    = Σ_k max(0, comp[k] − compPrev[k])  // half-wave-rectified spectral flux
compPrev ← comp
onsetEnv[f] = flux
```
Stored normalized: copy divided by the 99.5th-percentile value, clamped [0,1]
(peak-picking below runs on the raw curve; scale-invariant either way).

### 3.2 Peak-picking (validated F1=0.994)
At 86.1Hz feature rate:
```
preMax = postMax = 3     // ±35ms local-max window
winPre = winPost = 12    // ±140ms stats window
k      = 1.8             // threshold = localMean + k·localStd
combine = 4 frames       // ~46ms refractory
floor  = 1e-6 · globalMax(onsetEnv)   // silence guard
```
Frame `m` is an onset iff: max over `[m−preMax, m+postMax]`; `≥ mean+k·std` over
`[m−winPre, m+winPost]`; `> floor`; and `m − lastOnsetFrame ≥ combine`.
Emit time **`(m·HOP + N/2)/sampleRate`** (§3.3).

### 3.3 Window-center time correction
A transient peaks the flux when centered in the window, so the peak frame's START time
lags the true onset ~N/2 samples. Reporting onset/beat times as
`(f·HOP + N/2)/sampleRate` removed a systematic ~23ms lag (31ms → 9ms median). Applies
to `onsets`/`beats` arrays only; band features stay start-aligned (`frame i ↔ i·hopSec`).

## 4. Beat tracking

### 4.1 Beat novelty (internal) — band-averaged, bass-weighted
Full-spectrum flux locks beats onto hi-hats (hat novelty 0.81 vs kick 0.18 — high bands
have ~70× more bins). Collapse each band to a bin-count-normalized flux, weight with the
EVENTS.md coefficients:
```
bands = [ (20,160, wBass=1.0), (160,2000, wMid=0.6), (2000,12000, wHigh=0.35) ]
beatNov[f] = Σ_band  w · ( Σ_{k∈band} max(0, comp[k]−compPrev[k]) ) / binsInBand
```

### 4.2 Tempo — autocorrelation with log-Gaussian 120 prior (same as EVENTS.md §6)
Mean-remove `beatNov` → `x`. `lagMin = max(2, floor((60/180)/hopSec))`,
`lagMax = min(n−1, ceil((60/60)/hopSec))`.
```
for lag in [lagMin, lagMax]:
   s = ( Σ_{i=lag..n−1} x[i]·x[i−lag] ) / (n − lag)
   w = exp( −(log2(bpm/120))² / (2·0.8²) )    // bpm = 60/(lag·hopSec)
   track argmax of s·w  (require strictly > 0)
parabolic-interpolate the winning lag → sub-frame periodFrames
```
Silence guard: `bestScore` starts at 0, update only on `s·w > bestScore`; silence → no
winner → `beats=[]`, `bpm=0`.

### 4.3 Global beat placement — Ellis 2007 DP (validated ≤8ms median)
`tau = periodFrames`, `tightness = 100`:
```
loOff = round(tau/2);  hiOff = round(2·tau)
for t in [0, n):
   best over tp in [t−hiOff, t−loOff] (tp ≥ 0) of:
     C[tp] − tightness·(log((t−tp)/tau))²
   C[t] = beatNov[t] + (best or 0)
   B[t] = argmax tp (or −1)
```
Backtrack from `endT = argmax C[t]` over `t ∈ [n−round(tau)−1, n)`; reverse; beat times
`(frame·HOP + N/2)/sampleRate`. The soft log² penalty follows moderate drift (120→126 BPM
tracked to 7.5ms median). `bpm = 60 / median(inter-beat intervals)`.

## 5. Evaluation order (analyzeAudio)

1. `makeFFT(2048)`, Blackman window, allocate `smMag` and `compPrev` (Float64Array(1024), zeroed).
2. One STFT pass → `rms, bass, mid, high, onsetEnv` (start-aligned) + `beatNov` (internal).
3. Peak-pick `onsetEnv` → `onsets` (center-corrected seconds).
4. `estimateTempo(beatNov)`; null → `beats=[]`, `bpm=0`; else DP → `beats`, `bpm`.
5. Normalize stored `onsetEnv` by p99.5, clamp [0,1].
6. Assemble `FeatureTimeline`.

## 6. sampleTimeline — lookup semantics (pure; seeks free)

Interface:
```ts
export interface TimelineSample {
  rms: number; bass: number; mid: number; high: number
  onset: number; beat: number; beatPhase: number; onsetStrength: number
}
export function sampleTimeline(tl: FeatureTimeline, time: number, dt: number): TimelineSample
```

**Bands (linear interpolation):** `x = time/hopSec`; clamp to [0, frames−1]; lerp
adjacent frames. Applies to rms/bass/mid/high; `onsetStrength` = same on normalized
`onsetEnv`.

**Pulses (`onset`, `beat`) — half-open `(time−dt, time]`, exactly-once:**
`fire = (countEventsLE(time) > countEventsLE(time−dt)) ? 1 : 0` via binary search.
Under fixed-dt stepping intervals tile the axis: each event fires exactly once
(validated: 40 beats → 40 pulses, 0 double-fires). `dt=0` → empty interval → 0.
Two events inside one dt → one pulse (boolean; documented, matches EVENTS.md).
CONTRACT NOTE: correctness requires the caller pass `dt` = true elapsed time since the
previous sample; the Transport guarantees this.

**beatPhase — 0→1 sawtooth, resets on each beat:**
```
no beats → 0;  time < beats[0] → 0;  time ≥ beats[last] → 1
else find beats[i] ≤ time < beats[i+1]: (time − beats[i]) / (beats[i+1] − beats[i])
```

## 7. Serialization

```ts
serializeTimeline(tl) -> {
  version: 1, sampleRate, hopSec, frames, bpm,
  rms, bass, mid, high, onsetEnv, onsets, beats   // base64 of each Float32Array's bytes (LE)
}
```
Raw byte copy → bit-exact round-trip. `parseTimeline` validates: version===1; scalars
finite (frames non-negative int); each base64 field decodes to byteLength % 4 === 0;
per-frame arrays decode to exactly `frames` floats; onsets/beats ascending + finite;
descriptive Errors (mirror session/serialize.ts style).

Size for 3-min 44.1k (15,500 frames): 5×15,500×4B ≈ 310KB raw → **≈415KB base64** in
session JSON. Acceptable for v1.

## 8. Performance

Front-end 1527ms measured (node) for 3-min 44.1k; picking/autocorr/DP < 50ms combined.
Total < 1.6s, under the ~2s budget. Use `Math.sqrt`, NOT `Math.hypot` (+575ms).

## 9. Determinism

Pure function of `(samples, sampleRate, opts)` — no Date/performance/Math.random/host
access. Tests assert: two runs → bit-identical output buffers.

## 10. Design-time validation results

| Fixture | Result | Target |
|---|---|---|
| 120 BPM kicks+hats+noise — beat error | median 6.1ms, max 13.1ms | ≤20ms med, ≤50ms all ✓ |
| onset P/R/F1 | 0.988 / 1.000 / 0.994 | F1 ≥ 0.9 ✓ |
| + 3× loud section — onset F1 | 0.994 (identical) | robust ✓ |
| tempo drift 120→126 | median 7.5ms, 100% ≤50ms; tempo 123.07 | ✓ |
| tones per band | bass 0.666/0.013/0; mid 0/0.072/0; high 0/0/0.017 | clean ✓ |
| peak-bin byte vs analytic | 255/255/242 exact | ✓ |
| silence | 0 onsets, 0 beats | ✓ |
| 90 / 150 BPM | median 8.0 / 7.1ms; tempo 90.11 / 150.20 | ✓ |
| pulse exactly-once @60fps | 40/40, 0 double-fires | ✓ |

## 11. Unit test cases

See `tests/unit/analysis.test.ts` — 22 cases from the design review: FFT (impulse flat,
sine single-bin peak N/2, Parseval), bands (byte 242 at A=0.1, band separation, silence,
EMA convergence), onsets (single kick ±2 frames, 40ms refractory combine, 120ms distinct,
F1 ≥ 0.95, loudness invariance), beats (120 BPM ≤20ms, 90/150 no octave error, silence
empty), sampleTimeline (exactly-once pulses, dt=0, beatPhase edges, purity/seek), 
serialization (bit-exact round-trip, 5 rejection cases), determinism (bit-identical runs).

## 12. Accepted design flags

1. Band frames are start-aligned; `onsets`/`beats` carry a +N/2/sampleRate ≈ 23ms
   window-center correction — benign for smooth envelopes; add a `frameCenterSec` field
   later only if exact co-alignment is ever needed.
2. `sampleTimeline` pulse contract: `dt` must be true elapsed time (doc-commented).
3. Scalar `bpm` is lossy for drifting tracks; the `beats` array carries per-beat tempo
   implicitly — fine for v1, a timeline editor can derive it.
4. Float32 absolute-second event times resolve ~0.04ms at 10min — fine.
