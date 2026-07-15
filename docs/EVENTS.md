# Audio Event Detection — v1 Specification

Design by the reasoner tier (2026-07-15), accepted by the architect. Target file:
`src/audio/events.ts`. Numerically validated in a scratch prototype (results §8).

## 1. Interface (fixed)

```ts
class AudioEventDetector {
  update(
    dt: number, time: number,
    signals: { get(name: string, fallback?: number): number },
    demoMode: boolean
  ): { onset: boolean; beat: boolean; beatPhase: number; onsetStrength: number }
  reset(): void
}
```

Wire-up: the engine reads `bass/mid/high` from the SignalBus, calls `update`, and writes
the four returned values back onto the bus as `onset`, `beat`, `beatPhase`,
`onsetStrength`. Demo mode (no audio) sets `demoMode = true`.

## 2. Design overview

Two fully independent paths selected by `demoMode`:

- **DEMO path** — pure analytic function of `time` at 120 BPM. Beats/onsets fire exactly
  when `floor(time*2)` increments; `beatPhase = fract(time*2)`. Deterministic and
  seek-safe → stable golden tests.
- **LIVE path** — spectral-flux onset detection on band energies + lightweight
  autocorrelation tempo estimator driving a two-speed phase-locked loop (PLL). Onset is
  the raw percussive event; beat is the steady tempo-locked metronome.

The AnalyserNode's `smoothingTimeConstant = 0.7` pre-smooths the bands (kick rise spread
over ~3–4 frames, largest jump on the first rise frame). No additional flux smoothing —
it would only add latency. Bias toward strong low-frequency events (bass-weighted flux):
false positives hurt more than missed hi-hats.

## 3. Exact constants (final, tuned)

```ts
const CFG = {
  // flux (band novelty)
  wBass: 1.0, wMid: 0.6, wHigh: 0.35,   // band weights on positive first-difference

  // adaptive threshold
  thWinSec: 1.0,        // trailing stats window → 60 frames @60fps
  k: 2.2,               // threshold = mean + k·std
  floor: 0.012,         // minimum threshold (silence guard)

  // refractory
  refractorySec: 0.10,  // min inter-onset interval (~6 frames)

  // tempo (autocorrelation)
  acWinSec: 2.5,        // novelty history window → 150 frames @60fps
  acUpdateSec: 0.15,    // recompute cadence
  acFillFrac: 0.75,     // window fill fraction required before first estimate
  bpmMin: 60, bpmMax: 180, bpmPref: 120, bpmPrefSigma: 0.8,  // log-tempo preference
  periodSmoothAcq: 0.5, periodSmoothTrack: 0.15,             // period EMA (unlocked/locked)

  // phase-locked loop
  kPhaseAcq: 0.5,       // phase-correction gain while unlocked (fast acquire)
  kPhaseTrack: 0.12,    // phase-correction gain when locked
  captureWin: 0.18,     // |phase-error| ≤ this counts as on-beat evidence
  confUp: 0.10, confDown: 0.05,  // confidence increments

  // misc
  dtEma: 0.05,          // dt EMA → running fps for lag↔seconds conversion
  fpsNominal: 60,       // ring-buffer sizing only
}
```

Ring buffers sized at construction from `fpsNominal`: `thN = 60`, `acN = 150`. The tempo
estimator converts lags→seconds through measured `avgDt`, so BPM is correct at any fps.

## 4. State layout (all reset in `reset()`)

```ts
// band history
prevBass, prevMid, prevHigh: number = 0
firstFrame: boolean = true
prevFlux: number = 0

// threshold ring buffer (preallocated)
thBuf: Float32Array(thN); thHead = 0; thCount = 0

// autocorrelation novelty ring buffer + scratch (all preallocated → alloc-free)
acBuf: Float32Array(acN)       // novelty history
acLinear: Float32Array(acN)    // scratch: chronological, mean-removed copy
acScores: Float32Array(acN+1)  // scratch: raw autocorr per lag (parabolic refine)
acHead = 0; acCount = 0
sinceAcUpdate: number = +Infinity

// timing / tempo / phase
avgDt: number = 1/fpsNominal
period: number = 60 / bpmPref  // seconds per beat (= 0.5)
phase: number = 0              // beatPhase, [0,1)
confidence: number = 0         // lock quality, [0,1]
lastOnsetTime: number = -Infinity

// demo path
demoIdx: number | null = null
```

