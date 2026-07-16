import { useEffect, useRef, useState } from 'react'
import { Engine } from '../engine/engine'
import { SCENES } from '../scenes/registry'
import { attachKeyboard } from '../mapping/keyboard'
import { attachMidi, type MidiDevice, type MidiHandle, type MidiSink } from '../mapping/midi'
import { MACRO_SLOT_COUNT } from '../engine/macroRouter'
import { serializeSession, parseSession } from '../session/serialize'
import type { SessionDoc } from '../session/types'
import { exportSession } from '../export/client'
import type { ExportProgress } from '../export/render'
import type { ExportCodec } from '../export/encode'
import { RotaryKnob } from './RotaryKnob'
import { useParamBinding } from './paramBinding'
import './app.css'

const SIGNAL_NAMES = ['rms', 'bass', 'mid', 'high', 'beat', 'onset']
const KEYBOARD_HINT = '1-6 freqX · q/w/e freqY · space pulse drift · f/g flash/fade trail'

/**
 * A narrow Playwright-only hook onto the REAL App's engine (docs/MACROS.md
 * §6): `window.__viz` (src/testing/hooks.ts) only exists under the `?test=1`
 * harness, which bypasses React entirely (see main.tsx) — there is no
 * RotaryKnob/perform-strip DOM there at all. But the macro e2e spec needs to
 * assert a REAL perform-strip rotary visibly tracks a macro-driven param, and
 * headless Chromium's WebMIDI always rejects (see midi.spec.ts's docstring),
 * so real hardware can't be simulated either. `__vizLive.setInputSignal` is
 * the seam: it's exactly what a mapped MIDI CC would have written, called
 * directly, against the real live-mode Engine backing the real UI. Kept
 * separate from `VizTestApi`'s type (not a union on `window.__viz`) since
 * most of that interface — `renderFrames`, `exportSession`, … — assumes
 * render-mode and doesn't apply to a live rAF-driven engine.
 */
export interface VizLiveTestApi {
  setInputSignal(name: string, value: number): void
  /** Read a live param value — full-chain MIDI integration assertions
   * (tests/e2e/midiIntegration.spec.ts) verify hardware→router→param. */
  getParam(name: string): number
  /** The live scene's param schemas, for positional macro assertions. */
  sceneParams(): { name: string; min: number; max: number; default: number }[]
  /** `lastSession.durationFrames / lastSession.fps` (seconds), or `null` if no
   * take has ended yet — lets an e2e test verify a take's recorded length
   * against real elapsed wall time (tests/e2e/performanceModel.spec.ts) without
   * scraping the take card's rendered mm:ss text. */
  lastTakeDuration(): number | null
}

declare global {
  interface Window {
    __vizLive?: VizLiveTestApi
  }
}

// docs/MACROS.md §5: the eight Controls 1-8 slot numbers, for the disclosure's
// row list and the "Map controls…" sequential-learn loop.
const MACRO_SLOTS = Array.from({ length: MACRO_SLOT_COUNT }, (_, i) => i + 1)

const DEFAULT_SCENE_ID = 'lissajous'

// Photo Swarm task: imported images are downscaled to this max dimension
// before being handed to the engine — keeps the per-session base64 snapshot
// bounded (MAX_IMAGE_PIXELS in session/serialize.ts is 65536 = 256x256) and
// keeps CPU importance-sampling cheap regardless of the source photo's size.
const MAX_IMAGE_DIM = 256

/**
 * Decodes a picked image file, downscales it (canvas 2D — this is a live-
 * input adapter, so browser-dependent resampling is fine; REQUIREMENTS.md's
 * determinism rule is about scene/engine code, not the one-time act of
 * turning a user file into pixels) so its longer side is at most
 * `MAX_IMAGE_DIM`, and returns raw RGBA bytes ready for `Engine.setSceneImage`.
 */
async function loadAndDownscaleImage(file: File): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas context unavailable')
    ctx.drawImage(bitmap, 0, 0, width, height)
    return { width, height, data: ctx.getImageData(0, 0, width, height).data }
  } finally {
    bitmap.close()
  }
}

/** Creates and starts the normal live-mode engine on a canvas (factored out so
 * it can be re-invoked after a session replay finishes, or after switching
 * scenes from the panel dropdown). */
function createLiveEngine(canvas: HTMLCanvasElement, sceneId: string, audio?: Engine['audio']): Engine {
  const entry = SCENES[sceneId]
  if (!entry) throw new Error(`unknown scene ${sceneId}`)
  const e = new Engine(canvas, entry.create(), {
    mode: 'live',
    seed: 42,
    width: 960,
    height: 540,
    // Scene switches hand the previous engine's AudioEngine through so the
    // loaded track (and the transport row) survives the rebuild.
    audio,
  })
  e.start()
  return e
}

/** Triggers a browser download of a blob under the given filename. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Triggers a browser download of a session doc as a JSON file. */
function downloadSession(doc: SessionDoc): void {
  downloadBlob(new Blob([serializeSession(doc)], { type: 'application/json' }), 'visualz-session.json')
}

/** Export format picker's options: 'auto' leaves `codec` unset so `detectExportCodec`
 * (export/encode.ts) picks — otherwise pins the codec explicitly (e.g. to force MP4
 * on a desktop Chrome that has no AAC encoder, accepting a video-only export). */
type ExportFormatChoice = 'auto' | 'mp4' | 'webm'

function resolveExportCodec(choice: ExportFormatChoice): ExportCodec | undefined {
  if (choice === 'mp4') return 'h264'
  if (choice === 'webm') return 'vp9'
  return undefined
}

/** mm:ss, floored to whole seconds — used by the transport row's scrub readout. */
function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** The MIDI section's one-line status ("MIDI: 2 inputs" / "no inputs" / "not supported"). */
function formatMidiStatus(supported: boolean, deviceCount: number): string {
  if (!supported) return 'MIDI: not supported in this browser'
  if (deviceCount === 0) return 'MIDI: no inputs'
  return `MIDI: ${deviceCount} input${deviceCount === 1 ? '' : 's'}`
}

// --- Performance model (rehearsal / armed / performing) ---------------------
// User-reported problem: record/play/export read as "a confusing mess", and
// takes came out LONGER than the actual performance because the transport ⏹
// was a no-op while recording (engine.stopAudio's isRecording gate) — the
// user stopped nothing, and the take kept running until they found the
// Record button's own Stop. The fix is an explicit three-state model with
// exactly one way to end a take: REHEARSAL (default, nothing recorded) ->
// ARMED (▶ starts audio+take together) -> PERFORMING (⏹ ends the take AND
// stops the audio at that instant; the track's natural end also ends it).
// `recording`/`armed` already carry this as two booleans; `performanceModeOf`
// is just the one-line derivation shared by the footer and the perform strip.
type PerformanceMode = 'rehearsal' | 'armed' | 'performing'

function performanceModeOf(recording: boolean, armed: boolean): PerformanceMode {
  return recording ? 'performing' : armed ? 'armed' : 'rehearsal'
}

// --- View modes -------------------------------------------------------------
// studio: the original layout (this file, untouched below). perform: canvas
// almost-fullscreen with a single slim control strip — the "flick to big
// visuals, tweak via MIDI hardware" mode. full: true Fullscreen-API fullscreen
// on the stage container, zero chrome — Esc (browser-handled) or V exits.
type ViewMode = 'studio' | 'perform' | 'full'

/** Studio panel's SampleArk-style tab row (task: regroup the panel into
 * tabs so the column stops growing to whatever-is-expanded height). SCENE
 * is the default so casual use (knobs) is one click away; SESSION/INPUTS/
 * CODE hold the deeper tools. */
type StudioTab = 'scene' | 'session' | 'inputs' | 'code'
const STUDIO_TABS: Array<[StudioTab, string]> = [
  ['scene', 'SCENE'],
  ['session', 'SESSION'],
  ['inputs', 'INPUTS'],
  ['code', 'CODE'],
]

/** Same convention as mapping/keyboard.ts's isEditableTarget, plus `select` —
 * this is a UI-level shortcut (not a mapping-table binding) and the panel has
 * dropdowns (scene, export format) a stray "v" keystroke shouldn't hijack. */
function isFormFieldTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  const tag = el && typeof el.tagName === 'string' ? el.tagName.toLowerCase() : ''
  return tag === 'input' || tag === 'textarea' || tag === 'select'
}

/** Vendor-prefix-tolerant Fullscreen API surface — only Safari-family browsers
 * still need the `webkit` prefix, and iPhone Safari has no element fullscreen
 * at all (perform mode is the fallback there per REQUIREMENTS.md's platform note). */
type FullscreenDoc = Document & {
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => void
}
type FullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => void }

function fullscreenApiAvailable(): boolean {
  const el = document.documentElement as FullscreenElement
  return typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function'
}

function currentFullscreenElement(): Element | null {
  return document.fullscreenElement ?? (document as FullscreenDoc).webkitFullscreenElement ?? null
}

function requestFullscreenOn(el: HTMLElement): Promise<void> {
  const anyEl = el as FullscreenElement
  if (typeof anyEl.requestFullscreen === 'function') return anyEl.requestFullscreen()
  if (typeof anyEl.webkitRequestFullscreen === 'function') {
    anyEl.webkitRequestFullscreen()
    return Promise.resolve()
  }
  return Promise.reject(new Error('Fullscreen API unavailable'))
}

