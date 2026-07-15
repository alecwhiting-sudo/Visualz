import { Muxer as WebmMuxer, ArrayBufferTarget as WebmArrayBufferTarget } from 'webm-muxer'
import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4ArrayBufferTarget } from 'mp4-muxer'

/**
 * The one interface export formats hide behind (ARCHITECTURE.md §6 risk item:
 * "WebCodecs H.264 support varies"). This Chromium build (1194, the CI/headless
 * target) supports VP8/VP9/AV1 encode but not H.264 — real desktop Chrome
 * supports H.264 too, and iOS/macOS Safari's `VideoEncoder` supports H.264+AAC
 * but does NOT support VP9/Opus encode at all. So codec choice can't be a fixed
 * default: `createVideoSink` detects what the running browser actually supports
 * (`detectExportCodec`, preferring VP9 for its smaller files where available)
 * unless the caller pins one explicitly via `opts.codec`.
 */

export type ExportCodec = 'vp9' | 'h264'

export interface ExportVideoOpts {
  width: number
  height: number
  fps: number
  /** Target bitrate in bits/sec. Defaults to 4 Mbps. */
  bitrate?: number
  /** Explicit codec preference. Omit to auto-detect via `detectExportCodec`. */
  codec?: ExportCodec
}

/** Optional audio track to mux alongside the video (REQUIREMENTS.md §5.1: "audio track
 * muxed in"). Planar PCM, one Float32Array per channel, all equal length. */
export interface ExportAudio {
  channels: Float32Array[]
  sampleRate: number
}

export interface EncodedResult {
  buffer: ArrayBuffer
  mime: string
  /** File extension matching `mime` — 'webm' for VP9/Opus, 'mp4' for H.264/AAC. */
  fileExtension: 'webm' | 'mp4'
  /**
   * Set (true) only when an H.264 export was requested with audio but AAC
   * encode isn't available in this browser, so the export went out video-only
   * rather than falling back to Opus-in-MP4 (patchy player support — see
   * `createH264Sink`). Non-fatal: the export still succeeds. Omitted entirely
   * (not `false`) when audio was included normally or wasn't requested.
   */
  audioSkipped?: boolean
}

export interface VideoSink {
  /** Takes ownership of `frame` — the sink closes it once encoded. */
  addFrame(frame: VideoFrame, keyFrame: boolean): void
  finish(): Promise<EncodedResult>
  /**
   * Mirrors `VideoEncoder.encodeQueueSize` — not in the original interface sketch,
   * added so the render loop (render.ts) can apply the backpressure the task calls
   * for without reaching past this module's encapsulation of the raw encoder.
   */
  encodeQueueSize(): number
}

const DEFAULT_BITRATE = 4_000_000
const VP9_CODEC_STRING = 'vp09.00.10.08'
const OPUS_CODEC_STRING = 'opus'
const OPUS_BITRATE = 128_000
const AAC_CODEC_STRING = 'mp4a.40.2'
const AAC_BITRATE = 128_000
/** Chunk length for feeding PCM into AudioEncoder — inside the 20-100ms band the
 * task calls for; small enough to keep muxer output reasonably interleaved. */
const AUDIO_CHUNK_SECONDS = 0.05

/**
 * H.264 level selection (`avc1.PPCCLL`: PP = profile, CC = constraint flags,
 * LL = level in hex):
 *  - `avc1.42001f` — Constrained Baseline, level 3.1. Covers this app's default
 *    export spec (1280x720@30) and anything at or under that resolution×fps
 *    envelope, per the H.264 spec's per-level macroblock-processing-rate table.
 *  - `avc1.4d0028` — Main profile, level 4.0. Used once either dimension grows
 *    past 720p or the frame rate climbs past 30 — level 3.1's macroblock rate
 *    can't carry 1080p or 60fps.
 * The threshold below is deliberately simple (area vs. 1280x720, fps vs. 30)
 * rather than an exact macroblocks/sec computation: it's conservative in the
 * one direction that matters (never picks a level too low for the request).
 */
const H264_BASELINE_720P30 = 'avc1.42001f'
const H264_MAIN_HIGHER = 'avc1.4d0028'

function pickH264CodecString(width: number, height: number, fps: number): string {
  const withinBaselineEnvelope = width * height <= 1280 * 720 && fps <= 30
  return withinBaselineEnvelope ? H264_BASELINE_720P30 : H264_MAIN_HIGHER
}

/**
 * Probes `VideoEncoder.isConfigSupported` at a fixed 1280x720@30 to find the
 * first working codec in preference order `['vp9', 'h264']` — VP9 first since
 * it's smaller for the same quality and is what every CI/desktop-Chrome target
 * already supports; H.264 is the fallback that makes iOS/macOS Safari exports
 * work, since Safari's `VideoEncoder` doesn't support VP9 at all. Throws a
 * clear error naming both codecs when neither is supported, rather than
 * failing deep inside `createVideoSink`.
 */
