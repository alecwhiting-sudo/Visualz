import { renderSessionToVideo, type ExportProgress, type ExportVideoOpts } from './render'
import type { ExportAudio } from './encode'
import type { SessionDoc } from '../session/types'

/**
 * Export worker (ARCHITECTURE.md §3.6): a module worker so `export/client.ts` can
 * hand it a session doc and get back an encoded WebM without ever touching the
 * live engine's canvas — this worker owns its own OffscreenCanvas end to end.
 */

/** Wire shape for `ExportAudio` across the postMessage boundary: raw PCM channel
 * buffers, transferred (not cloned) from client.ts. */
interface WireAudio {
  channelBuffers: ArrayBuffer[]
  sampleRate: number
}

interface ExportRequest {
  type: 'export'
  doc: SessionDoc
  opts: ExportVideoOpts & { collectHashes?: boolean }
  audio?: WireAudio
}

type WorkerRequest = ExportRequest

type WorkerResponse =
  | { type: 'progress'; frame: number; total: number }
  | {
      type: 'done'
      buffer: ArrayBuffer
      mime: string
      fileExtension: 'webm' | 'mp4'
      audioSkipped?: boolean
      frameHashes?: string[]
    }
  | { type: 'error'; message: string }

const PROGRESS_EVERY_N_FRAMES = 10

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data
  if (msg.type !== 'export') return

  try {
    let lastReported = -1
    const onProgress = (p: ExportProgress) => {
      if (p.frame - lastReported < PROGRESS_EVERY_N_FRAMES && p.frame < p.total) return
      lastReported = p.frame
      const response: WorkerResponse = { type: 'progress', frame: p.frame, total: p.total }
      postMessage(response)
    }

    const audio: ExportAudio | undefined = msg.audio
      ? {
          channels: msg.audio.channelBuffers.map((buf) => new Float32Array(buf)),
          sampleRate: msg.audio.sampleRate,
        }
      : undefined

    const result = await renderSessionToVideo(msg.doc, { ...msg.opts, audio }, onProgress)
    const response: WorkerResponse = {
      type: 'done',
      buffer: result.buffer,
      mime: result.mime,
      fileExtension: result.fileExtension,
      audioSkipped: result.audioSkipped,
      frameHashes: result.frameHashes,
    }
    postMessage(response, { transfer: [result.buffer] })
  } catch (err) {
    const response: WorkerResponse = {
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    }
    postMessage(response)
  }
}
