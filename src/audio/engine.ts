import type { SignalBus } from '../core/signals'
import type { FeatureTimeline } from './analysis'
import { analyzeAudioAsync } from './analysisClient'

/**
 * Live audio path: file playback through an AnalyserNode, publishing
 * band-energy signals each frame — this remains the live-mic shape and is
 * kept intact as the future mic path. File playback's signal publishing has
 * moved to the Engine (docs/ANALYSIS.md §6/§12), which prefers the offline
 * `FeatureTimeline` computed here (whole-track, non-causal, strictly better
 * beat tracking — ARCHITECTURE.md §3.2) over this analyser whenever one is
 * available; `publishSignals`/the analyser stay wired up underneath for that
 * future mic path and as a fallback shape.
 */
/** ~50ms of 8kHz mono 16-bit silence — see unlockPlaybackCategory. */
const SILENT_WAV_DATA_URI =
  'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='

export class AudioEngine {
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private source: AudioBufferSourceNode | null = null
  private freqData: Uint8Array<ArrayBuffer> | null = null
  private startedAt = 0
  private decoded: AudioBuffer | null = null
  /** Monotonic token so overlapping playFile calls resolve to the newest one. */
  private loadSeq = 0
  private unlockElement: HTMLAudioElement | null = null
  private featureTimeline: FeatureTimeline | null = null
  private _fileName: string | null = null

  get isPlaying(): boolean {
    return this.source !== null
  }

  /** The AudioContext state, or null before any playback attempt. iOS suspends
   * contexts created outside a live user gesture — the UI watches this and
   * offers a tap-to-enable button (a tap is a guaranteed-valid gesture). */
  get contextState(): AudioContextState | null {
    return this.ctx?.state ?? null
  }

  /** Resume audio from within a user gesture: re-kicks the playback-category
   * unlock element and resumes the context. Safe to call repeatedly. */
  async resumeContext(): Promise<void> {
    void this.unlockElement?.play().catch(() => {})
    if (this.ctx && this.ctx.state !== 'running') {
      await this.ctx.resume()
    }
  }

  /** Audio-clock time in seconds since playback started; drives the live Transport. */
  get time(): number {
    if (!this.ctx || !this.source) return 0
    return this.ctx.currentTime - this.startedAt
  }

  /** The most recently analyzed file's offline feature timeline, or null until
   * a file has finished analysis (see `playFile`). */
  get timeline(): FeatureTimeline | null {
    return this.featureTimeline
  }

  /** The most recently loaded file's name, or null if none has been loaded. */
  get fileName(): string | null {
    return this._fileName
  }