Typed arrays allocated in the constructor; `reset()` zeros indices/counters and scalars.
No per-frame allocation anywhere.

## 5. Update — evaluation order (LIVE path)

Read `bass/mid/high` from signals, then in this exact order:

**(1) Flux (band novelty).**
```
if firstFrame:  flux = 0;  firstFrame = false
else:           flux = wBass·max(0,bass−prevBass)
                     + wMid ·max(0,mid −prevMid )
                     + wHigh·max(0,high−prevHigh)
prevBass=bass; prevMid=mid; prevHigh=high
```

**(2) Adaptive threshold** from the trailing window, **excluding the current flux**:
```
if thCount == 0:  thr = floor
else:
  mean = Σ thBuf[0..thCount) / thCount
  std  = sqrt( Σ (thBuf[i]−mean)² / thCount )
  thr  = max(floor, mean + k·std)
```

**(3) Onset decision** — rising edge over threshold, past refractory:
```
rising = flux > prevFlux
onset  = (flux > thr) AND rising AND (time − lastOnsetTime ≥ refractorySec)
if onset:  lastOnsetTime = time
```

**(4) Push current flux into the threshold ring buffer**; set `prevFlux = flux`.

**(5) Push flux into the autocorr buffer; update `avgDt`:**
```
avgDt += dtEma·(dt − avgDt)
```

**(6) Periodic tempo estimate** (throttled, once window ≥ 75% full):
```
sinceAcUpdate += dt
if sinceAcUpdate ≥ acUpdateSec AND acCount ≥ acFillFrac·acN:
    sinceAcUpdate = 0; estimateTempo()   // §6
```

**(7) PLL phase advance + beat pulse:**
```
beat = false
phase += dt / period
if phase ≥ 1:  phase −= floor(phase);  beat = true   // floor() handles multi-wrap
```

**(8) Phase correction from onset** (two-speed PLL; correction is NEVER gated off by
confidence — that would deadlock a wrong early phase):
```
if onset:
  e = phase;  if e > 0.5: e −= 1            // signed distance to nearest beat
  g = kPhaseTrack + (kPhaseAcq − kPhaseTrack)·(1 − confidence)
  phase −= g·e;  wrap into [0,1)
  if |e| ≤ captureWin:  confidence = min(1, confidence + confUp)
  else:                 confidence = max(0, confidence − confDown)
```

**(9) Output:** `onsetStrength = min(1, flux / (2·thr))`.

Order rationale: threshold reads the buffer before the current flux is pushed (a spike
doesn't inflate its own threshold); the beat pulse computes before phase correction (beats
stay on the metronome grid; onsets nudge the grid).

## 6. `estimateTempo()` (autocorrelation → period)

```
n = acCount
linearize ring into acLinear chronologically; subtract mean
fps    = 1 / avgDt
lagMin = max(2, floor((60/bpmMax)·fps))
lagMax = min(n−1, ceil((60/bpmMin)·fps))

for lag in lagMin..lagMax:
    s = ( Σ_{i=lag..n} acLinear[i]·acLinear[i−lag] ) / (n − lag)
    acScores[lag] = s
    bpm = 60 / (lag·avgDt)
    w   = exp( −(log2(bpm/bpmPref))² / (2·bpmPrefSigma²) )   // log-tempo preference
    best = argmax of s·w
if no positive best: return

// parabolic peak interpolation → sub-frame lag (fixes high-tempo quantization)
lagRef = bestLag refined by (y0−y2)/(2·(y0−2y1+y2)) when interior and |delta|<1

newPeriod = lagRef · avgDt
ps = periodSmoothTrack + (periodSmoothAcq − periodSmoothTrack)·(1 − confidence)
period += ps·(newPeriod − period)
period = clamp(period, 60/bpmMax, 60/bpmMin)
```

