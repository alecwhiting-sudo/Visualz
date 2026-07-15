import { Engine } from '../engine/engine'
import { LissajousScene } from '../scenes/builtin/lissajous'
import { pixelHash } from '../gpu/readback'
import type { SessionDoc } from '../session/types'
import { createVideoSink, type EncodedResult, type ExportVideoOpts, type VideoSink } from './encode'

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
  opts: ExportVideoOpts & { collectHashes?: boolean },
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
  engine.loadSession(doc)

  const sink = await createVideoSink(opts)
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
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function drainEncodeQueue(sink: VideoSink): Promise<void> {
  while (sink.encodeQueueSize() > MAX_QUEUE_SIZE) {
    await yieldToEventLoop()
  }
}

export type { ExportVideoOpts }
