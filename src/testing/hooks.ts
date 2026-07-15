import { Engine } from '../engine/engine'
import { SCENES } from '../scenes/registry'
import type { SourceEvent } from '../mapping/types'
import type { SessionDoc } from '../session/types'
import { pixelHash } from '../gpu/readback'
import { exportSession } from '../export/client'
import type { ExportVideoOpts } from '../export/render'
import type { ExportAudio } from '../export/encode'
import { analyzeAudio } from '../audio/analysis'
import { serializeTimeline } from '../audio/timeline'
import { mulberry32 } from '../core/prng'

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
   *
   * `opts` accepts an extra `audioSeconds?: number` beyond `ExportVideoOpts &
   * { collectHashes? }` — when set, a deterministic synthetic stereo tone of that
   * duration is muxed in as the export's audio track (there's no real audio file
   * to hand across the Playwright/page boundary).
   */
  exportSession(
    doc: unknown,
    opts: unknown,
  ): Promise<{
    size: number
    mime: string
    fileExtension: 'webm' | 'mp4'
    audioSkipped?: boolean
    frameHashes?: string[]
    magic: number[]
  }>
  /**
   * Synthesizes a deterministic 120 BPM kick-pattern PCM track, runs it through
   * the offline analysis pass (docs/ANALYSIS.md), and returns a complete
   * file-audio `SessionDoc` (§9 of the analysis-integration task) — Playwright
   * specs can't hand this harness a real audio file, so this is the file-audio
   * equivalent of `synthesizeTestTone` above. `seconds` should be >= 8s so the
   * beat tracker has enough track to lock tempo.
   */
  makeFileSessionDoc(seconds: number): unknown
  /** Code layer (ARCHITECTURE.md §3.3): hot-recompile a shader stage. Returns
   * the GLSL error message on failure, or null on success. */
  setShaderSource(key: string, source: string): string | null
  /** Code layer stages the current scene exposes; `[]` if it has none. */
  getShaderSources(): { key: string; source: string }[]
}

declare global {
  interface Window {
    __viz?: VizTestApi
  }
}

const TEST_TONE_SAMPLE_RATE = 44100
const TEST_TONE_LEFT_HZ = 220
const TEST_TONE_RIGHT_HZ = 330
const TEST_TONE_AMPLITUDE = 0.3

/**
 * A deterministic stereo test tone for export audio-muxing tests (no `Math.random`,
 * no wall clock — plain `Math.sin` over the sample index, same every run). Left
 * channel 220Hz, right channel 330Hz, so a decoded export can be told apart from
 * silence and from a mono track by inspection.
 */
function synthesizeTestTone(seconds: number): ExportAudio {
  const n = Math.max(0, Math.round(seconds * TEST_TONE_SAMPLE_RATE))
  const left = new Float32Array(n)
  const right = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    left[i] = TEST_TONE_AMPLITUDE * Math.sin((2 * Math.PI * TEST_TONE_LEFT_HZ * i) / TEST_TONE_SAMPLE_RATE)
    right[i] = TEST_TONE_AMPLITUDE * Math.sin((2 * Math.PI * TEST_TONE_RIGHT_HZ * i) / TEST_TONE_SAMPLE_RATE)
  }
  return { channels: [left, right], sampleRate: TEST_TONE_SAMPLE_RATE }
}

// --- File-audio session fixture (docs/ANALYSIS.md §11's kicks+hats+noise
// fixture, adapted to raw PCM — mirrors tests/unit/analysis.test.ts's synth) --

const KICK_SAMPLE_RATE = 44100
const KICK_BPM = 120
const KICK_TAU = 0.055
const KICK_FREQ = 60
const HAT_TAU = 0.02
const KICK_NOISE_AMP = 0.02
const KICK_TRACK_SEED = 42

