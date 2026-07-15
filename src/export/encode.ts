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

/**
 * Builds a `VideoSink` backed by `VideoEncoder` + `webm-muxer`. Checks capability
 * up front (`VideoEncoder` existence, `isConfigSupported`) and throws a clear error
 * naming what's missing rather than failing deep inside a frame loop.
 */
export async function createVideoSink(opts: ExportVideoOpts): Promise<VideoSink> {
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

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: 'V_VP9',
      width: opts.width,
      height: opts.height,
      frameRate: opts.fps,
    },
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
      muxer.finalize()
      return { buffer: muxer.target.buffer, mime: 'video/webm' }
    },
  }
}