function exitFullscreenIfActive(): Promise<void> {
  const doc = document as FullscreenDoc
  if (document.fullscreenElement) return document.exitFullscreen()
  if (doc.webkitFullscreenElement && doc.webkitExitFullscreen) {
    doc.webkitExitFullscreen()
  }
  return Promise.resolve()
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<Engine | null>(null)
  const detachKeyboardRef = useRef<(() => void) | null>(null)
  const midiHandleRef = useRef<MidiHandle | null>(null)
  const meterIntervalRef = useRef<number | null>(null)
  const [engine, setEngine] = useState<Engine | null>(null)

  // --- MIDI (ARCHITECTURE.md §3.4's fourth mapping-table frontend) ---------
  // `midiSupported`/`midiDevices` mirror attachMidi's onChange callback so the
  // panel can render live device checkboxes; per-device active/inactive state
  // lives inside the MidiHandle itself (session-scoped only, per the task:
  // no localStorage here — a full persistence story is a later Electron-wrapper
  // task). `learnMode` is the global "Learn" toggle; `armedParam` is which
  // param a slider tweak most recently armed while learn mode is on — the next
  // CC/note from an *active* device binds to it, then only `armedParam` clears
  // (learn mode itself stays on so the next tweak can arm another param).
  const [midiSupported, setMidiSupported] = useState(false)
  const [midiDevices, setMidiDevices] = useState<MidiDevice[]>([])
  const [learnMode, setLearnMode] = useState(false)
  const [armedParam, setArmedParam] = useState<string | null>(null)
  // Collapsed by default (task: MIDI settings behind a button) — the tab
  // button itself is the only chrome shown until opened; learn mode keeps
  // working while collapsed since the armed highlight lives on the param
  // controls themselves, not inside this disclosure.
  const [midiOpen, setMidiOpen] = useState(false)
  // Kept in a ref too so the MIDI activity callback — set up once per engine
  // attach, same lifecycle as attachKeyboard's closure — always reads the
  // latest armed param rather than whatever was armed when it was created.
  const armedParamRef = useRef<string | null>(null)
  useEffect(() => {
    armedParamRef.current = armedParam
  }, [armedParam])
  // Escape (or clicking Learn again, handled in its own onClick) ends learn
  // mode entirely, per spec — not just clearing whichever param was armed.
  useEffect(() => {
    if (!learnMode) return
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setLearnMode(false)
        setArmedParam(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [learnMode])

  // --- Macro controls (docs/MACROS.md) -------------------------------------
  // `macroCcBySlot[i]` is the learned CC number for slot i+1 (`ctl.${i+1}`),
  // or `null` if unmapped. This is the "MIDI CC -> ctl.N" hardware mapping —
  // deliberately App-level state, not Engine state: it's scene-independent
  // and must survive every switch (§1/§3), and it outlives even a cold
  // scene-dropdown swap (attachLiveEngine/detachLiveEngine never touch it)
  // since remapping hardware after every scene change would defeat the whole
  // point of macros. Kept in a ref too, mirroring armedParamRef above, so the
  // MIDI activity callback (set up once per engine attach) always reads the
  // latest mapping rather than whatever it was when attached.
  const [macroCcBySlot, setMacroCcBySlot] = useState<(number | null)[]>(() => new Array(MACRO_SLOT_COUNT).fill(null))
  const macroCcBySlotRef = useRef(macroCcBySlot)
  useEffect(() => {
    macroCcBySlotRef.current = macroCcBySlot
  }, [macroCcBySlot])
  // Non-null while "Map controls…" (sequential) or a per-row relearn (single)
  // is in progress; `slot` is the next (or the only, for `single`) slot a
  // matching CC will claim. Mirrors armedParamRef's ref-shadow pattern for
  // the same reason: the activity callback must see live updates.
  const [macroLearn, setMacroLearn] = useState<{ mode: 'sequential' | 'single'; slot: number } | null>(null)
  const macroLearnRef = useRef(macroLearn)
  useEffect(() => {
    macroLearnRef.current = macroLearn
  }, [macroLearn])
  /** Ends any in-progress per-param learn — called when macro learn starts,
   * so the two learn flows (per-param vs. Controls 1-8) never fight over the
   * same incoming CC (docs/MACROS.md §5: the per-param flow "stays untouched"
   * but the two are still mutually exclusive UI *modes*). */
  const cancelParamLearn = () => {
    setLearnMode(false)
    setArmedParam(null)
  }
  // Esc ends an in-progress macro-learn early (spec: "Esc/click ends early"),
  // same pattern as the per-param learnMode effect above.
  useEffect(() => {
    if (!macroLearn) return
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setMacroLearn(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [macroLearn])

  const [sceneId, setSceneId] = useState(DEFAULT_SCENE_ID)
  // Scene handoff (docs/HANDOFF.md §6): `switchTargetId` is the currently
  // selected hand-off target (a registry id, independent of the cold-swap
  // scene dropdown above); `sceneVersion` bumps on every successful switch so
  // the scene-derived sections below (params panel, shader panel) remount and
  // re-read state from `engine.scene` — switchScene mutates the SAME Engine
  // instance in place, so `engine`'s own object identity never changes and
  // can't be relied on to trigger a refresh the way a scene-dropdown rebuild does.
  const [switchTargetId, setSwitchTargetId] = useState<string>(() => {
    const ids = Object.keys(SCENES)
    return ids.find((id) => id !== DEFAULT_SCENE_ID) ?? ids[0] ?? DEFAULT_SCENE_ID
  })
  const [sceneVersion, setSceneVersion] = useState(0)
  // Mirrors armedParamRef below: the hotkey listener is attached once and must
  // always read the latest selected target, not whatever was selected when it
  // was set up.
  const switchTargetIdRef = useRef(switchTargetId)
  useEffect(() => {
    switchTargetIdRef.current = switchTargetId
  }, [switchTargetId])
  const [levels, setLevels] = useState<Record<string, number>>({})
  // Live-hardware-sync: a snapshot of every current scene param's engine-side
  // value, refreshed on the same 100ms poll as the signal meters. Bound
  // params (MIDI-learned or expression-driven) render THIS value instead of
  // their own local interactive state, so a Knob/RotaryKnob visibly tracks
  // the hardware/expression rather than freezing at whatever it read on
  // mount. Unbound params ignore this entirely — reading it via the cheap
  // `engine.scene.getParam` getter (not a state mutation of the scene) means
  // the poll never fights a user's in-progress drag on an unbound control.
  const [paramValues, setParamValues] = useState<Record<string, number>>({})
  const [trackName, setTrackName] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  // Three-state performance model (rehearsal/armed/performing — see
  // PerformanceModeLine below): "Arm" with a track loaded but not playing
  // just arms; the next ▶ press starts audio AND the session recording in the
  // same tick — a synced start, so takes armed from a full stop align exactly
  // with the beginning of the track. Arm pressed WHILE playing (or in demo
  // mode, which is always "dancing") arms-and-starts immediately — one
  // button, one concept, replacing the old separate instant-Record path.
  const [armed, setArmed] = useState(false)
  // The transport.frame a take started on (see beginTake) — the live "● TAKE
  // 0:23" counter (100ms poll, attachLiveEngine) is (transport.frame - this) /
  // transport.fps, deterministic frame arithmetic rather than a wall-clock
  // read (this file is src/app/, so Date.now()/performance.now() would be
  // ALLOWED per the hard rule, but the frame counter is already exactly
  // right and stays correct even if a tab throttles rAF).
  const recordingStartFrameRef = useRef<number | null>(null)
  const [takeElapsedSec, setTakeElapsedSec] = useState(0)
  // True whenever `lastSession` holds a take that ended (Stop/End
  // take/natural end/scene-switch-mid-take) but hasn't been exported or
  // discarded yet — drives the SESSION tab's dot badge and the footer's
  // "take ready" one-liner (task 3). Cleared by the take card's own Export
  // and Discard actions; loading/replaying an unrelated saved-take file never
  // touches it.
  const [takeReady, setTakeReady] = useState(false)
  const [replay, setReplay] = useState<{ frame: number; total: number } | null>(null)
  const [exporting, setExporting] = useState<{ frame: number; total: number } | null>(null)
  const [sessionError, setSessionError] = useState<string | null>(null)
  // Non-fatal note from the most recent export — currently only set when an
  // H.264/MP4 export dropped its audio track because AAC isn't available in
  // this browser (see EncodedResult.audioSkipped in export/encode.ts).
  const [exportNote, setExportNote] = useState<string | null>(null)
  // Export format picker: 'auto' (default) lets detectExportCodec choose;
  // 'mp4'/'webm' pin the codec explicitly (e.g. forcing MP4 on a browser that
  // can't encode AAC, accepting a video-only export to add sound in post).
  const [exportFormat, setExportFormat] = useState<ExportFormatChoice>('auto')
  // Transport row (play/pause/stop/seek): polled the same way as the signal
  // meters below, not driven by its own rAF — see attachLiveEngine.
  const [playback, setPlayback] = useState({ time: 0, duration: 0, playing: false, hasFile: false })
  // The most recently recorded session, kept in memory so Replay/Export/Save work
  // directly after Stop — no round-trip through the file system (essential on
  // iPhone, where re-picking a just-saved file is clumsy).
  const [lastSession, setLastSession] = useState<SessionDoc | null>(null)
  // Mirrors armedParamRef/switchTargetIdRef above: window.__vizLive.lastTakeDuration
  // is defined once per engine attach but must always read the CURRENT
  // lastSession, not whichever one existed when that closure was created.
  const lastSessionRef = useRef<SessionDoc | null>(null)
  useEffect(() => {
    lastSessionRef.current = lastSession
  }, [lastSession])
  // Photo Swarm task: the last image picked via the Image input, kept outside
  // any single Engine instance so it survives a scene switch, which tears
  // down the whole Engine (a fresh scene instance per docs/PARTICLES.md §0 —
  // there's no in-place scene-swap hook) and would otherwise lose it.
  const imageRef = useRef<{ width: number; height: number; data: Uint8ClampedArray } | null>(null)
  const [imageName, setImageName] = useState<string | null>(null)
  // iOS: an AudioContext started outside a still-valid user gesture stays
  // suspended and plays SILENTLY (the graph runs, no sound). Detected by
  // polling contextState while a file is "playing"; the fix is a button whose
  // tap (a guaranteed-valid gesture) resumes the context.
  const [audioBlocked, setAudioBlocked] = useState(false)

  // --- View modes (studio / perform / full) --------------------------------
  const [viewMode, setViewMode] = useState<ViewMode>('studio')
  // Computed once — feature detection, not per-frame state — and used both to
  // decide whether "V"/the cycle button ever reach 'full' and to hide the
  // perform strip's "Full screen" button on platforms without it (iPhone Safari).
  const [fullscreenSupported] = useState(() => fullscreenApiAvailable())

  // Studio panel tabs: all four tabs' content stays mounted at all times —
  // visibility toggles via the `hidden` attribute (app.css's
  // `.panel-tab-content[hidden]`), not conditional rendering, so switching
  // tabs never resets in-progress state (an unsaved shader edit, the MIDI
  // disclosure's open/closed state, learn mode).
  const [activeTab, setActiveTab] = useState<StudioTab>('scene')

  /** studio -> perform -> full -> studio; skips 'full' entirely where the
   * Fullscreen API is unavailable, so it becomes a plain two-state toggle. */
  const cycleViewMode = () => {
    setViewMode((v) => {
      if (v === 'studio') return 'perform'
      if (v === 'perform') return fullscreenSupported ? 'full' : 'studio'
      return 'studio'
    })
  }

  // Mirrors switchTargetIdRef/armedParamRef below: requestFullscreenOn's
  // promise resolves asynchronously, so the effect that awaits it needs a
  // way to read the LATEST viewMode rather than whatever it closed over when
  // the request was fired.
  const viewModeRef = useRef(viewMode)
  useEffect(() => {
    viewModeRef.current = viewMode
  }, [viewMode])

  // Keeps the actual browser fullscreen state in sync with `viewMode`: enters
  // when it becomes 'full', exits otherwise. Guarded on the stage element
  // already being (or not being) the fullscreen element so this doesn't fight
  // the fullscreenchange-driven resync effect below.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    if (viewMode === 'full') {
      if (currentFullscreenElement() !== stage) {
        requestFullscreenOn(stage)
          .then(() => {
            // Rapid-V race (review finding): the user may have already left
            // 'full' by the time this async request resolves. Don't leave
            // the browser truly fullscreen while viewMode has moved on —
            // exit immediately rather than waiting for the effect above to
            // notice (it won't re-run; viewMode didn't change again).
            if (viewModeRef.current !== 'full') {
              exitFullscreenIfActive().catch(() => {})
            }
          })
          .catch(() => {
            // Fullscreen request rejected (e.g. no user-activation left, or a
            // feature-detection false positive) — fall back to perform rather
            // than leaving viewMode stuck on an unrealized 'full'.
            setViewMode('perform')
          })
      }
    } else if (currentFullscreenElement() === stage) {
      exitFullscreenIfActive().catch(() => {})
    }
  }, [viewMode])

  // The browser can exit fullscreen for reasons outside our control (Esc, OS
  // gesture, tab switch) — resync viewMode down to 'perform' whenever that
  // happens so the UI never claims 'full' while the browser is windowed.
  useEffect(() => {
    const onFullscreenChange = () => {
      if (!currentFullscreenElement()) {
        setViewMode((v) => (v === 'full' ? 'perform' : v))
      }
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    document.addEventListener('webkitfullscreenchange', onFullscreenChange)
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange)
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange)
    }
  }, [])

  // "V" (view) cycles view modes — a UI-level shortcut, not a mapping-table
  // binding (those stay live regardless of view mode via attachKeyboard
  // below). Deliberately NOT "f": the default mappings bind f/g to the trail
  // flash/fade, and one keystroke doing both a view change and a visual flash
  // reads as a glitch. "v" is unclaimed by any default mapping. Guarded the
  // same way mapping/keyboard.ts guards typing, plus `select` (see
  // isFormFieldTarget) since this shortcut isn't scoped to the canvas.
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.repeat || isFormFieldTarget(ev.target)) return
      if (ev.key.toLowerCase() !== 'v') return
      cycleViewMode()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cycleViewMode closes over fullscreenSupported, which never changes after mount
  }, [])

  /** Wires up live-only side effects (signal meter polling, keyboard) for an engine. */
  const attachLiveEngine = (e: Engine) => {
    engineRef.current = e
    setEngine(e)
    window.__vizLive = {
      setInputSignal: (name, value) => e.setInputSignal(name, value),
      getParam: (name) => e.scene.getParam(name),
      sceneParams: () =>
        e.scene.params.map((p) => ({ name: p.name, min: p.min, max: p.max, default: p.default })),
      lastTakeDuration: () => {
        const doc = lastSessionRef.current
        return doc ? doc.durationFrames / doc.fps : null
      },
    }
    meterIntervalRef.current = window.setInterval(() => {
      setLevels(e.bus.snapshot())
      setAudioBlocked(e.audio.isPlaying && e.audio.contextState !== 'running')
      setPlayback({
        time: e.audio.time,
        duration: e.audio.duration,
        playing: e.audio.isPlaying,
        hasFile: e.audio.hasFile,
      })
      // `e.scene` (not the closed-over `sceneId`/`sceneVersion`) so this
      // stays correct across an in-place handoff switch, which mutates
      // engine.scene without recreating this interval.
      const values: Record<string, number> = {}
      for (const p of e.scene.params) values[p.name] = e.scene.getParam(p.name)
      setParamValues(values)
      // Footer/perform-strip "● TAKE 0:23" counter: frame arithmetic against
      // the deterministic transport, not a wall-clock read (see
      // recordingStartFrameRef's comment).
      if (e.isRecording && recordingStartFrameRef.current !== null) {
        setTakeElapsedSec(Math.max(0, (e.transport.frame - recordingStartFrameRef.current) / e.transport.fps))
      }
      // PERFORMING has exactly one way to end (task): the track reaching its
      // natural end must end the take automatically, same as a manual ⏹.
      // While recording, every other transport control (pause/seek/stop) is
      // gated off both in the UI and by the engine's isRecording no-op guard,
      // so `hasFile && !isPlaying` here can only mean the source's `onended`
      // fired — never a pause the user triggered. endTake() re-checks
      // `engine.isRecording` itself, so this can never double-fire against a
      // manual ⏹ click that landed the same tick.
      if (e.isRecording && e.audio.hasFile && !e.audio.isPlaying) {
        endTake()
      }
    }, 100)
    detachKeyboardRef.current = attachKeyboard(window, (event) => e.queueInput(event))
    // docs/MACROS.md CC-remap seam: `attachMidi`/`mapping/midi.ts` stay exactly
    // as they were (no engine- or mapping-layer change at all) — App wraps the
    // `MidiSink` it hands to `attachMidi` instead. `midi.cc.<n>` keeps
    // publishing under its own name (so the existing per-param learn flow,
    // which binds expressions directly to `midi.cc.<n>`, is untouched), and
    // ADDITIONALLY republishes as `ctl.<slot>` when that CC has been mapped to
    // a Controls 1-8 slot. This was chosen over the alternative (an optional
    // `ccRemap` param on `attachMidi` itself) because the remap is pure
    // App-level UI state (docs/MACROS.md §3: "session-scoped app state...NOT
    // stored in the doc") — keeping `mapping/midi.ts`'s interface untouched
    // means the remap can never leak into what counts as a "device"/"frontend"
    // at the mapping-layer, and there's nothing for a future non-MIDI macro
    // source (a future OSC/gamepad frontend, say) to have to route through.
    const midiSink: MidiSink = {
      queueInput: (event) => e.queueInput(event),
      setInputSignal: (name, value) => {
        e.setInputSignal(name, value)
        const m = /^midi\.cc\.(\d+)$/.exec(name)
        if (!m) return
        const cc = Number(m[1])
        const slotIndex = macroCcBySlotRef.current.findIndex((mapped) => mapped === cc)
        if (slotIndex >= 0) e.setInputSignal(`ctl.${slotIndex + 1}`, value)
      },
    }
    midiHandleRef.current = attachMidi(
      midiSink,
      (state) => {
        setMidiSupported(state.supported)
        setMidiDevices(state.devices)
      },
      (signalName) => {
        // Controls 1-8 mapping (docs/MACROS.md §5) takes priority when a
        // sequential "Map controls…" pass or a per-row relearn is in progress:
        // the next CC claims the armed slot instead of (also) feeding the
        // per-param learn flow below. Notes don't claim macro slots (the spec
        // frames this as "turn hardware knobs" — CCs only) but are still
        // swallowed here so a stray note during Map Controls can't fall
        // through and arm a per-param bind.
        const macro = macroLearnRef.current
        if (macro) {
          const m = /^midi\.cc\.(\d+)$/.exec(signalName)
          if (m) {
            const cc = Number(m[1])
            // DISTINCT-CC guard (review finding): a single encoder sweep emits
            // dozens of CC messages, and native MIDI events flush React state
            // between them — without a synchronous check one knob turn could
            // claim several sequential slots (all with the same CC). The spec
            // says "each DISTINCT CC claims the next slot": a CC already
            // mapped to any slot is a no-op (doesn't advance), and the armed
            // slot is advanced on the REF synchronously, mirroring the
            // per-param path's burst defense below.
            const already = macroCcBySlotRef.current.indexOf(cc)
            if (macro.mode === 'sequential' && already >= 0) return
            const claimed = [...macroCcBySlotRef.current]
            // Single-mode re-learn MOVES a CC (clears its old slot) rather
            // than refusing it — re-arranging hardware must stay possible.
            if (already >= 0) claimed[already] = null
            claimed[macro.slot - 1] = cc
            macroCcBySlotRef.current = claimed
            setMacroCcBySlot(claimed)
            if (macro.mode === 'single' || macro.slot >= MACRO_SLOT_COUNT) {
              macroLearnRef.current = null
              setMacroLearn(null)
            } else {
              macroLearnRef.current = { mode: 'sequential', slot: macro.slot + 1 }
              setMacroLearn(macroLearnRef.current)
            }
          }
          return
        }
        // Learn mode: the next CC/note to arrive from an active device while
        // a param is armed binds it — `midi.cc.<n>`/`midi.note.<n>` are just
        // signal names, so this is exactly the same `setBinding` path the
        // expression text field uses (ARCHITECTURE.md §3.8's DSL grammar
        // already resolves bare identifiers as signals). Clear the ref
        // synchronously (not just the state) so a burst of messages from the
        // same encoder tick can't double-bind before React re-renders.
        const target = armedParamRef.current
        if (!target) return
        armedParamRef.current = null
        try {
          // Range-map the 0..1 MIDI signal onto the param's [min, max] (user
          // report: a full hardware sweep barely moved freqX — binding the
          // bare signal drove a 1..6 param with 0..1 values, clamped at the
          // bottom). Expressions output raw param VALUES, so learn writes the
          // mapping explicitly; it reads as ordinary editable DSL in the knob.
          const schema = e.scene.params.find((p) => p.name === target)
          const expr =
            schema && !(schema.min === 0 && schema.max === 1)
              ? `${schema.min} + ${+(schema.max - schema.min).toFixed(4)} * ${signalName}`
              : signalName
          e.setBinding(target, expr)
        } catch {
          // `midi.cc.<n>`/`midi.note.<n>` always compile; guard anyway rather
          // than crash on a future change to signal-name validity.
        }
        setArmedParam(null)
      },
    )
  }

  const detachLiveEngine = () => {
    window.__vizLive = undefined
    if (meterIntervalRef.current !== null) {
      clearInterval(meterIntervalRef.current)
      meterIntervalRef.current = null
    }
    detachKeyboardRef.current?.()
    detachKeyboardRef.current = null
    midiHandleRef.current?.detach()
    midiHandleRef.current = null
    setMidiDevices([])
    setLearnMode(false)
    setArmedParam(null)
    setArmed(false)
    // Ends any in-progress Controls 1-8 mapping (the old engine/MIDI handle
    // it was targeting is gone) — but NOT `macroCcBySlot` itself: the learned
    // CC->slot hardware mapping is scene-independent app state that must
    // survive even a cold scene-dropdown swap (docs/MACROS.md §1/§3).
    setMacroLearn(null)
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || engineRef.current) return
    attachLiveEngine(createLiveEngine(canvas, sceneId))
    return () => {
      detachLiveEngine()
      engineRef.current?.dispose()
      engineRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only; scene switches go through onSceneChange
  }, [])

  /** Scene dropdown handler: tears down the live engine and rebuilds it against
   * the newly chosen scene (a fresh instance — SceneRuntime has no scene-swap
   * hook, so this is a full dispose/recreate, same shape as onLoadSession's
   * live/replay handoff). */
  const onSceneChange = (id: string) => {
    const canvas = canvasRef.current
    if (!canvas || !SCENES[id]) return
    // A dropdown scene switch tears down the recorder with the engine; the
    // in-progress take used to vanish silently (review finding). Stop and
    // stash it instead — the mid-performance way to change visuals without
    // ending the take is the handoff switch (docs/HANDOFF.md), not this.
    if (engineRef.current?.isRecording) {
      stashTake(engineRef.current.stopRecording())
    }
    // The AudioEngine outlives the Engine across a scene switch: the track
    // keeps playing and the transport row stays put (keepAudio skips the
    // dispose-time stop; the new engine adopts it and fast-forwards its
    // transport to the audio position on start).
    const audio = engineRef.current?.audio
    detachLiveEngine()
    engineRef.current?.dispose({ keepAudio: true })
    engineRef.current = null
    setEngine(null)
    setRecording(false)
    setArmed(false)
    recordingStartFrameRef.current = null
    setSceneId(id)
    const newEngine = createLiveEngine(canvas, id, audio)
    // Reapply the last-picked image to the new scene, if it accepts one — the
    // new scene is a fresh instance (createLiveEngine builds a whole new
    // Engine) so it starts with no image of its own.
    if (imageRef.current && newEngine.sceneAcceptsImage()) {
      newEngine.setSceneImage(imageRef.current)
    }
    attachLiveEngine(newEngine)
  }

  /**
   * Scene handoff (docs/HANDOFF.md §4/§6): hands off to `targetId` IN PLACE —
   * unlike `onSceneChange` above, this does NOT tear down/rebuild the Engine;
   * `engine.switchScene` captures the live frame, builds B, ingests it, and
   * swaps `engine.scene` under the hood. Every path (button, hotkey, replay)
   * funnels through this one engine method so recording/replay stay identical
   * (invariant I6). Re-syncs the scene-derived UI afterward (§6): `setSceneId`
   * updates the label/dropdowns, `setSceneVersion` forces the params/shader
   * panels below to remount and re-read `engine.scene`, since the Engine
   * object itself never changes reference on an in-place switch.
   */
  const onSwitchScene = (targetId: string) => {
    const e = engineRef.current
    if (!e) return
    try {
      e.switchScene(targetId)
      setSceneId(targetId)
      setSceneVersion((v) => v + 1)
      setSessionError(null)
    } catch (err) {
      // Fail-safe per invariant I8: a throw (unknown id, B.init/B.ingest
      // failure) leaves the previous scene live and nothing recorded — just
      // surface the error, the engine already kept a working scene.
      setSessionError(err instanceof Error ? err.message : String(err))
    }
  }

  // Hotkey (docs/HANDOFF.md §6): "x", handled directly in App (not through the
  // mapping table — see the spec's rationale) — hands off to whichever target
  // is currently selected in the switch-control dropdown. Same guards as "v"'s
  // view-cycle listener (no repeat, not while typing in a form field).
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.repeat || isFormFieldTarget(ev.target)) return
      if (ev.key.toLowerCase() !== 'x') return
      onSwitchScene(switchTargetIdRef.current)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads engineRef/switchTargetIdRef, both refs kept fresh independently
  }, [])

  const onFile = async (file: File | undefined) => {
    if (!file || !engineRef.current) return
    // A new file auto-plays on decode; firing an armed recording off that
    // implicit start would be a surprise take — arming is per-track.
    setArmed(false)
    // Playback starts as soon as the file decodes; the offline analysis pass
    // runs in a background Worker with progress reported here, and the beat
    // grid hot-swaps in when it completes.
    setTrackName(`Loading ${file.name}…`)
    await engineRef.current.audio.playFile(file, (fraction) => {
      setTrackName(
        fraction >= 1 ? file.name : `${file.name} (analyzing ${Math.round(fraction * 100)}%)`,
      )
    })
    setTrackName((current) => (current?.startsWith('Loading') ? file.name : current))
  }

  const onImageFile = async (file: File | undefined) => {
    if (!file || !engineRef.current) return
    const engineAtPick = engineRef.current
    const nameBeforePick = imageName
    setImageName(`Loading ${file.name}…`)
    try {
      const img = await loadAndDownscaleImage(file)
      // The picker is disabled while recording, but a decode picked *before*
      // Record can resolve mid-recording. The image is a snapshot, not an
      // event — applying it now would change the live scene without entering
      // the session, so the export would not match the performance. Discard.
      if (engineRef.current !== engineAtPick || engineAtPick.isRecording) {
        setImageName(nameBeforePick)
        setSessionError('Image not applied: recording started while it was loading')
        return
      }
      imageRef.current = img
      engineAtPick.setSceneImage(img)
      setImageName(file.name)
    } catch (err) {
      setImageName(null)
      setSessionError(err instanceof Error ? err.message : String(err))
    }
  }

  /** Stashes a just-finished take's doc (if any) as `lastSession` and marks
   * the SESSION tab badge/footer "take ready" line live — the one path every
   * take-ending route (manual ⏹, RecordButton's "End take", the natural-end
   * poll, and a mid-take scene-dropdown switch) funnels through, so none of
   * them can forget to arm the badge. */
  const stashTake = (doc: SessionDoc | null) => {
    if (!doc) return
    setLastSession(doc)
    setTakeReady(true)
  }

  /** The ONE way a take ends (task): stop recording FIRST (clears
   * engine.isRecording) so the subsequent stopAudio() actually passes its
   * isRecording no-op gate — engine.ts's gate stays as the safety net, this
   * is the orchestration that makes it fire in the right order. Idempotent:
   * guards on `engine.isRecording` so the manual ⏹/"End take" click and the
   * natural-end poll (attachLiveEngine) can never double-fire against each
   * other. */
  const endTake = () => {
    const e = engineRef.current
    if (!e || !e.isRecording) return
    stashTake(e.stopRecording())
    setRecording(false)
    recordingStartFrameRef.current = null
    e.stopAudio()
  }

  /** Starts a take: engine.startRecording() (throws against a frozen
   * transport — should be unreachable given onToggleRecording's arm branch
   * and TransportRow's armed-play gate, both of which only call this once
   * audio is actually running) plus the App-side bookkeeping every take-start
   * path needs (the elapsed-counter baseline, the `recording` flag). Shared
   * by onToggleRecording's "arm while playing" branch and TransportRow's
   * armed ▶ press, so both starts look identical to everything downstream. */
  const beginTake = () => {
    const e = engineRef.current
    if (!e) return
    try {
      e.startRecording()
      recordingStartFrameRef.current = e.transport.frame
      setRecording(true)
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : String(err))
    }
  }

  const onToggleRecording = () => {
    const e = engineRef.current
    if (!e) return
    if (e.isRecording) {
      endTake()
    } else if (e.audio.hasFile && !e.audio.isPlaying) {
      // Recording can't start against a frozen transport (engine throws), so
      // with a stopped/paused track the button ARMS instead: the next ▶ press
      // starts audio and the recording together on the same frame.
      setArmed((a) => !a)
    } else {
      // Already playing (or demo mode, which is always "dancing", so there's
      // nothing to wait for) — Arm pressed here starts the take immediately.
      // This replaces the old separate instant-Record path: one button, one
      // concept (task).
      beginTake()
    }
  }

  const onLoadSession = async (file: File | undefined) => {
    if (!file) return
    setSessionError(null)
    let doc: SessionDoc
    try {
      doc = parseSession(await file.text())
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : String(err))
      return
    }
    replaySession(doc)
  }

  const replaySession = (doc: SessionDoc) => {
    setSessionError(null)
    const canvas = canvasRef.current
    if (!canvas) return

    // Stop and dispose the live engine before handing the canvas to a
    // render-mode replay engine.
    detachLiveEngine()
    engineRef.current?.dispose()
    engineRef.current = null
    setEngine(null)
    setRecording(false)

    // Any failure from here on (an uncompilable binding in a hand-edited session
    // throws DslError from loadSession or mid-replay from a binding event) must
    // land back in a working live engine, never a dead canvas.
    // The scene selected before this replay attempt — restoreLive() falls back
    // to it if the session's scene id turns out to be invalid.
    const previousSceneId = sceneId

    const restoreLive = () => {
      engineRef.current?.dispose()
      engineRef.current = null
      setReplay(null)
      const liveCanvas = canvasRef.current
      // Read directly rather than from the `sceneId` state closure: restoreLive
      // can fire synchronously (bad scene id) before a queued setSceneId below
      // has re-rendered this closure with the new value.
      const restoreSceneId = SCENES[doc.scene.id] ? doc.scene.id : previousSceneId
      if (!liveCanvas) return
      const newEngine = createLiveEngine(liveCanvas, restoreSceneId)
      if (imageRef.current && newEngine.sceneAcceptsImage()) {
        newEngine.setSceneImage(imageRef.current)
      }
      attachLiveEngine(newEngine)
    }

    let replayEngine: Engine
    try {
      const entry = SCENES[doc.scene.id]
      if (!entry) throw new Error(`unknown scene ${doc.scene.id}`)
      replayEngine = new Engine(canvas, entry.create(), {
        mode: 'render',
        seed: doc.seed,
        width: 960,
        height: 540,
        fps: 60,
      })
      engineRef.current = replayEngine
      replayEngine.loadSession(doc)
      // So the dropdown reflects reality once the replay finishes (rather than
      // snapping back to whatever was selected before Load & replay was clicked).
      setSceneId(doc.scene.id)
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : String(err))
      restoreLive()
      return
    }
    setReplay({ frame: 0, total: doc.durationFrames })

    const step = () => {
      if (engineRef.current !== replayEngine) return // superseded (e.g. unmount)
      try {
        replayEngine.renderFrames(1)
      } catch (err) {
        setSessionError(err instanceof Error ? err.message : String(err))
        restoreLive()
        return
      }
      const frame = replayEngine.transport.frame
      setReplay({ frame, total: doc.durationFrames })
      if (replayEngine.replayDone && frame >= doc.durationFrames) {
        restoreLive()
        return
      }
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  // Runs entirely in a Worker (export/client.ts) against its own OffscreenCanvas —
  // the live engine above keeps rendering to the visible canvas throughout.
  const onExportVideo = async (file: File | undefined) => {
    if (!file) return
    setSessionError(null)
    let doc: SessionDoc
    try {
      doc = parseSession(await file.text())
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : String(err))
      return
    }
    await exportVideo(doc)
  }

  const exportVideo = async (doc: SessionDoc) => {
    setSessionError(null)
    setExportNote(null)
    setExporting({ frame: 0, total: doc.durationFrames })
    try {
      // Carry the currently-loaded track's audio into the export, if any — a file
      // loaded into the live engine via onFile (REQUIREMENTS.md §5.1: exports mux
      // the audio track in). No file loaded (or the live engine has been swapped
      // for a replay engine) means a silent export, same as before this change.
      const audio = engineRef.current?.audio.lastBuffer() ?? undefined
      // 'auto' passes `codec: undefined`, so createVideoSink auto-detects
      // (VP9/WebM preferred where supported, H.264/MP4 fallback for iOS/macOS
      // Safari); 'mp4'/'webm' pin the codec explicitly (export/encode.ts).
      const result = await exportSession(
        doc,
        { width: 1280, height: 720, fps: doc.fps, codec: resolveExportCodec(exportFormat) },
        (p: ExportProgress) => setExporting({ frame: p.frame, total: p.total }),
        audio,
      )
      downloadBlob(new Blob([result.buffer], { type: result.mime }), `visualz-session.${result.fileExtension}`)
      if (result.audioSkipped) {
        setExportNote("Exported video-only MP4 — this browser can't encode AAC audio; add the track in post.")
      }
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(null)
    }
  }

  return (
    <div className={`app app-${viewMode}`}>
      <div className="stage" ref={stageRef}>
        <canvas ref={canvasRef} />
      </div>
      {/* SIBLING of .stage, not a child: .app-perform is a column flex layout
         where the stage takes flex:1 and this strip takes natural height BELOW
         it. Nested inside the stage it sat in flow after a height-100% canvas —
         pushed exactly off the bottom of the overflow-hidden app (found via
         screenshot pass: strip.top === viewport height, invisible). */}
      {viewMode === 'perform' && (
          <div className="perform-strip">
            {/* Thin params row above the main strip row (task: "ONE compact
               bar (params row may be a second thin row above the main strip
               row)") — one rotary per current-scene param, horizontally
               scrollable so it never forces the strip itself to wrap. Keyed
               on sceneVersion (docs/HANDOFF.md §6's remount convention, same
               as the studio panel's Knob list below) since an in-place
               handoff switch mutates engine.scene without changing the
               Engine's own identity. */}
            {engine && engine.scene.params.length > 0 && (
              <div className="perform-strip-params" key={`perform-params-${sceneId}-${sceneVersion}`}>
                {engine.scene.params.map((p, i) => (
                  <RotaryKnob
                    key={p.name}
                    engine={engine}
                    schema={p}
                    slot={i + 1}
                    liveValue={paramValues[p.name] ?? p.default}
                    learnArm={learnMode ? () => setArmedParam(p.name) : undefined}
                    armed={armedParam === p.name}
                  />
                ))}
              </div>
            )}
            <div className="perform-strip-main">
              <SceneSelect sceneId={sceneId} onChange={onSceneChange} disabled={replay !== null || exporting !== null} />
              {engine && (
                <SwitchControl
                  targetId={switchTargetId}
                  onTargetChange={setSwitchTargetId}
                  onSwitch={() => onSwitchScene(switchTargetId)}
                  disabled={replay !== null || exporting !== null}
                />
              )}
              {engine && playback.hasFile && (
                <TransportRow
                  engine={engine}
                  playback={playback}
                  recording={recording}
                  armed={armed}
                  setArmed={setArmed}
                  beginTake={beginTake}
                  endTake={endTake}
                />
              )}
              <PerformanceModeLine
                mode={performanceModeOf(recording, armed)}
                hasFile={playback.hasFile}
                takeSeconds={takeElapsedSec}
                compact
              />
              <RecordButton
                recording={recording}
                armed={armed}
                disabled={!engine || replay !== null || exporting !== null}
                onToggleRecording={onToggleRecording}
              />
              {/* Same global learn toggle as SCENE tab / MIDI disclosure (user
                 request): in perform view the rotaries above arm exactly like
                 the studio sliders, so learn belongs here too. The armed
                 rotary's highlight is the status; no room for the text line. */}
              {midiSupported && (
                <button
                  type="button"
                  className={`session-button${learnMode ? ' midi-learning' : ''}`}
                  title={
                    learnMode
                      ? armedParam
                        ? `learning "${armedParam}" — move a hardware control (Esc to stop)`
                        : 'learn on — tweak a dial, then move a hardware control (Esc to stop)'
                      : 'MIDI learn: tweak a dial, then move a hardware control'
                  }
                  onClick={() => {
                    setLearnMode((on) => {
                      const next = !on
                      if (!next) setArmedParam(null)
                      // Mutually exclusive with Controls 1-8 mapping (docs/MACROS.md
                      // §5): starting per-param learn cancels any in-progress macro learn.
                      else setMacroLearn(null)
                      return next
                    })
                  }}
                >
                  {learnMode ? 'Learning…' : 'MIDI learn'}
                </button>
              )}
              <div className="view-mode-buttons">
                {fullscreenSupported && (
                  <button type="button" className="session-button" onClick={() => setViewMode('full')}>
                    Full screen
                  </button>
                )}
                <button type="button" className="session-button" onClick={() => setViewMode('studio')}>
                  Studio
                </button>
              </div>
            </div>
          </div>
      )}
      {viewMode === 'studio' && (
      <aside className="panel">
        <div className="panel-header">
          <h1>Visualz</h1>
          <button type="button" className="session-button" onClick={() => setViewMode('perform')}>
            Perform view
          </button>
        </div>

        <div className="panel-tabs" role="tablist">
          {STUDIO_TABS.map(([tab, label]) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              className={`tab-button${activeTab === tab ? ' tab-button-active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {label}
              {/* Task 3: dot badge while an unexported take is sitting in the
                 SESSION tab's take card — cleared by that card's own Export
                 and Discard actions (same `takeReady` flag as the footer's
                 one-liner). */}
              {tab === 'session' && lastSession && takeReady && <span className="tab-badge" aria-hidden="true" />}
            </button>
          ))}
        </div>

        <div className="panel-content">
          {/* SCENE: scene select, hand-off control, param knobs, keyboard hint. */}
          <div className="panel-tab-content" role="tabpanel" hidden={activeTab !== 'scene'}>
            {engine && (
              // `key` forces this section to remount after a handoff (§6): an
              // in-place switchScene mutates `engine.scene` without changing the
              // Engine object's own identity, so `sceneVersion` is the only signal
              // that scene-derived state (Knobs' initial values, in particular)
              // needs to be re-read from scratch rather than reused across renders.
              <section key={`scene-${sceneId}-${sceneVersion}`}>
                <SceneSelect sceneId={sceneId} onChange={onSceneChange} disabled={replay !== null || exporting !== null} />
                <SwitchControl
                  targetId={switchTargetId}
                  onTargetChange={setSwitchTargetId}
                  onSwitch={() => onSwitchScene(switchTargetId)}
                  disabled={replay !== null || exporting !== null}
                />
                <div className="scene-params-header">
                  <h2>{engine.scene.meta.name}</h2>
                  {/* Same global learn toggle as the MIDI disclosure (INPUTS
                     tab) — surfaced here too because binding hardware to THIS
                     scene's params is a SCENE-tab activity (user request). */}
                  {midiSupported && (
                    <button
                      type="button"
                      className={`session-button tab-button${learnMode ? ' midi-learning' : ''}`}
                      onClick={() => {
                        setLearnMode((on) => {
                          const next = !on
                          if (!next) setArmedParam(null)
                          else setMacroLearn(null)
                          return next
                        })
                      }}
                    >
                      {learnMode ? 'Stop learning' : 'MIDI learn'}
                    </button>
                  )}
                </div>
                {learnMode && (
                  <p className="session-status">
                    {armedParam
                      ? `learning "${armedParam}" — move a hardware control (Esc to stop)`
                      : 'learn on — move a param slider, then a hardware control (Esc to stop)'}
                  </p>
                )}
                {engine.scene.params.map((p, i) => (
                  <Knob
                    key={p.name}
                    engine={engine}
                    schema={p}
                    slot={i + 1}
                    liveValue={paramValues[p.name] ?? p.default}
                    learnArm={learnMode ? () => setArmedParam(p.name) : undefined}
                    armed={armedParam === p.name}
                  />
                ))}
                <p className="keyboard-hint">{KEYBOARD_HINT}</p>
              </section>
            )}
          </div>

          {/* SESSION: export format, the take card (task 3 — Export/Replay/
             Save/Discard for whatever `lastSession` just finished), then a
             visually separate "load a saved take" section for re-opening an
             OLD session from a file. Record/Arm lives ONLY in the pinned
             footer now (task: two instances of the same button fighting
             each other). */}
          <div className="panel-tab-content" role="tabpanel" hidden={activeTab !== 'session'}>
            <section>
              <h2>Session</h2>
              <label className="scene-select">
                Export format
                <select
                  value={exportFormat}
                  disabled={replay !== null || exporting !== null}
                  onChange={(ev) => setExportFormat(ev.target.value as ExportFormatChoice)}
                >
                  <option value="auto">Auto</option>
                  <option value="mp4">MP4 (H.264)</option>
                  <option value="webm">WebM (VP9)</option>
                </select>
              </label>

              {lastSession && (
                <div className="take-card">
                  <p className="take-card-duration">
                    Last take: {formatTime(lastSession.durationFrames / lastSession.fps)}
                  </p>
                  <div className="session-controls">
                    <button
                      type="button"
                      className="session-button session-button-primary"
                      disabled={replay !== null || exporting !== null}
                      onClick={() => {
                        // Clears the badge/footer-echo on the FIRST export
                        // attempt (task: "clear the badge after the first
                        // export or discard") — reuses exportVideo verbatim,
                        // this is re-presentation, not new plumbing.
                        setTakeReady(false)
                        void exportVideo(lastSession)
                      }}
                    >
                      Export video
                    </button>
                    <button
                      type="button"
                      className="session-button"
                      disabled={replay !== null || exporting !== null}
                      onClick={() => replaySession(lastSession)}
                    >
                      Replay
                    </button>
                    <button
                      type="button"
                      className="session-button"
                      disabled={replay !== null || exporting !== null}
                      onClick={() => downloadSession(lastSession)}
                    >
                      Save JSON
                    </button>
                    <button
                      type="button"
                      className="session-button"
                      disabled={replay !== null || exporting !== null}
                      onClick={() => {
                        setLastSession(null)
                        setTakeReady(false)
                      }}
                    >
                      Discard
                    </button>
                  </div>
                </div>
              )}

              <div className="session-subsection">
                <h3 className="session-section-heading">Load a saved take</h3>
                <div className="session-controls">
                  <label className="file session-file">
                    <input
                      type="file"
                      accept="application/json,.json"
                      disabled={replay !== null || exporting !== null}
                      onChange={(ev) => {
                        const file = ev.target.files?.[0]
                        ev.target.value = ''
                        onLoadSession(file)
                      }}
                    />
                    Replay from file…
                  </label>
                  <label className="file session-file">
                    <input
                      type="file"
                      accept="application/json,.json"
                      disabled={replay !== null || exporting !== null}
                      onChange={(ev) => {
                        const file = ev.target.files?.[0]
                        ev.target.value = ''
                        onExportVideo(file)
                      }}
                    />
                    Export from file…
                  </label>
                </div>
              </div>

              {replay && (
                <p className="session-status">
                  replaying… frame {replay.frame}/{replay.total}
                </p>
              )}
              {exporting && (
                <p className="session-status">
                  exporting… {Math.round((exporting.frame / Math.max(1, exporting.total)) * 100)}%
                </p>
              )}
              {!exporting && exportNote && <p className="session-status">{exportNote}</p>}
              {sessionError && <span className="expr-message">{sessionError}</span>}
            </section>
          </div>

          {/* INPUTS: audio file + diagnostic, image file, MIDI disclosure,
             signal meters, trigger pads + XY pad. */}
          <div className="panel-tab-content" role="tabpanel" hidden={activeTab !== 'inputs'}>
            <label className="file">
              <input
                type="file"
                accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.flac"
                onChange={(ev) => onFile(ev.target.files?.[0])}
              />
              {trackName ?? 'Load audio file (demo signals until then)'}
            </label>
            <label className="file">
              <input
                type="file"
                accept="image/*"
                // Enabled only when the current scene has an image-driven concept
                // (Photo Swarm task's `sceneAcceptsImage()` duck-type check), and
                // disabled while recording: a mid-recording image swap isn't
                // captured as a timestamped event (it's snapshot-only, taken at
                // startRecording()), so replaying the recording could never
                // reproduce it anyway — disabling avoids a swap that silently
                // doesn't show up on replay.
                disabled={!engine || !engine.sceneAcceptsImage() || recording}
                onChange={(ev) => {
                  const file = ev.target.files?.[0]
                  ev.target.value = ''
                  onImageFile(file)
                }}
              />
              {imageName ?? 'Load image (photo-swarm-style scenes only)'}
            </label>
            {audioBlocked && (
              <button
                type="button"
                className="session-button audio-unblock"
                onClick={() => {
                  void engineRef.current?.audio.resumeContext()
                }}
              >
                🔊 Tap to enable sound
              </button>
            )}
            {trackName && engine && (
              <p className="session-status">
                sound: {engine.audio.contextState ?? 'not started'}
                {engine.audio.contextState === 'running' && ' — if silent, check Control Center for a Bluetooth/AirPlay output'}
              </p>
            )}

            {engine && (
              // MIDI settings collapsed behind a compact disclosure (task: keep
              // the panel free of a permanently-visible device list/Learn button
              // most sessions never touch). Closed by default; learn mode keeps
              // working while collapsed, since the armed highlight lives on the
              // param controls themselves (Knob/RotaryKnob's `armed` prop), not
              // inside this section.
              <section className="midi-section">
                <button
                  type="button"
                  className={`tab-button${midiOpen ? ' tab-button-active' : ''}`}
                  onClick={() => setMidiOpen((open) => !open)}
                  aria-expanded={midiOpen}
                  aria-controls="midi-disclosure"
                >
                  MIDI
                  {(learnMode || midiDevices.length > 0) && <span className="tab-badge" aria-hidden="true" />}
                </button>
                {midiOpen && (
                  <div id="midi-disclosure" className="midi-disclosure">
                    <p className="session-status">{formatMidiStatus(midiSupported, midiDevices.length)}</p>
                    {midiDevices.length > 0 && (
                      <ul className="midi-devices">
                        {midiDevices.map((d) => (
                          <li key={d.id}>
                            <label>
                              <input
                                type="checkbox"
                                checked={d.active}
                                onChange={(ev) => midiHandleRef.current?.setDeviceActive(d.id, ev.target.checked)}
                              />
                              {d.name}
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                    {midiSupported && (
                      <button
                        type="button"
                        className={`session-button${learnMode ? ' midi-learning' : ''}`}
                        onClick={() => {
                          setLearnMode((on) => {
                            const next = !on
                            if (!next) setArmedParam(null)
                            else setMacroLearn(null)
                            return next
                          })
                        }}
                      >
                        {learnMode ? 'Stop learning' : 'Learn'}
                      </button>
                    )}
                    {learnMode && (
                      <p className="session-status">
                        {armedParam
                          ? `learning "${armedParam}" — move a hardware control (Esc to stop)`
                          : 'learn mode on — move a param slider to arm it (Esc to stop)'}
                      </p>
                    )}
                    {/* Controls 1-8 (docs/MACROS.md §5): eight generic macro
                       slots — map hardware ONCE here, and it drives whatever
                       scene's params are live afterward, surviving every
                       switch. Gated on midiSupported like the rest of the
                       panel; there's no hardware to map without it. */}
                    {midiSupported && (
                      <div className="macro-controls">
                        <div className="macro-controls-header">
                          <h3>Controls 1-8</h3>
                          <button
                            type="button"
                            className={`session-button${macroLearn?.mode === 'sequential' ? ' midi-learning' : ''}`}
                            onClick={() => {
                              if (macroLearn?.mode === 'sequential') {
                                setMacroLearn(null)
                              } else {
                                cancelParamLearn()
                                setMacroLearn({ mode: 'sequential', slot: 1 })
                              }
                            }}
                          >
                            {macroLearn?.mode === 'sequential' ? 'Stop mapping' : 'Map controls…'}
                          </button>
                        </div>
                        {macroLearn?.mode === 'sequential' && (
                          <p className="session-status">
                            turn control {macroLearn.slot} next — each new knob claims the next slot (Esc to stop)
                          </p>
                        )}
                        <ul className="macro-slots">
                          {MACRO_SLOTS.map((slot) => {
                            const cc = macroCcBySlot[slot - 1]
                            const armedHere = macroLearn !== null && macroLearn.slot === slot
                            return (
                              <li key={slot} className={`macro-slot${armedHere ? ' macro-slot-armed' : ''}`}>
                                <span className="macro-slot-num">{slot}</span>
                                <span className="macro-slot-cc">{cc != null ? `CC ${cc}` : '—'}</span>
                                <div className="bar">
                                  <div style={{ width: `${Math.min(1, levels[`ctl.${slot}`] ?? 0) * 100}%` }} />
                                </div>
                                <button
                                  type="button"
                                  className="macro-slot-learn"
                                  onClick={() => {
                                    cancelParamLearn()
                                    setMacroLearn({ mode: 'single', slot })
                                  }}
                                >
                                  Learn
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}

            <section>
              <h2>Signals</h2>
              {SIGNAL_NAMES.map((name) => (
                <div className="meter" key={name}>
                  <span>{name}</span>
                  <div className="bar">
                    <div style={{ width: `${Math.min(1, levels[name] ?? 0) * 100}%` }} />
                  </div>
                </div>
              ))}
            </section>

            {engine && (
              <section>
                <h2>Perform</h2>
                <div className="perform">
                  <TriggerPads engine={engine} />
                  <XyPad engine={engine} />
                </div>
              </section>
            )}
          </div>

          {/* CODE: the shader editor. */}
          <div className="panel-tab-content" role="tabpanel" hidden={activeTab !== 'code'}>
            {engine && <ShaderPanel engine={engine} key={`shader-${sceneId}-${sceneVersion}`} />}
          </div>
        </div>

        {/* Pinned footer — outside the tabs, always visible regardless of
           which tab is active: the transport row (when a file is loaded),
           the mode line, and the Arm/End-take button are performance-critical
           and must never be scrolled away or hidden by tab choice. */}
        <div className="panel-footer">
          <PerformanceModeLine
            mode={performanceModeOf(recording, armed)}
            hasFile={playback.hasFile}
            takeSeconds={takeElapsedSec}
          />
          {engine && playback.hasFile && (
            <TransportRow
              engine={engine}
              playback={playback}
              recording={recording}
              armed={armed}
              setArmed={setArmed}
              beginTake={beginTake}
              endTake={endTake}
            />
          )}
          <RecordButton
            recording={recording}
            armed={armed}
            disabled={!engine || replay !== null || exporting !== null}
            onToggleRecording={onToggleRecording}
          />
          {/* Task 3: a compact echo of the take card once a fresh take just
             ended — cleared the moment the SESSION tab's Export/Discard
             actions clear `takeReady`. */}
          {!recording && !armed && lastSession && takeReady && (
            <p className="session-status">
              take {formatTime(lastSession.durationFrames / lastSession.fps)} ready — export in SESSION tab
            </p>
          )}
        </div>
      </aside>
      )}
    </div>
  )
}

/** The scene picker <select> — shared between the studio panel and the
 * perform strip (extracted so the two never drift, per the task's "do not
 * duplicate logic" instruction). */
function SceneSelect({
  sceneId,
  onChange,
  disabled,
}: {
  sceneId: string
  onChange: (id: string) => void
  disabled: boolean
}) {
  return (
    <label className="scene-select">
      Scene
      <select value={sceneId} disabled={disabled} onChange={(ev) => onChange(ev.target.value)}>
        {Object.entries(SCENES).map(([id, entry]) => (
          <option key={id} value={id}>
            {entry.name}
          </option>
        ))}
      </select>
    </label>
  )
}

/**
 * Scene handoff controls (docs/HANDOFF.md §6): a target-scene selector +
 * "Switch (hand off)" button, reused between the studio panel's Scene section
 * and the perform strip (one component so the two never drift). Deliberately
 * a separate dropdown from `SceneSelect` above — that one is the existing
 * cold full-teardown scene change; this picks B for `engine.switchScene`,
 * which hands off IN PLACE (A's final frame seeds B's initial state).
 */
function SwitchControl({
  targetId,
  onTargetChange,
  onSwitch,
  disabled,
}: {
  targetId: string
  onTargetChange: (id: string) => void
  onSwitch: () => void
  disabled: boolean
}) {
  return (
    <div className="switch-control">
      <label className="scene-select">
        Hand off to
        <select value={targetId} disabled={disabled} onChange={(ev) => onTargetChange(ev.target.value)}>
          {Object.entries(SCENES).map(([id, entry]) => (
            <option key={id} value={id}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="session-button" onClick={onSwitch} disabled={disabled}>
        Switch (hand off)
      </button>
    </div>
  )
}

/** The Record/Arm button — shared between the studio panel's Session section
 * and the perform strip. Label logic matches onToggleRecording's state machine
 * (App): Stop while recording, Arm/Armed while a file is loaded but paused,
 * Record otherwise. */
/** One button, one concept everywhere (task): "Arm" while not recording
 * (pulsing red once actually armed-and-waiting), "End take" while performing
 * — never "Record", which used to name a THIRD, separate instant-start
 * action. onToggleRecording (App) already collapses that old path into the
 * same Arm button (pressing it while playing/in demo mode arms-and-starts
 * immediately), so the label only needs two states. */
function RecordButton({
  recording,
  armed,
  disabled,
  onToggleRecording,
}: {
  recording: boolean
  armed: boolean
  disabled: boolean
  onToggleRecording: () => void
}) {
  return (
    <button
      type="button"
      className={`session-button${armed && !recording ? ' record-armed' : ''}`}
      onClick={onToggleRecording}
      disabled={disabled}
    >
      {recording ? 'End take' : armed ? 'Armed ●' : 'Arm'}
    </button>
  )
}

/** The play/pause/stop/scrub/time transport row — shared between the studio
 * panel and the perform strip. Only rendered by callers once `playback.hasFile`
 * is true, same guard as the original inline block this was extracted from.
 * PERFORMING has exactly one way to end (task): ⏹ now calls `onEndTake`
 * (App's `endTake` — stopRecording THEN stopAudio, in that order, so the
 * engine's own isRecording no-op gate passes) instead of no-oping like the
 * plain `engine.stopAudio()` it used to call unconditionally. Pause/scrub
 * stay disabled while recording — the take's length must track wall-clock
 * performance time exactly, so no mid-take pause/seek is possible.
 */
function TransportRow({
  engine,
  playback,
  recording,
  armed,
  setArmed,
  beginTake,
  endTake,
}: {
  engine: Engine
  playback: { time: number; duration: number; playing: boolean; hasFile: boolean }
  recording: boolean
  armed: boolean
  setArmed: React.Dispatch<React.SetStateAction<boolean>>
  beginTake: () => void
  endTake: () => void
}) {
  return (
    <div className="transport-row">
      <button
        type="button"
        className="session-button"
        disabled={recording}
        // Keyed on `playing` (an audible source exists), not `paused`:
        // stopped and naturally-ended tracks must also show ▶, and
        // resumeAudio restarts those from the rewound offset.
        onClick={() => {
          if (playback.playing) {
            engine.pauseAudio()
            return
          }
          engine.resumeAudio()
          // Armed recording fires here, synchronously after resume — the
          // source now exists (resume creates it in the same call), so
          // beginTake's startRecording call passes its not-playing guard and
          // audio + the recording start on the same transport frame.
          if (armed && engine.audio.contextState !== 'running') {
            // iOS: the context can still be waking (ctx.resume is async);
            // a recording begun now would open on a frozen clock and then
            // time-jump — stay armed, audio starts when the context does,
            // and the next ▶ press fires the take. No-op on desktop,
            // where the context is already running.
            return
          }
          if (armed) {
            setArmed(false)
            beginTake()
          }
        }}
        aria-label={playback.playing ? 'Pause' : 'Play'}
      >
        {playback.playing ? '⏸' : '▶'}
      </button>
      <button
        type="button"
        className="session-button"
        // Enabled while recording (task fix): this is now one of the two
        // affordances (with RecordButton's "End take") for the take's ONE
        // way to end. Previously `disabled={recording}` made this a no-op —
        // the root cause of takes running long, since the only way to stop
        // was hunting down the Record button's own Stop.
        onClick={() => {
          if (recording) endTake()
          else engine.stopAudio()
        }}
        aria-label={recording ? 'Stop (ends the take)' : 'Stop and rewind'}
      >
        ⏹
      </button>
      <input
        type="range"
        className="transport-scrub"
        min={0}
        max={Math.max(playback.duration, 0.1)}
        step={0.1}
        value={Math.min(playback.time, playback.duration)}
        disabled={recording}
        onChange={(ev) => engine.seekAudio(Number(ev.target.value))}
      />
      <span className="transport-time">
        {formatTime(playback.time)} / {formatTime(playback.duration)}
      </span>
    </div>
  )
}

/** Task 1: the always-visible, one-line state indicator for the
 * rehearsal/armed/performing model — shared between the panel-footer (own
 * line, block layout) and the perform strip (`compact`: inline flex item,
 * no wrap). Rehearsal's line only makes sense once there's something whose
 * tweaks AREN'T being recorded — hidden in demo mode. */
function PerformanceModeLine({
  mode,
  hasFile,
  takeSeconds,
  compact = false,
}: {
  mode: PerformanceMode
  hasFile: boolean
  takeSeconds: number
  compact?: boolean
}) {
  const className = `perf-mode-line${compact ? ' perf-mode-line-compact' : ''}`
  if (mode === 'rehearsal') {
    if (!hasFile) return null
    return <p className={className}>rehearsal — tweaks are not recorded</p>
  }
  if (mode === 'armed') {
    return <p className={className}>armed — ▶ starts the take</p>
  }
  return <p className={`${className} perf-mode-line-performing`}>● TAKE {formatTime(takeSeconds)}</p>
}

/**
 * The "code" authoring layer (REQUIREMENTS.md §3.1 layer 3 / ARCHITECTURE.md
 * §3.3): a stage dropdown + textarea editing a scene's raw GLSL, hot-recompiled
 * on Apply. Hidden entirely when the scene has no shader stages. Switching
 * scenes (a new `engine`) or stages reloads the textarea from the engine.
 */
function ShaderPanel({ engine }: { engine: Engine }) {
  const stages = engine.getShaderSources()
  const [stageKey, setStageKey] = useState(stages[0]?.key ?? '')
  const [source, setSource] = useState(stages[0]?.source ?? '')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fresh = engine.getShaderSources()
    const key = fresh[0]?.key ?? ''
    setStageKey(key)
    setSource(fresh.find((s) => s.key === key)?.source ?? '')
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the scene/engine changes, not on every keystroke
  }, [engine])

  if (stages.length === 0) return null

  const onStageChange = (key: string) => {
    setStageKey(key)
    setSource(engine.getShaderSources().find((s) => s.key === key)?.source ?? '')
    setError(null)
  }

  const onApply = () => {
    try {
      engine.setShaderSource(stageKey, source)
      setError(null)
    } catch (e) {
      // Bad GLSL: the scene's last good program keeps rendering.
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section>
      <h2>Code</h2>
      <label className="scene-select">
        Stage
        <select value={stageKey} onChange={(ev) => onStageChange(ev.target.value)}>
          {stages.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <textarea
        className="shader-editor"
        rows={14}
        spellCheck={false}
        value={source}
        onChange={(ev) => setSource(ev.target.value)}
      />
      <button type="button" className="session-button" onClick={onApply}>
        Apply
      </button>
      {error && <span className="expr-message">{error}</span>}
    </section>
  )
}

function TriggerPads({ engine }: { engine: Engine }) {
  return (
    <div className="trigger-grid">
      {[0, 1, 2, 3].map((index) => (
        <button
          key={index}
          type="button"
          className="trigger-pad"
          onPointerDown={() => engine.queueInput({ type: 'trigger', index })}
        >
          T{index + 1}
        </button>
      ))}
    </div>
  )
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

function XyPad({ engine }: { engine: Engine }) {
  const padRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0.5, y: 0.5 })
  const [active, setActive] = useState(false)

  const updateFromPointer = (ev: React.PointerEvent<HTMLDivElement>) => {
    const rect = padRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = clamp01((ev.clientX - rect.left) / rect.width)
    const y = 1 - clamp01((ev.clientY - rect.top) / rect.height) // up = 1
    setPos({ x, y })
    engine.setInputSignal('pad.x', x)
    engine.setInputSignal('pad.y', y)
  }

  const onDown = (ev: React.PointerEvent<HTMLDivElement>) => {
    ev.currentTarget.setPointerCapture(ev.pointerId)
    setActive(true)
    engine.setInputSignal('pad.active', 1)
    updateFromPointer(ev)
  }

  const onMove = (ev: React.PointerEvent<HTMLDivElement>) => {
    if (!active) return
    updateFromPointer(ev)
  }

  const onUp = () => {
    setActive(false)
    engine.setInputSignal('pad.active', 0)
  }

  return (
    <div
      ref={padRef}
      className="xy-pad"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <div className="xy-pad-dot" style={{ left: `${pos.x * 100}%`, top: `${(1 - pos.y) * 100}%` }} />
    </div>
  )
}

function Knob({
  engine,
  schema,
  slot,
  liveValue,
  learnArm,
  armed = false,
}: {
  engine: Engine
  schema: { name: string; label: string; min: number; max: number; default: number; step?: number }
  /** This param's 1-based position in `engine.scene.params` — docs/MACROS.md
   * §1/§4's positional slot number, used ONLY for the "ctl N" source hint
   * when this param is macro-driven (see `macroDriven` below). */
  slot: number
  /** This param's most recently polled live value (App's 100ms poll,
   * `engine.scene.getParam` under the hood) — rendered on the slider instead
   * of local interactive state whenever `bound` is true, so a MIDI-learned or
   * expression-driven param visibly tracks the hardware/expression rather
   * than freezing the slider wherever it happened to be when the binding
   * landed. */
  liveValue: number
  /** Present (and callable) only while the panel's global Learn mode is on;
   * calling it arms this param as the next MIDI-learn bind target. Slider
   * drags call it on every change while learn mode is on — the "tweak a
   * param to arm it" flow (see App's MIDI section). */
  learnArm?: () => void
  /** True when this is the currently-armed learn target — highlights the row. */
  armed?: boolean
}) {
  const [value, setValue] = useState(engine.scene.getParam(schema.name))
  const { bound, macroDriven, exprText, setExprText, applyExpr, error } = useParamBinding(engine, schema.name)
  const driven = bound || macroDriven
  const displayValue = driven ? liveValue : value
  // docs/MACROS.md §5: macro-driven rows get the same accent visual language
  // as bound rows (the `em` readout, accent-colored via app.css's
  // `.knob-macro`), but the slider stays enabled — unlike `bound`, editing a
  // macro-driven param is allowed (§1's precedence note); it's just
  // overwritten again on the next engaged-slot frame.
  const macroClass = macroDriven && !bound ? ' knob-macro' : ''

  return (
    <label className={`knob${armed ? ' knob-armed' : ''}${macroClass}`}>
      <span>
        {schema.label} <em>{bound ? 'ƒ(t)' : macroDriven ? `ctl ${slot}` : displayValue.toFixed(2)}</em>
      </span>
      <input
        type="range"
        min={schema.min}
        max={schema.max}
        step={schema.step ?? 0.01}
        value={displayValue}
        disabled={bound}
        onChange={(ev) => {
          const v = Number(ev.target.value)
          setValue(v)
          engine.setParam(schema.name, v)
          // The "tweak a param to arm it" half of the learn flow: any slider
          // move while learn mode is on (re-)arms this param as the bind
          // target, moving the armed highlight here even if another knob was
          // armed a moment ago.
          learnArm?.()
        }}
      />
      <input
        type="text"
        className={`expr${error ? ' expr-error' : ''}`}
        placeholder="expression, e.g. 2 + bass * 4"
        value={exprText}
        spellCheck={false}
        onChange={(ev) => {
          setExprText(ev.target.value)
          applyExpr(ev.target.value)
        }}
      />
      {error && <span className="expr-message">{error}</span>}
    </label>
  )
}