export async function detectExportCodec(): Promise<ExportCodec> {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error(
      `No supported export codec: neither 'vp9' (${VP9_CODEC_STRING}) nor 'h264' (${H264_BASELINE_720P30}) ` +
        'is available — VideoEncoder is not defined in this context (WebCodecs unsupported)',
    )
  }
  const vp9Support = await VideoEncoder.isConfigSupported({
    codec: VP9_CODEC_STRING,
    width: 1280,
    height: 720,
    bitrate: DEFAULT_BITRATE,
    framerate: 30,
  })
  if (vp9Support.supported) return 'vp9'

  const h264Support = await VideoEncoder.isConfigSupported({
    codec: H264_BASELINE_720P30,
    width: 1280,
    height: 720,
    bitrate: DEFAULT_BITRATE,
    framerate: 30,
    avc: { format: 'avc' },
  })
  if (h264Support.supported) return 'h264'

  throw new Error(
    `No supported export codec: neither 'vp9' (${VP9_CODEC_STRING}) nor 'h264' (${H264_BASELINE_720P30}) ` +
      'is supported by VideoEncoder.isConfigSupported in this browser',
  )
}

/**
 * Builds a `VideoSink` backed by `VideoEncoder` (+ `AudioEncoder` when `audio` is
 * given) and a container muxer. Resolves `opts.codec` (or auto-detects it via
 * `detectExportCodec` when omitted), then delegates to the matching codec-specific
 * builder below. Each builder checks capability up front (`VideoEncoder`/
 * `AudioEncoder` existence, `isConfigSupported`) and throws a clear error naming
 * what's missing rather than failing deep inside a frame loop.
 */
export async function createVideoSink(opts: ExportVideoOpts, audio?: ExportAudio): Promise<VideoSink> {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('VideoEncoder is not available in this context (WebCodecs unsupported)')
  }
  const codec = opts.codec ?? (await detectExportCodec())
  if (codec === 'vp9') return createVp9Sink(opts, audio)
  if (codec === 'h264') return createH264Sink(opts, audio)
  throw new Error(`Unsupported export codec: ${String(codec)} (only 'vp9' and 'h264' are implemented)`)
}

async function createVp9Sink(opts: ExportVideoOpts, audio?: ExportAudio): Promise<VideoSink> {
  const config: VideoEncoderConfig = {
    codec: VP9_CODEC_STRING,
    width: opts.width,
    height: opts.height,
    bitrate: opts.bitrate ?? DEFAULT_BITRATE,
    framerate: opts.fps,
  }
  const support = await VideoEncoder.isConfigSupported(config)
  if (!support.supported) {
    throw new Error(`VideoEncoder does not support config: ${JSON.stringify(config)}`)
  }

  const numberOfChannels = audio?.channels.length ?? 0
  let audioConfig: AudioEncoderConfig | null = null
  if (audio) {
    if (typeof AudioEncoder === 'undefined') {
      throw new Error('AudioEncoder is not available in this context (WebCodecs unsupported)')
    }
    audioConfig = {
      codec: OPUS_CODEC_STRING,
      sampleRate: audio.sampleRate,
      numberOfChannels,
      bitrate: OPUS_BITRATE,
    }
    const audioSupport = await AudioEncoder.isConfigSupported(audioConfig)
    if (!audioSupport.supported) {
      throw new Error(`AudioEncoder does not support config: ${JSON.stringify(audioConfig)}`)
    }
  }

  const muxer = new WebmMuxer({
    target: new WebmArrayBufferTarget(),
    video: {
      codec: 'V_VP9',
      width: opts.width,
      height: opts.height,
      frameRate: opts.fps,
    },
    audio: audio
      ? {
          codec: 'A_OPUS',
          numberOfChannels,
          sampleRate: audio.sampleRate,
        }
      : undefined,
  })

  return buildSink(config, audioConfig, audio, muxer, { mime: 'video/webm', fileExtension: 'webm' }, false)
}

/**
 * H.264/MP4 path (targets iOS/macOS Safari, whose `VideoEncoder` supports
 * `avc1.*` but not VP9). `avc: { format: 'avc' }` is required, not optional:
 * it makes the encoder emit chunks whose metadata carries an `avcC` description
 * record, which `mp4-muxer` needs to build the video track's sample entry —
 * the default `'annexb'` byte-stream format has no such record and the muxer
 * can't build a valid moov atom from it.
 *
 * Audio: AAC (`mp4a.40.2`) when supported; if the browser's `AudioEncoder`
 * doesn't support AAC, the export still succeeds but goes out video-only
 * (`audioSkipped: true`) rather than muxing Opus into the MP4 container, which
 * plenty of players (including iOS's own) handle poorly or not at all.
 */
