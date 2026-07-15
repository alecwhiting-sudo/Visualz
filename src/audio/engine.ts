import type { SignalBus } from '../core/signals'

/**
 * Live audio path for the skeleton: file playback through an AnalyserNode,
 * publishing band-energy signals each frame. The offline analysis pass
 * (beat grid, sections — ARCHITECTURE.md §3.2) replaces this as the file
 * path later; this remains the live-mic shape.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private source: AudioBufferSourceNode | null = null
  private freqData: Uint8Array<ArrayBuffer> | null = null
  private startedAt = 0
  private decoded: AudioBuffer | null = null

  get isPlaying(): boolean {
    return this.source !== null
  }

  /** Audio-clock time in seconds since playback started; drives the live Transport. */
  get time(): number {
    if (!this.ctx || !this.source) return 0
    return this.ctx.currentTime - this.startedAt
  }

  async playFile(file: File): Promise<void> {
    this.stop()
    if (!this.ctx) this.ctx = new AudioContext()
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    const buffer = await this.ctx.decodeAudioData(await file.arrayBuffer())
    this.decoded = buffer

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
  }

  stop(): void {
    this.source?.stop()
    this.source = null
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
