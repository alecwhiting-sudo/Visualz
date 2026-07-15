import { analyzeAudio, type FeatureTimeline } from './analysis'

/**
 * Main-thread API for the analysis worker: same signature as `analyzeAudio`
 * plus a progress callback. Falls back to the synchronous pass when Workers
 * are unavailable or the worker errors (the result is identical either way —
 * analyzeAudio is a pure function).
 *
 * `samples` is TRANSFERRED to the worker (detached) — callers must pass a
 * dedicated copy (the mono mixdown already is one).
 */
export function analyzeAudioAsync(
  samples: Float32Array,
  sampleRate: number,
  onProgress?: (fraction: number) => void,
): Promise<FeatureTimeline> {
  if (typeof Worker === 'undefined') {
    return Promise.resolve(analyzeAudio(samples, sampleRate, { onProgress }))
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./analysisWorker.ts', import.meta.url), { type: 'module' })
    worker.onerror = () => {
      // Worker failed to load/run its module — this fires before any message
      // round-trip, so the samples buffer is still usable if not yet detached;
      // when it is detached the sync path throws, which reject() surfaces.
      worker.terminate()
      try {
        resolve(analyzeAudio(samples, sampleRate, { onProgress }))
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
    worker.onmessage = (ev) => {
      const msg = ev.data as
        | { type: 'progress'; fraction: number }
        | { type: 'done'; timeline: FeatureTimeline }
        | { type: 'error'; message: string }
      if (msg.type === 'progress') {
        onProgress?.(msg.fraction)
      } else if (msg.type === 'done') {
        worker.terminate()
        onProgress?.(1)
        resolve(msg.timeline)
      } else {
        // analyzeAudio is pure — an input that throws in the worker would throw
        // identically here, so don't retry; the caller decides what playback
        // does without a timeline.
        worker.terminate()
        reject(new Error(`audio analysis failed: ${msg.message}`))
      }
    }
    worker.postMessage({ type: 'analyze', samples: samples.buffer, sampleRate }, [samples.buffer])
  })
}
