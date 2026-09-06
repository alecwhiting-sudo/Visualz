import { Engine } from '../engine/engine'
import { SCENES } from '../scenes/registry'
import { fnv1aHex, pixelHash } from '../gpu/readback'
import type { SessionDoc } from '../session/types'
import { createVideoSink, type EncodedResult, type ExportAudio, type ExportVideoOpts, type VideoSink } from './encode'
import { creditsActive, creditsAlpha, drawCredits } from './credits'

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
  const sceneEntry = SCENES[doc.scene.id]
  if (!sceneEntry) throw new Error(`unknown scene ${doc.scene.id}`)

  const canvas = new OffscreenCanvas(opts.width, opts.height)
  const engine = new Engine(canvas, sceneEntry.create(), {
    mode: 'render',
    seed: doc.seed,
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
  })
  try {
    // A zero-frame doc would hand the muxer no video chunks at all, and
    // webm-muxer dies finalizing on a null internal config ("Cannot read
    // properties of null (reading 'colorSpace')" — user-reported). Fail with
    // a message that names the actual problem instead.
    if (doc.durationFrames <= 0) {
      throw new Error('Session has zero frames (empty take) — nothing to export')
    }
    engine.loadSession(doc)

    const sink = await createVideoSink(opts, trimAudioToVideoDuration(opts.audio, doc.durationFrames, opts.fps))
    const frameHashes = opts.collectHashes ? ([] as string[]) : undefined
    const total = doc.durationFrames

    // Credits overlay (opt-in, user-set text — see `credits.ts`): both lines
    // blank after trim (the default) keeps this whole block a no-op and the
    // export on today's direct-canvas-to-VideoFrame path, byte-identical to
    // before this feature existed. Only when at least one line is non-blank
    // does a frame get composited through a same-size 2D OffscreenCanvas
    // (drawImage the GL frame, draw the credits at the computed alpha, feed
    // *that* canvas to VideoFrame) instead of the GL canvas directly.
    const credits = opts.credits
    const showCredits = !!credits && creditsActive(credits.line1, credits.line2)
    const compositeCanvas = showCredits ? new OffscreenCanvas(opts.width, opts.height) : null
    const compositeCtx = compositeCanvas?.getContext('2d') ?? null
    if (showCredits && !compositeCtx) {
      throw new Error('Could not get a 2D context for the credits-overlay composite canvas')
    }
    const durationSec = total / opts.fps

    for (let i = 0; i < total; i++) {
      engine.renderFrames(1)

      let frameSource: OffscreenCanvas = canvas
      if (compositeCanvas && compositeCtx && credits) {
        compositeCtx.clearRect(0, 0, opts.width, opts.height)
        compositeCtx.drawImage(canvas, 0, 0)
        const alpha = creditsAlpha(i / opts.fps, durationSec)
        drawCredits(compositeCtx, opts.width, opts.height, credits.line1, credits.line2, alpha)
        frameSource = compositeCanvas
      }

      if (frameHashes) {
        // Hash what actually gets ENCODED (review finding): with credits
        // active that's the composited 2D canvas — hashing the GL buffer
        // here would blind the determinism check to the overlay entirely.
        if (compositeCtx) {
          const img = compositeCtx.getImageData(0, 0, opts.width, opts.height)
          frameHashes.push(fnv1aHex(new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength)))
        } else {
          frameHashes.push(pixelHash(engine.gpu.gl, opts.width, opts.height))
        }
      }

      const frame = new VideoFrame(frameSource, {
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

/**
 * Take-baselining (session/types.ts's `SessionAudio.startSeconds`): a take
 * armed mid-track starts recording at `startSeconds` seconds into the loaded
 * file, but the take doc's own timeline (`doc.audio`) and the export's replay
 * (`frame.time`) both start counting from 0 — so the raw PCM handed in for
 * muxing must be sliced forward by the same offset, or the exported audio
 * track would play the wrong section of the file under the video. Callers
 * that build `ExportAudio` from a live `AudioEngine.lastBuffer()` (App.tsx's
 * `exportVideo`) apply this before handing the result to `exportSession` —
 * `trimAudioToVideoDuration` above then bounds the tail to the take's length,
 * same as any other export. A no-op when `startSeconds` is 0 or omitted.
 */
export function sliceExportAudioFromSeconds(audio: ExportAudio, startSeconds: number): ExportAudio {
  if (!(startSeconds > 0)) return audio
  const startSample = Math.round(startSeconds * audio.sampleRate)
  return {
    sampleRate: audio.sampleRate,
    channels: audio.channels.map((c) => c.subarray(Math.min(startSample, c.length))),
  }
}

export type { ExportVideoOpts, ExportAudio }
