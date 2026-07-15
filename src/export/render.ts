import { Engine } from '../engine/engine'
import { LissajousScene } from '../scenes/builtin/lissajous'
import { pixelHash } from '../gpu/readback'
import type { SessionDoc } from '../session/types'
import { createVideoSink, type EncodedResult, type ExportAudio, type ExportVideoOpts, type VideoSink } from './encode'

export interface ExportProgress {
  frame: number
  total: number
}

/** Yield to the event loop this often so encoder backpressure and worker messages flow. */
const YIELD_EVERY_N_FRAMES = 30
/** VideoEncoder.encodeQueueSize above this triggers a drain wait before encoding more. */
const MAX_QUEUE_SIZE = 8

/**
 * Deterministic offline render (ARCHITECTURE.md §3.6): replays `doc` through a
 * fresh render-mode Engine at exactly `opts.fps` on an OffscreenCanvas sized
 * `opts.width x opts.height`, encoding every frame via `createVideoSink`. Runs
 * fine on the main thread but is designed to run inside `worker.ts` so live
 * playback is untouched during export.
 */
export async function renderSessionToVideo(
  doc: SessionDoc,
  opts: ExportVideoOpts & { collectHashes?: boolean; audio?: ExportAudio },
  onProgress?: (p: ExportProgress) => void,
): Promise<EncodedResult & { frameHashes?: string[] }> {
  const canvas = new OffscreenCanvas(opts.width, opts.height)
  const engine = new Engine(canvas, new LissajousScene(), {
    mode: 'render',
    seed: doc.seed,
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
  })
  try {
    engine.loadSession(doc)

    const sink = await createVideoSink(opts, trimAudioToVideoDuration(opts.audio, doc.durationFrames, opts.fps))
    const frameHashes = opts.collectHashes ? ([] as string[]) : undefined
    const total = doc.durationFrames

    for (let i = 0; i < total; i++) {
      engine.renderFrames(1)

      if (frameHashes) {
        frameHashes.push(pixelHash(engine.gpu.gl, opts.width, opts.height))
      }

      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((i * 1e6) / opts.fps),
        duration: Math.round(1e6 / opts.fps),
      })
      sink.addFrame(frame, i % (opts.fps * 2) === 0)

      onProgress?.({ frame: i + 1, total })

      if ((i + 1) % YIELD_EVERY_N_FRAMES === 0) {
        await yieldToEventLoop()
      }
      await drainEncodeQueue(sink)
    }

    const result = await sink.finish()
    return { ...result, frameHashes }
  } finally {
    // Each call creates a WebGL2 context; without explicit release, repeated
    // main-thread exports pile up live contexts until the browser evicts the
    // oldest — possibly the visible live canvas. (Worker exports get reclaimed
    // by terminate(), but this function must be safe anywhere.)
    engine.dispose()
    engine.gpu.gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function drainEncodeQueue(sink: VideoSink): Promise<void> {
  while (sink.encodeQueueSize() > MAX_QUEUE_SIZE) {
    await yieldToEventLoop()
  }
}

/**
 * Trim/pad is explicitly not required (task spec): if audio runs longer than the
 * video, only encode up to the video's duration; if shorter, encode what exists —
 * the muxer/decoder side simply has a shorter audio track than video track.
 */
function trimAudioToVideoDuration(
  audio: ExportAudio | undefined,
  durationFrames: number,
  fps: number,
): ExportAudio | undefined {
  if (!audio) return undefined
  const maxSamples = Math.ceil((durationFrames / fps) * audio.sampleRate)
  const totalSamples = audio.channels[0]?.length ?? 0
  if (totalSamples <= maxSamples) return audio
  return {
    sampleRate: audio.sampleRate,
    channels: audio.channels.map((c) => c.subarray(0, maxSamples)),
  }
}

export type { ExportVideoOpts, ExportAudio }
