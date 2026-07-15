import { renderSessionToVideo, type ExportProgress, type ExportVideoOpts } from './render'
import type { SessionDoc } from '../session/types'

/**
 * Export worker (ARCHITECTURE.md §3.6): a module worker so `export/client.ts` can
 * hand it a session doc and get back an encoded WebM without ever touching the
 * live engine's canvas — this worker owns its own OffscreenCanvas end to end.
 */

interface ExportRequest {
  type: 'export'
  doc: SessionDoc
  opts: ExportVideoOpts & { collectHashes?: boolean }
}

type WorkerRequest = ExportRequest

type WorkerResponse =
  | { type: 'progress'; frame: number; total: number }
  | { type: 'done'; buffer: ArrayBuffer; mime: string; frameHashes?: string[] }
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

    const result = await renderSessionToVideo(msg.doc, msg.opts, onProgress)
    const response: WorkerResponse = {
      type: 'done',
      buffer: result.buffer,
      mime: result.mime,
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
