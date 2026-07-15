import { analyzeAudio } from './analysis'

/**
 * Runs the offline analysis pass (docs/ANALYSIS.md) off the main thread so a
 * long track on a slow device doesn't freeze the UI. See analysisClient.ts.
 */

interface AnalyzeRequest {
  type: 'analyze'
  samples: ArrayBuffer
  sampleRate: number
}

self.onmessage = (ev: MessageEvent<AnalyzeRequest>) => {
  const msg = ev.data
  if (msg.type !== 'analyze') return
  try {
    const tl = analyzeAudio(new Float32Array(msg.samples), msg.sampleRate, {
      onProgress: (fraction) => self.postMessage({ type: 'progress', fraction }),
    })
    const buffers = [tl.rms, tl.bass, tl.mid, tl.high, tl.onsetEnv, tl.onsets, tl.beats].map(
      (a) => a.buffer as ArrayBuffer,
    )
    self.postMessage({ type: 'done', timeline: tl }, { transfer: buffers })
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