Octave correction via the log₂-Gaussian weight centered at 120 BPM (σ=0.8: validated to
keep 170 BPM from halving without doubling 60 BPM). Cost ~6k mults per 0.15s.

## 7. DEMO path (exact, deterministic, seek-safe)

```
t2 = time · 2
idx = floor(t2)
phase = t2 − idx                              // = fract(time·2)
if demoIdx === null:  fired = (phase === 0)   // first frame after reset: only exactly on a beat
else:                 fired = (idx !== demoIdx)
demoIdx = idx
return { onset: fired, beat: fired, beatPhase: phase, onsetStrength: fired ? 1 : 0 }
```

Beats at `time = 0, 0.5, 1.0, …` (120 BPM). `onset === beat` in demo mode.

## 8. Validation results (design-time prototype)

Kicks (exp decay τ=55ms) + offbeat hats + uniform noise through simulated 0.7 analyser
EMA; onset = hit within ±50ms; deterministic seeded noise.

| Scenario | Detect rate | False pos | Beat lock |
|---|---|---|---|
| 120 BPM, noise 0.05, hats | 97.5% | 1/20s | 1.0s |
| 90 BPM | 96.7% | 1/20s | 3.3s |
| 150 BPM | 98.0% | 1/20s | 2.4s |
| Loud section 8–12s | 97.5% | 1/20s | recovers fully |
| Noise 0.10 (2×) | 97.5% | 0.5/10s | — |
| dt jitter ±15% | 97.5% | 1/20s | 1.0s |
| Silence 0–5s then 120 | 100% | 0 in silence | — |
| Tempo change 120→140 @10s | — | — | follows in ~3s |

Onset latency: median 0 frames, max 1. Tempo accuracy: 60–150 BPM exact, 170→171.

## 9. Edge cases

- **First frames:** flux=0 on frame 1; threshold falls back to `floor` until buffer fills;
  no tempo estimate until ~1.9s (period holds the 120 BPM default, so beat/beatPhase are
  sensible from frame 0).
- **Silence:** flux below `floor` → no onsets. The metronome keeps ticking at last-known
  tempo (steady motion through quiet passages); gate on `rms` at the mapping layer if
  undesired — not in the detector.
- **dt jitter / frame drops:** phase advance is time-based; `floor(phase)` wrap emits one
  pulse even if a beat is skipped. `dt = 0` (pause): no advance, harmless.
- **Loud sections:** threshold rides up and relaxes within ~1s after — never permanently
  blinded.
- **>180 BPM:** locks to half-tempo (out of range). Documented v1 limitation.
- **Wrong initial phase:** re-acquires because correction is never confidence-gated.

## 10. Unit test cases

15 cases specified at design time — see `tests/unit/events.test.ts`: demo-path beat-grid
exactness and `fract(time*2)` phase; demo seek-safety on/off beat; silence → no onsets;
single-kick latency ≤2 frames; refractory suppression at 100ms vs 133ms spacing;
loud-section threshold recovery; noise-floor false-positive rate; 120 BPM beat lock ≤4s;
tempo accuracy at 90/120/150 BPM (±5%); beatPhase sawtooth monotonicity (decreases only
on beat frames); reset() restores cold-start state; dt-jitter robustness; first-frame
safety. Tests use a deterministic mulberry32-seeded kick synth fixture.

## 11. Implementation notes

- `estimateTempo`'s linearized scratch must be the preallocated `acLinear` field, not a
  per-call allocation (steady-state alloc-free requirement).
- Expose `period`, `phase`, `confidence` (readonly getters fine) so tests can assert
  internal state.
- No time/random sources anywhere in the class — satisfies the determinism lint ban with
  no exemptions.
- If the mapping layer wants "beat only when audio is present," gate there on `rms`;
  keep the detector's metronome free-running so visuals don't stall in breakdowns.