/** Deterministic 120 BPM kick+hat+noise PCM (mulberry32-seeded, no Math.random). */
function synthesizeKickTrackPCM(seconds: number): Float32Array {
  const beatSec = 60 / KICK_BPM
  const rng = mulberry32(KICK_TRACK_SEED)
  const n = Math.max(0, Math.round(seconds * KICK_SAMPLE_RATE))
  const pcm = new Float32Array(n)
  const kickTimes: number[] = []
  const hatTimes: number[] = []
  for (let t = 0; t < seconds; t += beatSec) kickTimes.push(t)
  for (let t = beatSec / 2; t < seconds; t += beatSec) hatTimes.push(t)
  for (let i = 0; i < n; i++) {
    const t = i / KICK_SAMPLE_RATE
    let s = 0
    for (const kt of kickTimes) {
      const rel = t - kt
      if (rel >= 0) s += Math.exp(-rel / KICK_TAU) * Math.sin(2 * Math.PI * KICK_FREQ * rel)
    }
    for (const ht of hatTimes) {
      const rel = t - ht
      if (rel >= 0) s += 0.6 * Math.exp(-rel / HAT_TAU) * (2 * rng() - 1)
    }
    s += KICK_NOISE_AMP * (2 * rng() - 1)
    pcm[i] = s
  }
  return pcm
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
  // Scene selector (docs/PARTICLES.md's "accepted flags" #1): defaults to
  // lissajous for every pre-existing test. Unknown ids fail loudly rather than
  // silently falling back, so a typo'd golden test doesn't boot the wrong scene.
  const sceneId = params.get('scene') ?? 'lissajous'
  const sceneEntry = SCENES[sceneId]
  if (!sceneEntry) throw new Error(`unknown scene ${sceneId}`)

  const canvas = document.createElement('canvas')
  canvas.style.imageRendering = 'pixelated'
  root.appendChild(canvas)

  const scene = sceneEntry.create()

  // Test-mode-only sim-grid override (docs/GRAYSCOTT.md §9 accepted flag #2):
  // ?grid=128 bakes a smaller Gray-Scott ping-pong texture than the 256²
  // ship default, keeping golden-test runtime bounded on SwiftShader. Not
  // part of SceneRuntime — only scenes that specifically expose a
  // `setGridSize` (currently just grayscott) respond; every other scene
  // ignores an unknown/absent ?grid=. MUST run before `Engine`'s constructor
  // calls `scene.init()` — there is no resize-in-place path.
  const grid = params.get('grid')
  if (grid !== null && 'setGridSize' in scene && typeof (scene as { setGridSize?: unknown }).setGridSize === 'function') {
    ;(scene as { setGridSize: (n: number) => void }).setGridSize(Number(grid))
  }

  const engine = new Engine(canvas, scene, {
    mode: 'render',
    seed,
    width,
    height,
    fps: 30,
  })

  // Test-mode-only particle-count override (docs/PARTICLES.md §9): golden tests
  // for the particles family bake a smaller ladder rung than the 65536 default
  // to keep SwiftShader CI runtime bounded. Harmless on scenes without a
  // `count` param (setParam just stores an unused value). Applied before the
  // first renderFrames() call, so frame 1 already renders at the requested count.
  const count = params.get('count')
  if (count !== null) engine.setParam('count', Number(count))

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
      // `audioSeconds` is test-harness-only sugar: Playwright specs can't hand us
      // a real audio file, so passing this synthesizes a deterministic tone here
      // and forwards it as `ExportAudio` — the real exportSession() API (and the
      // opts type it expects) is unaware this key ever existed.
      const { audioSeconds, ...videoOpts } = opts as ExportVideoOpts & {
        collectHashes?: boolean
        audioSeconds?: number
      }
      const audio = audioSeconds !== undefined ? synthesizeTestTone(audioSeconds) : undefined
      const result = await exportSession(doc as SessionDoc, videoOpts, undefined, audio)
      const magic = Array.from(new Uint8Array(result.buffer.slice(0, 4)))
      return {
        size: result.buffer.byteLength,
        mime: result.mime,
        fileExtension: result.fileExtension,
        audioSkipped: result.audioSkipped,
        frameHashes: result.frameHashes,
        magic,
      }
    },
    setShaderSource: (key, source) => {
      try {
        engine.setShaderSource(key, source)
        return null
      } catch (err) {
        return err instanceof Error ? err.message : String(err)
      }
    },
    getShaderSources: () => engine.getShaderSources().map(({ key, source }) => ({ key, source })),
    makeFileSessionDoc: (seconds) => {
      const pcm = synthesizeKickTrackPCM(seconds)
      const timeline = analyzeAudio(pcm, KICK_SAMPLE_RATE)
      return {
        version: 1,
        seed: 42,
        fps: 30,
        scene: { id: engine.scene.meta.id, params: {} },
        bindings: {
          trail: '0.05 + 0.3 * env(0.005, 0.15, beat)',
          freqY: '2 + 2*step(0.5, beatPhase)',
        },
        audio: { kind: 'file', name: 'fixture', timeline: serializeTimeline(timeline) },
        durationFrames: 90,
        events: [],
      }
    },
  }
}
