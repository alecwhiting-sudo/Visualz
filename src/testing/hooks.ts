import { Engine } from '../engine/engine'
import { LissajousScene } from '../scenes/builtin/lissajous'
import type { SourceEvent } from '../mapping/types'
import type { SessionDoc } from '../session/types'
import { pixelHash } from '../gpu/readback'
import { exportSession } from '../export/client'
import type { ExportVideoOpts } from '../export/render'

/**
 * Headless test harness (ARCHITECTURE.md §5). `/?test=1&seed=S` boots the engine
 * in render mode — no rAF, no audio, deterministic demo signals — and exposes
 * window.__viz so Playwright can step to an exact frame and screenshot it.
 */

export interface VizTestApi {
  renderFrames(n: number): void
  setParam(name: string, value: number): void
  setBinding(param: string, src: string): void
  clearBinding(param: string): void
  queueEvent(e: SourceEvent): void
  setInputSignal(name: string, value: number): void
  frame(): number
  startRecording(): void
  stopRecording(): unknown
  loadSession(doc: unknown): void
  /**
   * FNV-1a hash of the canvas's current pixels (readPixels). Exact equality of
   * two hashes on the same machine/context proves byte-identical frames — a far
   * stricter check than the golden-image diff threshold, which empirically
   * tolerates a one-frame event offset.
   */
  pixelHash(): string
  /**
   * Drives the export worker pipeline (ARCHITECTURE.md §3.6) end-to-end from a
   * session doc and returns just enough of the result for Playwright to assert
   * on without shipping the whole ArrayBuffer across the page/test boundary:
   * blob size, mime type, per-frame hashes (determinism), and the first 4 bytes
   * (EBML magic — the test itself checks the exact byte values).
   */
  exportSession(
    doc: unknown,
    opts: unknown,
  ): Promise<{ size: number; mime: string; frameHashes?: string[]; magic: number[] }>
}

declare global {
  interface Window {
    __viz?: VizTestApi
  }
}

export function isTestMode(): boolean {
  return new URLSearchParams(location.search).get('test') === '1'
}

export function bootTestMode(root: HTMLElement): void {
  const params = new URLSearchParams(location.search)
  const seed = Number(params.get('seed') ?? '42')
  // Optional canvas size override (?w=360&h=640) so golden tests can lock the
  // scene's composition at 9:16 and 1:1, not just the 16:9 default — the
  // aspect-awareness hard rule in CLAUDE.md needs real snapshot coverage.
  const width = Number(params.get('w') ?? '640')
  const height = Number(params.get('h') ?? '360')

  const canvas = document.createElement('canvas')
  canvas.style.imageRendering = 'pixelated'
  root.appendChild(canvas)

  const engine = new Engine(canvas, new LissajousScene(), {
    mode: 'render',
    seed,
    width,
    height,
    fps: 30,
  })

  window.__viz = {
    renderFrames: (n) => engine.renderFrames(n),
    setParam: (name, value) => engine.setParam(name, value),
    setBinding: (param, src) => engine.setBinding(param, src),
    clearBinding: (param) => engine.clearBinding(param),
    queueEvent: (e) => engine.queueInput(e),
    setInputSignal: (name, value) => engine.setInputSignal(name, value),
    frame: () => engine.transport.frame,
    startRecording: () => engine.startRecording(),
    stopRecording: () => engine.stopRecording(),
    loadSession: (doc) => engine.loadSession(doc as SessionDoc),
    pixelHash: () => {
      const { gl } = engine.gpu
      const { width, height } = engine.gpu
      return pixelHash(gl, width, height)
    },
    exportSession: async (doc, opts) => {
      const result = await exportSession(doc as SessionDoc, opts as ExportVideoOpts & { collectHashes?: boolean })
      const magic = Array.from(new Uint8Array(result.buffer.slice(0, 4)))
      return { size: result.buffer.byteLength, mime: result.mime, frameHashes: result.frameHashes, magic }
    },
  }
}