  /**
   * Decodes and starts playing `file` immediately; resolves once playback has
   * begun. The offline analysis pass (docs/ANALYSIS.md) runs in a background
   * Worker meanwhile — until it lands, the engine's signal-source priority
   * falls back to the realtime analyser + causal detector, then hot-swaps to
   * the timeline the frame it becomes available. `onAnalysisProgress` reports
   * [0,1] fractions and a final 1 (or is never called past start on failure —
   * playback survives an analysis error, just without beat-grid signals).
   */
  async playFile(file: File, onAnalysisProgress?: (fraction: number) => void): Promise<void> {
    // Re-entrancy guard: rapid successive file selections each pass the entry
    // stop() before the earlier call has created its source, which would leave
    // overlapping playback. Only the newest call survives its await points.
    const seq = ++this.loadSeq
    this.stop()
    this.featureTimeline = null
    // Must run synchronously, inside the user gesture that picked the file,
    // before any await gives iOS a chance to drop the activation.
    this.unlockPlaybackCategory()
    if (!this.ctx) this.ctx = new AudioContext()
    // Fire-and-forget: on iOS, resume() outside a still-valid gesture can stay
    // PENDING forever — awaiting it here hung playFile before the source was
    // ever created, so the tap-to-enable button (which requires isPlaying)
    // never appeared. Decode + source.start() work on a suspended context
    // (playback is queued until it runs); the UI button resumes it on tap.
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => {})
    const buffer = await this.ctx.decodeAudioData(await file.arrayBuffer())
    if (seq !== this.loadSeq) return // superseded by a newer playFile
    this.decoded = buffer
    this._fileName = file.name

    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 2048
    this.analyser.smoothingTimeConstant = 0.7
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount)

    this.source = this.ctx.createBufferSource()
    this.source.buffer = buffer
    this.source.connect(this.analyser)
    this.analyser.connect(this.ctx.destination)
    this.source.onended = () => {
      this.source = null
    }
    this.startedAt = this.ctx.currentTime
    this.source.start()

    // Background analysis: no await from the caller's perspective beyond this
    // method resolving — the timeline slots in whenever it finishes, and the
    // loadSeq guard drops results that a newer playFile superseded.
    void analyzeAudioAsync(mixToMono(buffer), buffer.sampleRate, onAnalysisProgress)
      .then((tl) => {
        if (seq === this.loadSeq) this.featureTimeline = tl
      })
      .catch(() => {
        // Pure-function failure or worker loss: keep playing on the analyser
        // path (no beat grid). Non-fatal by design.
      })
  }

  stop(): void {
    this.source?.stop()
    this.source = null
  }

  /**
   * iOS Safari mutes Web Audio when the hardware ring/silent switch is on
   * silent (it defaults the page's audio session to the 'ambient' category).
   * Looping a silent HTML <audio> element promotes the session to 'playback' —
   * the category music apps use — so file playback stays audible regardless of
   * the switch. Silent samples, so it is inaudible everywhere else; no-op
   * outside a DOM context (the engine also runs in export workers).
   */
  private unlockPlaybackCategory(): void {
    if (this.unlockElement || typeof Audio === 'undefined') return
    const el = new Audio(SILENT_WAV_DATA_URI)
    el.loop = true
    el.setAttribute('playsinline', '')
    void el.play().catch(() => {
      // Autoplay refused (no user activation): harmless, we retry on next playFile.
      this.unlockElement = null
    })
    this.unlockElement = el
  }

  /** The most recently decoded file's PCM, for export's optional audio muxing
   * (App.tsx). Returns null until a file has been loaded via `playFile`. */
  lastBuffer(): { channels: Float32Array[]; sampleRate: number } | null {
    if (!this.decoded) return null
    const channels: Float32Array[] = []
    for (let i = 0; i < this.decoded.numberOfChannels; i++) {
      channels.push(this.decoded.getChannelData(i))
    }
    return { channels, sampleRate: this.decoded.sampleRate }
  }

  /** Publish this frame's audio features onto the bus. */
  publishSignals(bus: SignalBus): void {
    if (!this.analyser || !this.freqData || !this.ctx) return
    this.analyser.getByteFrequencyData(this.freqData)
    const bins = this.freqData
    const nyquist = this.ctx.sampleRate / 2
    const binHz = nyquist / bins.length

    const band = (loHz: number, hiHz: number): number => {
      const lo = Math.max(0, Math.floor(loHz / binHz))
      const hi = Math.min(bins.length - 1, Math.ceil(hiHz / binHz))
      let sum = 0
      for (let i = lo; i <= hi; i++) sum += bins[i]
      return sum / ((hi - lo + 1) * 255)
    }

    let sumSq = 0
    for (let i = 0; i < bins.length; i++) {
      const v = bins[i] / 255
      sumSq += v * v
    }

    bus.set('rms', Math.sqrt(sumSq / bins.length))
    bus.set('bass', band(20, 160))
    bus.set('mid', band(160, 2000))
    bus.set('high', band(2000, 12000))
  }
}

/** Averages all channels of a decoded AudioBuffer into a single Float32Array
 * (docs/ANALYSIS.md's offline pass runs on mono PCM). */
function mixToMono(buffer: AudioBuffer): Float32Array {
  const out = new Float32Array(buffer.length)
  const channels = buffer.numberOfChannels
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < data.length; i++) out[i] += data[i]
  }
  if (channels > 1) {
    for (let i = 0; i < out.length; i++) out[i] /= channels
  }
  return out
}

/**
 * Deterministic synthetic signals, a pure function of transport time. Used when
 * no audio is loaded (the app still dances) and by headless golden-image tests.
 */
export function publishDemoSignals(bus: SignalBus, time: number): void {
  const beat = Math.pow(Math.max(0, Math.sin(time * Math.PI * 2 * (120 / 60))), 8)
  bus.set('bass', 0.3 + 0.6 * beat)
  bus.set('mid', 0.25 + 0.2 * Math.sin(time * 1.7))
  bus.set('high', 0.15 + 0.15 * Math.sin(time * 5.3))
  bus.set('rms', 0.25 + 0.35 * beat)
}
