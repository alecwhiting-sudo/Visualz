import type { SessionDoc } from '../session/types'
import type { EncodedResult, ExportAudio, ExportVideoOpts } from './encode'
import type { ExportProgress } from './render'

/**
 * Main-thread export API (ARCHITECTURE.md §3.6): spins up `worker.ts` as a module
 * worker per call, feeds it the session doc, and resolves with the encoded result.
 * The live engine on the page is untouched — the worker owns its own OffscreenCanvas.
 */

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

export function exportSession(
  doc: SessionDoc,
  opts: ExportVideoOpts & { collectHashes?: boolean },
  onProgress?: (p: ExportProgress) => void,
  audio?: ExportAudio,
): Promise<EncodedResult & { frameHashes?: string[] }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })

    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data
      switch (msg.type) {
        case 'progress':
          onProgress?.({ frame: msg.frame, total: msg.total })
          break
        case 'done':
          worker.terminate()
          resolve({
            buffer: msg.buffer,
            mime: msg.mime,
            fileExtension: msg.fileExtension,
            audioSkipped: msg.audioSkipped,
            frameHashes: msg.frameHashes,
          })
          break
        case 'error':
          worker.terminate()
          reject(new Error(msg.message))
          break
      }
    }
    worker.onerror = (ev: ErrorEvent) => {
      worker.terminate()
      reject(new Error(ev.message || 'Export worker failed'))
    }

    // `slice()` copies each channel into a fresh, standalone ArrayBuffer before
    // transfer — transferring a view's underlying buffer directly would detach
    // it, which could yank the rug out from under the caller (e.g. AudioEngine's
    // live AudioBuffer channel data) even though the caller never asked to give
    // it up. The copy costs one pass over the PCM; export is already far slower
    // than realtime, so it's noise.
    const channelBuffers = audio?.channels.map((c) => c.slice().buffer)

    worker.postMessage(
      {
        type: 'export',
        doc,
        opts,
        audio: audio && channelBuffers ? { channelBuffers, sampleRate: audio.sampleRate } : undefined,
      },
      channelBuffers ? { transfer: channelBuffers } : undefined,
    )
  })
}
