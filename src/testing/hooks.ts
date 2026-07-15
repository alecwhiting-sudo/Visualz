import { Engine } from '../engine/engine'
import { LissajousScene } from '../scenes/builtin/lissajous'
import type { SourceEvent } from '../mapping/types'
import type { SessionDoc } from '../session/types'

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

  const canvas = document.createElement('canvas')
  canvas.style.imageRendering = 'pixelated'
  root.appendChild(canvas)

  const engine = new Engine(canvas, new LissajousScene(), {
    mode: 'render',
    seed,
    width: 640,
    height: 360,
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
  }
}