async function createH264Sink(opts: ExportVideoOpts, audio?: ExportAudio): Promise<VideoSink> {
  const codecString = pickH264CodecString(opts.width, opts.height, opts.fps)
  const config: VideoEncoderConfig = {
    codec: codecString,
    width: opts.width,
    height: opts.height,
    bitrate: opts.bitrate ?? DEFAULT_BITRATE,
    framerate: opts.fps,
    avc: { format: 'avc' },
  }
  const support = await VideoEncoder.isConfigSupported(config)
  if (!support.supported) {
    throw new Error(
      `H.264/AVC export is not supported in this browser (VideoEncoder does not support codec '${codecString}', ` +
        `config: ${JSON.stringify(config)})`,
    )
  }

  const numberOfChannels = audio?.channels.length ?? 0
  let audioConfig: AudioEncoderConfig | null = null
  let audioSkipped = false
  if (audio) {
    if (typeof AudioEncoder === 'undefined') {
      audioSkipped = true
    } else {
      const candidateAudioConfig: AudioEncoderConfig = {
        codec: AAC_CODEC_STRING,
        sampleRate: audio.sampleRate,
        numberOfChannels,
        bitrate: AAC_BITRATE,
      }
      const audioSupport = await AudioEncoder.isConfigSupported(candidateAudioConfig)
      audioConfig = audioSupport.supported ? candidateAudioConfig : null
      audioSkipped = !audioSupport.supported
    }
  }

  const muxer = new Mp4Muxer({
    target: new Mp4ArrayBufferTarget(),
    video: {
      codec: 'avc',
      width: opts.width,
      height: opts.height,
      frameRate: opts.fps,
    },
    audio: audioConfig
      ? {
          codec: 'aac',
          numberOfChannels,
          sampleRate: audio!.sampleRate,
        }
      : undefined,
    // Keeps the moov atom up front so the file streams/plays immediately on
    // iOS rather than needing a trailing-metadata second pass.
    fastStart: 'in-memory',
  })

  return buildSink(
    config,
    audioConfig,
    audioConfig ? audio : undefined,
    muxer,
    { mime: 'video/mp4', fileExtension: 'mp4' },
    audioSkipped,
  )
}

/** Structural subset of `webm-muxer`'s and `mp4-muxer`'s `Muxer<ArrayBufferTarget>`
 * that `buildSink` needs — both libraries share this shape (same author/API family),
 * so one sink-wiring implementation serves both codec paths. */
interface MuxerLike {
  addVideoChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void
  addAudioChunk(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata): void
  finalize(): void
  target: { buffer: ArrayBuffer }
}

interface SinkResultMeta {
  mime: string
  fileExtension: 'webm' | 'mp4'
}

/**
 * Wires a `VideoEncoder` (+ optional `AudioEncoder`) to `muxer` and returns the
 * `VideoSink` both codec paths share. Encoder lifecycle, error propagation, and
 * backpressure reporting are identical between VP9/WebM and H.264/MP4 — only
 * the codec configs and the muxer instance differ per caller, so this is the
 * one place that owns encode/flush/close/finalize sequencing.
 *
 * Audio is encoded eagerly, synchronously, right here — not exposed as a separate
 * `encodeAudio()` sink method. `AudioEncoder.encode()` is a non-blocking call (it
 * just queues work), and the whole PCM buffer is already in memory up front (unlike
 * video frames, which arrive one render-loop iteration at a time), so there is
 * nothing to gain from streaming it in from the caller. `finish()` still awaits the
 * audio encoder's `flush()` before finalizing, exactly like the video encoder. Per
 * the muxer docs, it buffers and interleaves tracks internally as long as each
 * track's own chunks arrive in monotonically increasing timestamp order — which
 * holds here since the audio chunks are queued strictly in PCM order.
 */
