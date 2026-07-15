import { Muxer, ArrayBufferTarget } from 'webm-muxer'

/**
 * The one interface export formats hide behind (ARCHITECTURE.md §6 risk item:
 * "WebCodecs H.264 support varies"). v1 ships WebM/VP9 only — this Chromium build
 * (1194, the CI/headless target) supports VP8/VP9/AV1 encode but not H.264; real
 * desktop Chrome supports H.264 too. `codec` is typed as a union of one member on
 * purpose so adding `'h264'` later is an additive change behind a capability check,
 * not a rewrite.
 */

export interface ExportVideoOpts {
  width: number
  height: number
  fps: number
  /** Target bitrate in bits/sec. Defaults to 4 Mbps. */
  bitrate?: number
  /** v1: VP9 only. 'h264' joins later behind capability detection. */
  codec?: 'vp9'
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
/** Chunk length for feeding PCM into AudioEncoder — inside the 20-100ms band the
 * task calls for; small enough to keep muxer output reasonably interleaved. */
const AUDIO_CHUNK_SECONDS = 0.05

/**
 * Builds a `VideoSink` backed by `VideoEncoder` (+ `AudioEncoder` when `audio` is
 * given) and `webm-muxer`. Checks capability up front (`VideoEncoder`/`AudioEncoder`
 * existence, `isConfigSupported`) and throws a clear error naming what's missing
 * rather than failing deep inside a frame loop.
 *
 * Audio is encoded eagerly, synchronously, right here — not exposed as a separate
 * `encodeAudio()` sink method. `AudioEncoder.encode()` is a non-blocking call (it
 * just queues work), and the whole PCM buffer is already in memory up front (unlike
 * video frames, which arrive one render-loop iteration at a time), so there is
 * nothing to gain from streaming it in from the caller. `finish()` still awaits the
 * audio encoder's `flush()` before finalizing, exactly like the video encoder. Per
 * the webm-muxer docs, the muxer buffers and interleaves tracks internally as long
 * as each track's own chunks arrive in monotonically increasing timestamp order —
 * which holds here since the audio chunks are queued strictly in PCM order.
 */
export async function createVideoSink(opts: ExportVideoOpts, audio?: ExportAudio): Promise<VideoSink> {
  if (opts.codec !== undefined && opts.codec !== 'vp9') {
    throw new Error(`Unsupported export codec: ${opts.codec} (only 'vp9' is implemented)`)
  }
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('VideoEncoder is not available in this context (WebCodecs unsupported)')
  }

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

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
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
  encoder.configure(config)

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
      return { buffer: muxer.target.buffer, mime: 'video/webm' }
    },
  }
}

/**
 * Queues the whole PCM buffer onto `encoder` as a sequence of `AudioData` chunks,
 * each `AUDIO_CHUNK_SECONDS` long (planar f32, per the task's chunk-size band).
 * Timestamps are the sample offset converted to microseconds, so chunks land in
 * strictly increasing order — the ordering guarantee the muxer relies on.
 */
function encodeAudioTrack(encoder: AudioEncoder, audio: ExportAudio): void {
  const { channels, sampleRate } = audio
  const numberOfChannels = channels.length
  const totalFrames = channels[0]?.length ?? 0
  const chunkFrames = Math.max(1, Math.round(AUDIO_CHUNK_SECONDS * sampleRate))

  for (let offset = 0; offset < totalFrames; offset += chunkFrames) {
    const frames = Math.min(chunkFrames, totalFrames - offset)
    // f32-planar layout: all frames of channel 0, then all frames of channel 1, …
    const planar = new Float32Array(numberOfChannels * frames)
    for (let ch = 0; ch < numberOfChannels; ch++) {
      planar.set(channels[ch].subarray(offset, offset + frames), ch * frames)
    }
    const data = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: frames,
      numberOfChannels,
      timestamp: Math.round((offset / sampleRate) * 1e6),
      data: planar,
    })
    try {
      encoder.encode(data)
    } finally {
      data.close()
    }
  }
}