function buildSink(
  videoConfig: VideoEncoderConfig,
  audioConfig: AudioEncoderConfig | null,
  audio: ExportAudio | undefined,
  muxer: MuxerLike,
  resultMeta: SinkResultMeta,
  audioSkipped: boolean,
): VideoSink {
  let rejectFinish: ((err: Error) => void) | null = null
  let encoderError: Error | null = null

  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      muxer.addVideoChunk(chunk, metadata)
    },
    error: (err) => {
      encoderError = err instanceof Error ? err : new Error(String(err))
      rejectFinish?.(encoderError)
    },
  })
  encoder.configure(videoConfig)

  let audioEncoder: AudioEncoder | null = null
  let rejectAudioFinish: ((err: Error) => void) | null = null
  let audioEncoderError: Error | null = null

  if (audio && audioConfig) {
    audioEncoder = new AudioEncoder({
      output: (chunk, metadata) => {
        muxer.addAudioChunk(chunk, metadata)
      },
      error: (err) => {
        audioEncoderError = err instanceof Error ? err : new Error(String(err))
        rejectAudioFinish?.(audioEncoderError)
      },
    })
    audioEncoder.configure(audioConfig)
    encodeAudioTrack(audioEncoder, audio)
  }

  return {
    addFrame(frame, keyFrame) {
      // Ownership means the frame closes on EVERY path — including a synchronous
      // encode() throw (e.g. InvalidStateError racing the async error callback);
      // a leaked VideoFrame pins GPU memory.
      try {
        if (encoderError) throw encoderError
        encoder.encode(frame, { keyFrame })
      } finally {
        frame.close()
      }
    },
    encodeQueueSize() {
      return encoder.encodeQueueSize
    },
    async finish() {
      if (encoderError) throw encoderError
      await new Promise<void>((resolve, reject) => {
        rejectFinish = reject
        encoder.flush().then(resolve, reject)
      })
      rejectFinish = null
      encoder.close()

      if (audioEncoder) {
        if (audioEncoderError) throw audioEncoderError
        await new Promise<void>((resolve, reject) => {
          rejectAudioFinish = reject
          audioEncoder!.flush().then(resolve, reject)
        })
        rejectAudioFinish = null
        audioEncoder.close()
      }

      muxer.finalize()
      const result: EncodedResult = {
        buffer: muxer.target.buffer,
        mime: resultMeta.mime,
        fileExtension: resultMeta.fileExtension,
      }
      if (audioSkipped) result.audioSkipped = true
      return result
    },
  }
}

type AudioDataFormatPreference = 'f32-planar' | 'f32'

function buildAudioData(
  channels: Float32Array[],
  offset: number,
  frames: number,
  sampleRate: number,
  format: AudioDataFormatPreference,
): AudioData {
  const numberOfChannels = channels.length
  const data = new Float32Array(numberOfChannels * frames)
  if (format === 'f32-planar') {
    // planar layout: all frames of channel 0, then all frames of channel 1, …
    for (let ch = 0; ch < numberOfChannels; ch++) {
      data.set(channels[ch].subarray(offset, offset + frames), ch * frames)
    }
  } else {
    // interleaved layout: frame 0's channels, then frame 1's channels, …
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const src = channels[ch]
      for (let i = 0; i < frames; i++) {
        data[i * numberOfChannels + ch] = src[offset + i]
      }
    }
  }
  return new AudioData({
    format,
    sampleRate,
    numberOfFrames: frames,
    numberOfChannels,
    timestamp: Math.round((offset / sampleRate) * 1e6),
    data,
  })
}

/**
 * Encodes one `AUDIO_CHUNK_SECONDS`-long slice starting at `offset`, in the given
 * `format`. Every real-world encoder this app targets (CI's Opus path, Safari's
 * AAC path) accepts `'f32-planar'` — but some AAC encoder implementations are
 * documented to reject planar input with a synchronous error from `encode()`.
 * When that happens on the very first chunk, retry once as interleaved `'f32'`
 * and, if that succeeds, report the working format back via `onFallback` so the
 * rest of the track uses it too (switching format mid-track, rather than
 * per-chunk, keeps every chunk in a single consistent layout).
 */
function encodeAudioChunk(
  encoder: AudioEncoder,
  channels: Float32Array[],
  offset: number,
  frames: number,
  sampleRate: number,
  format: AudioDataFormatPreference,
  allowFallback: boolean,
  onFallback: (format: AudioDataFormatPreference) => void,
): void {
  const data = buildAudioData(channels, offset, frames, sampleRate, format)
  try {
    encoder.encode(data)
  } catch (err) {
    data.close()
    if (allowFallback && format === 'f32-planar') {
      onFallback('f32')
      encodeAudioChunk(encoder, channels, offset, frames, sampleRate, 'f32', false, onFallback)
      return
    }
    throw err
  }
  data.close()
}

/**
 * Queues the whole PCM buffer onto `encoder` as a sequence of `AudioData` chunks,
 * each `AUDIO_CHUNK_SECONDS` long. Timestamps are the sample offset converted to
 * microseconds, so chunks land in strictly increasing order — the ordering
 * guarantee the muxer relies on.
 */
function encodeAudioTrack(encoder: AudioEncoder, audio: ExportAudio): void {
  const { channels, sampleRate } = audio
  const totalFrames = channels[0]?.length ?? 0
  const chunkFrames = Math.max(1, Math.round(AUDIO_CHUNK_SECONDS * sampleRate))
  let format: AudioDataFormatPreference = 'f32-planar'

  for (let offset = 0; offset < totalFrames; offset += chunkFrames) {
    const frames = Math.min(chunkFrames, totalFrames - offset)
    const isFirstChunk = offset === 0
    encodeAudioChunk(encoder, channels, offset, frames, sampleRate, format, isFirstChunk, (fallback) => {
      format = fallback
    })
  }
}
