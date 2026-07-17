import { useEffect, useRef, useState } from 'react'
import { Engine } from '../engine/engine'
import { SCENES } from '../scenes/registry'
import { attachKeyboard } from '../mapping/keyboard'
import { attachMidi, type MidiDevice, type MidiHandle, type MidiSink } from '../mapping/midi'
import { MACRO_SLOT_COUNT } from '../engine/macroRouter'
import { serializeSession, parseSession } from '../session/serialize'
import type { SessionDoc } from '../session/types'
import { exportSession } from '../export/client'
import { sliceExportAudioFromSeconds, type ExportProgress } from '../export/render'
import type { ExportCodec } from '../export/encode'
import { InfoPopover } from './InfoPopover'
import { useParamBinding } from './paramBinding'
import { framesToRenderForAudioSync } from './replayPacing'
import { snapToStep } from '../scenes/paramStep'
import { SHADER_DOCS } from '../scenes/shaderDocs'
import { easedValue } from './frameGlide'
import { TransitionSpeedKnob } from './TransitionSpeedKnob'
import {
  blankMacroCcBySlot,
  DEVICE_ACTIVE_STORAGE_KEY,
  MACRO_CC_STORAGE_KEY,
  parseDeviceActiveMap,
  parseMacroCcBySlot,
} from './midiPersistence'
import './app.css'

// Pads/PERFORM batch: shared guidance copy for the "?" popovers beside the
// trigger-pad grid and the XY pad.
const PADS_HELP_TEXT =
  "Momentary hits: T1-T4 each pulse one of the current scene's first four parameters — a kick of ~30% of its range decaying over half a second. Scenes with fewer than four parameters leave spare pads inert. MIDI notes and mapped keys fire them too. Hits are recorded into takes."
const XY_HELP_TEXT =
  'XY performance pad — writes the pad.x / pad.y signals; bind them to any parameter with an expression like pad.x * 2.'
// Frame buttons F1-F8 (task #35): guidance copy for the "?" popover beside them.
const FRAMES_HELP_TEXT =
  "Frames store the 8 controller positions. Press = jump, Shift+press = glide at the transition speed. Frames are positional, so they apply to whatever scene is live — through handoffs too."

const SIGNAL_NAMES = ['rms', 'bass', 'mid', 'high', 'beat', 'onset']
const KEYBOARD_HINT = '1-6 freqX · q/w/e freqY · space pulse drift · f/g flash/fade trail'

/**
 * A narrow Playwright-only hook onto the REAL App's engine (docs/MACROS.md
 * §6): `window.__viz` (src/testing/hooks.ts) only exists under the `?test=1`
 * harness, which bypasses React entirely (see main.tsx) — there is no studio
 * panel DOM there at all. But the macro e2e spec needs to assert a REAL
 * studio Knob visibly tracks a macro-driven param, and headless Chromium's
 * WebMIDI always rejects (see midi.spec.ts's docstring),
 * so real hardware can't be simulated either. `__vizLive.setInputSignal` is
 * the seam: it's exactly what a mapped MIDI CC would have written, called
 * directly, against the real live-mode Engine backing the real UI. Kept
 * separate from `VizTestApi`'s type (not a union on `window.__viz`) since
 * most of that interface — `renderFrames`, `exportSession`, … — assumes
 * render-mode and doesn't apply to a live rAF-driven engine.
 */
export interface VizLiveTestApi {
  setInputSignal(name: string, value: number): void
  /** Write a param value directly (bypassing any UI control) — Frame F1-F8
   * e2e coverage (tests/e2e/frames.spec.ts) uses this to move a param away
   * from its stored position before asserting a frame press/glide restores
   * it, without depending on a specific slider's drag mechanics. */
  setParam(name: string, value: number): void
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
  /** The most recently ended take's full `SessionDoc` (untyped at this
   * boundary, mirroring `VizTestApi.loadSession`'s `unknown`), or `null` if no
   * take has ended yet. Lets an e2e test drive a REAL live take (rehearsal ->
   * armed -> performing against the actual rAF-paced Engine, not the `?test=1`
   * render-mode harness) and then hand the resulting doc to `window.__viz` on
   * a second page for exact `durationFrames`/replay-determinism assertions
   * (tests/e2e/takeBaselining.spec.ts) — the take-baselining regression only
   * reproduces against a live-mode transport, whose `frame` counter never
   * resets between rehearsal and the take, unlike every existing render-mode
   * fixture which always records from a fresh engine at frame 0. */
  lastSessionDoc(): unknown | null
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

// --- MIDI setup persistence (localStorage) -----------------------------------
// User report: mapped all 8 controls, then a page reload wiped them — the
// mapping table was session-scoped App state with no localStorage backing.
// REQUIREMENTS.md §6 already calls for mappings persisting locally; parsing
// lives in midiPersistence.ts (pure, unit-tested), these are just the
// try/catch'd localStorage reads/writes (quota, private-browsing Safari, or
// simply no `localStorage` at all must never crash the app).
function loadMacroCcBySlot(): (number | null)[] {
  try {
    return parseMacroCcBySlot(localStorage.getItem(MACRO_CC_STORAGE_KEY))
  } catch {
    return parseMacroCcBySlot(null)
  }
}
function saveMacroCcBySlot(v: (number | null)[]): void {
  try {
    localStorage.setItem(MACRO_CC_STORAGE_KEY, JSON.stringify(v))
  } catch {
    // Ignore — a failed save just means the mapping won't survive a reload.
  }
}
function loadDeviceActiveMap(): Record<string, boolean> {
  try {
    return parseDeviceActiveMap(localStorage.getItem(DEVICE_ACTIVE_STORAGE_KEY))
  } catch {
    return {}
  }
}
function saveDeviceActiveMap(v: Record<string, boolean>): void {
  try {
    localStorage.setItem(DEVICE_ACTIVE_STORAGE_KEY, JSON.stringify(v))
  } catch {
    // Ignore, same reasoning as saveMacroCcBySlot.
  }
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
// studio: the original layout (this file, untouched below) — the PERFORM tab
// already holds the full control surface (scene picker, hand-off, param
// knobs, pads/XY, frames), so there is no longer an intermediate slim-strip
// mode. full: true Fullscreen-API fullscreen on the stage container, zero
// chrome — Esc (browser-handled) or V exits, straight back to studio.
type ViewMode = 'studio' | 'full'

/** Studio panel's SampleArk-style tab row (task: regroup the panel into
 * tabs so the column stops growing to whatever-is-expanded height). The
 * 'scene' tab (internal id kept as-is to minimize churn) is labeled PERFORM
 * — it holds the scene picker, param knobs, hand-off control, pads/XY, and
 * frames, so "Perform" now unambiguously names this tab rather than also
 * meaning the view mode (the panel-header button is "Full screen" instead).
 * Visual tab ORDER follows the workflow (task: "load inputs -> perform ->
 * manage takes -> deep-edit code"): INPUTS | PERFORM | SESSION | CODE — but
 * PERFORM stays the DEFAULT active tab (`activeTab` state below) regardless
 * of its position, since it's the home surface casual use never leaves. */
type StudioTab = 'scene' | 'session' | 'inputs' | 'code'
const STUDIO_TABS: Array<[StudioTab, string]> = [
  ['inputs', 'INPUTS'],
  ['scene', 'PERFORM'],
  ['session', 'SESSION'],
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
  // task).
  const [midiSupported, setMidiSupported] = useState(false)
  const [midiDevices, setMidiDevices] = useState<MidiDevice[]>([])
  // Collapsed by default (task: MIDI settings behind a button) — the tab
  // button itself is the only chrome shown until opened.
  const [midiOpen, setMidiOpen] = useState(false)

  // --- Macro controls (docs/MACROS.md) -------------------------------------
  // task #34 (unify MIDI learn onto the 8 macro slots): hardware mapping is
  // now exclusively a Controls 1-8 activity — the old per-param "tweak a
  // slider, then move a hardware control" learn flow (which wrote a
  // range-mapped expression BINDING straight onto a param, dying on every
  // scene handoff) is fully retired. Mapping hardware happens only via
  // "Map controls…" (sequential, below) or a per-row relearn (single) on the
  // Controls 1-8 list; Knob rows keep only their ALWAYS-visible slot number
  // (1-8) so the positional model stays legible, and typed expressions in the
  // knob fields remain the untouched, outranking "advanced" layer.
  //
  // `macroCcBySlot[i]` is the learned CC number for slot i+1 (`ctl.${i+1}`),
  // or `null` if unmapped. This is the "MIDI CC -> ctl.N" hardware mapping —
  // App-level state, not Engine state: it's scene-independent and must
  // survive every switch (§1/§3), and it outlives even a cold scene-dropdown
  // swap (attachLiveEngine/detachLiveEngine never touch it) since remapping
  // hardware after every scene change would defeat the whole point of
  // macros. It ALSO now survives a page reload (user report: "mapped all 8
  // controls, then knobs went dead" — a reload was wiping this table) —
  // seeded from localStorage at mount and re-saved on every change (the sync
  // effect below is the natural hook: it already runs on every update).
  // Kept in a ref too, so the MIDI activity callback (set up once per engine
  // attach) always reads the latest mapping rather than whatever it was when
  // attached.
  const [macroCcBySlot, setMacroCcBySlot] = useState<(number | null)[]>(() => loadMacroCcBySlot())
  const macroCcBySlotRef = useRef(macroCcBySlot)
  useEffect(() => {
    macroCcBySlotRef.current = macroCcBySlot
    saveMacroCcBySlot(macroCcBySlot)
  }, [macroCcBySlot])
  // Per-device active flags (task: same persistence story as the CC table) —
  // a map of Web MIDI port id -> active, seeded from localStorage at mount.
  // `restoredDeviceIdsRef` tracks which device ids have already had their
  // stored flag (re)applied THIS attach cycle, so the one-time restore in the
  // `attachMidi` onChange callback below can't loop (setDeviceActive fires
  // `onChange` again) and can't fight a manual toggle afterward. Reset on
  // every `attachLiveEngine` (a scene switch tears down and rebuilds the MIDI
  // handle, so its freshly-resynced device list needs restoring again).
  const deviceActiveMapRef = useRef<Record<string, boolean>>(loadDeviceActiveMap())
  const restoredDeviceIdsRef = useRef<Set<string>>(new Set())
  /** Wraps a manual device-active toggle (the INPUTS tab's checkbox) so the
   * new flag is both applied live AND persisted — and marked "already
   * restored" so a later resync on this same handle never overwrites the
   * user's own just-made choice. */
  const onToggleDeviceActive = (id: string, active: boolean) => {
    midiHandleRef.current?.setDeviceActive(id, active)
    deviceActiveMapRef.current = { ...deviceActiveMapRef.current, [id]: active }
    restoredDeviceIdsRef.current.add(id)
    saveDeviceActiveMap(deviceActiveMapRef.current)
  }
  // Non-null while "Map controls…" (sequential) or a per-row relearn (single)
  // is in progress; `slot` is the next (or the only, for `single`) slot a
  // matching CC will claim. Kept in a ref too for the same reason as
  // `macroCcBySlotRef` above: the activity callback must see live updates.
  const [macroLearn, setMacroLearn] = useState<{ mode: 'sequential' | 'single'; slot: number } | null>(null)
  const macroLearnRef = useRef(macroLearn)
  useEffect(() => {
    macroLearnRef.current = macroLearn
  }, [macroLearn])
  // Esc ends an in-progress macro-learn early (spec: "Esc/click ends early").
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
  // Mirrors macroLearnRef above: the hotkey listener is attached once and must
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
  // Task 3 (audio-synced replay): a one-line hint shown under the replay
  // progress line — "load the track to hear this in sync" (no track loaded
  // for a file-kind doc) or "audio: X (take was recorded with Y)" (a
  // different track is loaded than the one the take was recorded against,
  // synced anyway). `null` when nothing needs saying (already synced to the
  // right track, or a demo-kind doc with nothing to sync at all).
  const [replayAudioHint, setReplayAudioHint] = useState<string | null>(null)
  // Task 1 (stop replay): set to the in-progress replay's own `restoreLive`
  // closure the moment it starts, cleared (to null) the moment it fires —
  // the SESSION tab's "Stop replay" button and the Esc-while-replaying
  // listener below both just call this, so there is exactly one path back to
  // a live engine regardless of who triggered it (natural end, a mid-replay
  // error, the button, or Esc).
  const replayCancelRef = useRef<(() => void) | null>(null)
  // Task 1: Esc cancels an in-progress replay, same convention as the
  // learn-mode/macro-learn Escape listeners above — scoped to only attach
  // while a replay is actually running.
  useEffect(() => {
    if (!replay) return
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') replayCancelRef.current?.()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [replay])
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
  // Mirrors macroLearnRef/switchTargetIdRef above: window.__vizLive.lastTakeDuration
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

  // --- Frame buttons F1-F8 (task #35) --------------------------------------
  // Eight positional snapshot slots, session-scoped App state (no
  // persistence; survives scene switches for free, since nothing here reads
  // sceneId/engine identity) — each slot holds the current scene's first-8
  // param values NORMALIZED ((value-min)/(max-min)) at store time, so
  // pressing it later re-applies those same POSITIONS to whatever scene is
  // live, exactly like Controls 1-8's macro slots (docs/MACROS.md), just
  // captured as a one-shot snapshot instead of driven live by hardware.
  const [frames, setFrames] = useState<(number[] | null)[]>(() => new Array(MACRO_SLOT_COUNT).fill(null))
  // Store mode: click Store, then a frame button captures into that slot;
  // store mode exits after exactly one capture (single-shot, not a toggle
  // you have to remember to turn back off).
  const [storeArmed, setStoreArmed] = useState(false)
  // Shift+press glide duration, seconds (0.1-10s) — App-local performance-rig
  // state, deliberately NOT a scene param: it can't be macro/MIDI-mapped or
  // recorded into a session, since it governs HOW a frame press plays out,
  // not what the take itself reproduces (the param VALUES it lands on are
  // what gets recorded, via the ordinary `engine.setParam` calls below).
  const [transitionSpeed, setTransitionSpeed] = useState(1)
  // The in-flight glide animator's own identity token + rAF handle — any new
  // frame press (jump OR glide) cancels whatever glide was already running
  // (see applyFrame below); comparing against `glideRef.current` inside the
  // step closure is what lets a stale, superseded glide notice it's been
  // cancelled and stop calling itself.
  const glideRef = useRef<{
    targets: { name: string; from: number; to: number }[]
    startedAt: number
    durationMs: number
  } | null>(null)
  const glideRafRef = useRef<number | null>(null)

  const cancelGlide = () => {
    if (glideRafRef.current !== null) {
      cancelAnimationFrame(glideRafRef.current)
      glideRafRef.current = null
    }
    glideRef.current = null
  }

  const startGlide = (targets: { name: string; from: number; to: number }[]) => {
    if (targets.length === 0) return
    const state = {
      targets,
      startedAt: performance.now(),
      durationMs: Math.max(0.1, Math.min(10, transitionSpeed)) * 1000,
    }
    glideRef.current = state
    const step = () => {
      const e = engineRef.current
      if (!e || glideRef.current !== state) return // superseded/cancelled
      const progress = (performance.now() - state.startedAt) / state.durationMs
      for (const t of state.targets) e.setParam(t.name, easedValue(t.from, t.to, progress))
      if (progress >= 1) {
        glideRef.current = null
        glideRafRef.current = null
        return
      }
      glideRafRef.current = requestAnimationFrame(step)
    }
    glideRafRef.current = requestAnimationFrame(step)
  }

  /** Captures the CURRENT scene's first-8 param values, normalized to [0,1]
   * over each param's own range, into frame slot `index`. Re-storing
   * overwrites; store mode always exits after exactly one capture. */
  const storeFrame = (index: number) => {
    const e = engineRef.current
    if (!e) return
    const snapshot = e.scene.params.slice(0, MACRO_SLOT_COUNT).map((p) => {
      const range = p.max - p.min
      const v = e.scene.getParam(p.name)
      return range === 0 ? 0 : Math.min(1, Math.max(0, (v - p.min) / range))
    })
    setFrames((prev) => {
      const next = [...prev]
      next[index] = snapshot
      return next
    })
    setStoreArmed(false)
  }

  /** Applies a stored frame POSITIONALLY onto whatever scene is currently
   * live (docs/MACROS.md-style positional carry-over, but a one-shot capture
   * instead of a live-driven signal): slot i's normalized value maps onto the
   * current scene's i-th param, range-mapped and step-snapped identically to
   * a manual knob commit. Params with an explicit expression binding are
   * skipped (bindings outrank, same precedence Controls 1-8 uses). `glide`
   * interpolates each affected param from its CURRENT value to the target
   * over `transitionSpeed` seconds (ease-in-out) via `engine.setParam` calls
   * every tick, so it records like an ordinary CC sweep; a plain press jumps
   * instantly via one `setParam` call each. Either way, any already-running
   * glide is cancelled first. */
  const applyFrame = (index: number, glide: boolean) => {
    const e = engineRef.current
    const snapshot = frames[index]
    if (!e || !snapshot) return
    cancelGlide()
    const params = e.scene.params
    const glideTargets: { name: string; from: number; to: number }[] = []
    for (let i = 0; i < snapshot.length && i < params.length; i++) {
      const p = params[i]
      if (e.getBinding(p.name) !== undefined) continue
      const target = snapToStep(p.min + snapshot[i] * (p.max - p.min), p.min, p.max, p.step)
      if (glide) {
        glideTargets.push({ name: p.name, from: e.scene.getParam(p.name), to: target })
      } else {
        e.setParam(p.name, target)
      }
    }
    if (glide) startGlide(glideTargets)
  }

  /** A frame button's own click: store-mode intercepts it (captures instead
   * of applying); otherwise applies the frame, gliding if Shift was held. */
  const onFrameClick = (index: number, shiftKey: boolean) => {
    if (storeArmed) {
      storeFrame(index)
      return
    }
    applyFrame(index, shiftKey)
  }

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

  /** studio <-> full. A no-op where the Fullscreen API is unavailable (e.g.
   * iPhone Safari) — there is no other mode left to toggle into. */
  const cycleViewMode = () => {
    if (!fullscreenSupported) return
    setViewMode((v) => (v === 'studio' ? 'full' : 'studio'))
  }

  // Mirrors switchTargetIdRef/macroLearnRef below: requestFullscreenOn's
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
            // feature-detection false positive) — fall back to studio rather
            // than leaving viewMode stuck on an unrealized 'full'.
            setViewMode('studio')
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
        setViewMode((v) => (v === 'full' ? 'studio' : v))
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
      setParam: (name, value) => e.setParam(name, value),
      getParam: (name) => e.scene.getParam(name),
      sceneParams: () =>
        e.scene.params.map((p) => ({ name: p.name, min: p.min, max: p.max, default: p.default })),
      lastTakeDuration: () => {
        const doc = lastSessionRef.current
        return doc ? doc.durationFrames / doc.fps : null
      },
      lastSessionDoc: () => lastSessionRef.current,
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
      // Footer "● TAKE 0:23" counter: frame arithmetic against
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
    restoredDeviceIdsRef.current = new Set()
    midiHandleRef.current = attachMidi(
      midiSink,
      (state) => {
        setMidiSupported(state.supported)
        // Restore persisted per-device active flags exactly once per device
        // per attach cycle (task): applying a stored flag calls
        // `setDeviceActive`, which fires this same callback again with the
        // corrected list — `restoredDeviceIdsRef` is what stops that from
        // looping or re-fighting a manual toggle made in the meantime.
        for (const d of state.devices) {
          const stored = deviceActiveMapRef.current[d.id]
          if (stored !== undefined && stored !== d.active && !restoredDeviceIdsRef.current.has(d.id)) {
            restoredDeviceIdsRef.current.add(d.id)
            midiHandleRef.current?.setDeviceActive(d.id, stored)
          }
        }
        setMidiDevices(state.devices)
      },
      (signalName) => {
        // Controls 1-8 mapping (docs/MACROS.md §5, task #34): hardware
        // mapping is now exclusively this flow — a sequential "Map
        // controls…" pass or a per-row relearn (`macroLearn` non-null) is the
        // ONLY way a CC ever gets written into `macroCcBySlot`. Nothing to do
        // if neither is in progress (the old per-param "tweak a slider, then
        // move a hardware control" learn flow is fully retired). Notes don't
        // claim macro slots (the spec frames this as "turn hardware knobs" —
        // CCs only) but are still swallowed while a mapping pass is active.
        const macro = macroLearnRef.current
        if (!macro) return
        const m = /^midi\.cc\.(\d+)$/.exec(signalName)
        if (!m) return
        const cc = Number(m[1])
        // DISTINCT-CC guard (review finding): a single encoder sweep emits
        // dozens of CC messages, and native MIDI events flush React state
        // between them — without a synchronous check one knob turn could
        // claim several sequential slots (all with the same CC). The spec
        // says "each DISTINCT CC claims the next slot": a CC already mapped
        // to any slot is a no-op (doesn't advance), and the armed slot is
        // advanced on the REF synchronously.
        const already = macroCcBySlotRef.current.indexOf(cc)
        if (macro.mode === 'sequential' && already >= 0) return
        const claimed = [...macroCcBySlotRef.current]
        // Single-mode re-learn MOVES a CC (clears its old slot) rather than
        // refusing it — re-arranging hardware must stay possible.
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
      cancelGlide()
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
    // A zero-frame take has nothing to replay or export (exporting one used
    // to crash the muxer with a null-colorSpace TypeError — no video chunks
    // ever reached it). Surface what happened instead of stashing a dud.
    if (doc.durationFrames <= 0) {
      setSessionError('Take was empty (0 frames) — nothing to export')
      return
    }
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

    // Task 3 (audio-synced replay): capture the live AudioEngine (if a track
    // is loaded) BEFORE detaching/disposing the live engine, and dispose with
    // `keepAudio` so the track (and its position) survives the swap to a
    // render-mode replay engine regardless of whether this particular replay
    // ends up syncing to it. Sync only applies to file-kind docs — a
    // demo-kind doc's signals aren't tied to any track's timeline, so
    // "syncing" to whatever happens to be loaded would just be a coincidence.
    const liveAudio = engineRef.current?.audio
    const audioLoaded = liveAudio?.hasFile ?? false
    const docAudioName = doc.audio.kind === 'file' ? doc.audio.name : null
    const startSeconds = doc.audio.kind === 'file' ? (doc.audio.startSeconds ?? 0) : 0
    const syncAudio = docAudioName !== null && audioLoaded
    const liveFileName = liveAudio?.fileName ?? null
    const mismatchedAudioName =
      syncAudio && liveFileName !== null && liveFileName !== docAudioName ? liveFileName : null

    // Stop and dispose the live engine before handing the canvas to a
    // render-mode replay engine.
    detachLiveEngine()
    engineRef.current?.dispose({ keepAudio: audioLoaded })
    engineRef.current = null
    setEngine(null)
    setRecording(false)

    // Not syncing this replay to a loaded track (wrong doc kind) — pause it
    // rather than let it keep playing on, unsynced, underneath the replay.
    // Its position survives regardless (the dispose above didn't stop it).
    if (audioLoaded && !syncAudio) liveAudio?.pause()

    setReplayAudioHint(
      syncAudio
        ? mismatchedAudioName
          ? `audio: ${mismatchedAudioName} (take was recorded with ${docAudioName})`
          : null
        : docAudioName !== null
          ? 'load the track (INPUTS tab) to hear the replay in sync'
          : null,
    )

    // Any failure from here on (an uncompilable binding in a hand-edited session
    // throws DslError from loadSession or mid-replay from a binding event) must
    // land back in a working live engine, never a dead canvas.
    // The scene selected before this replay attempt — restoreLive() falls back
    // to it if the session's scene id turns out to be invalid.
    const previousSceneId = sceneId

    // Task 1 (stop replay): the ONE path back to a live engine, whichever of
    // its callers fires it — natural end, a mid-replay error, the SESSION
    // tab's "Stop replay" button, or Esc (both wired through
    // `replayCancelRef`). Clears the ref synchronously so a stray second
    // trigger (e.g. Esc held down) can't run it twice.
    const restoreLive = () => {
      replayCancelRef.current = null
      // Task 3: end the synced track's playback the instant the replay
      // itself ends (natural end, error, or cancel) — mirrors how ending a
      // live take stops audio at that same instant, rather than leaving it
      // playing on past a replay that no longer exists.
      if (syncAudio) liveAudio?.stop()
      engineRef.current?.dispose()
      engineRef.current = null
      setReplay(null)
      setReplayAudioHint(null)
      const liveCanvas = canvasRef.current
      // Read directly rather than from the `sceneId` state closure: restoreLive
      // can fire synchronously (bad scene id) before a queued setSceneId below
      // has re-rendered this closure with the new value.
      const restoreSceneId = SCENES[doc.scene.id] ? doc.scene.id : previousSceneId
      if (!liveCanvas) return
      // Re-adopt the SAME AudioEngine instance (task 3) so the loaded track
      // survives the whole replay round trip — createLiveEngine/Engine.start
      // already resets the transport to an adopted engine's audio position,
      // the same path a scene switch's audio handoff uses.
      const newEngine = createLiveEngine(liveCanvas, restoreSceneId, liveAudio)
      if (imageRef.current && newEngine.sceneAcceptsImage()) {
        newEngine.setSceneImage(imageRef.current)
      }
      attachLiveEngine(newEngine)
    }
    replayCancelRef.current = restoreLive

    let replayEngine: Engine
    try {
      const entry = SCENES[doc.scene.id]
      if (!entry) throw new Error(`unknown scene ${doc.scene.id}`)
      replayEngine = new Engine(canvas, entry.create(), {
        mode: 'render',
        seed: doc.seed,
        width: 960,
        height: 540,
        fps: doc.fps,
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

    if (syncAudio && liveAudio) {
      liveAudio.seek(startSeconds)
      liveAudio.resume()
    }

    const step = () => {
      if (engineRef.current !== replayEngine) return // superseded (cancelled, unmount, ...)
      try {
        if (syncAudio && liveAudio) {
          // Task 3: pace off the real audio clock instead of one frame per
          // rAF tick — render however many frames are due to catch the
          // render-mode engine up to where the track actually is. Self-
          // correcting after a slow/dropped rAF tick (never drifts); a tick
          // where nothing is due yet renders nothing. Determinism is
          // untouched: this only decides WHEN renderFrames runs and with
          // what `n`, never what a frame contains.
          const elapsed = liveAudio.time - startSeconds
          const framesToRender = framesToRenderForAudioSync(
            replayEngine.replayFrame,
            elapsed,
            doc.fps,
            doc.durationFrames,
          )
          if (framesToRender > 0) replayEngine.renderFrames(framesToRender)
        } else {
          // No track to sync to: paced by wall-clock rAF, same as before
          // this task (silent, one frame per displayed tick).
          replayEngine.renderFrames(1)
        }
      } catch (err) {
        setSessionError(err instanceof Error ? err.message : String(err))
        restoreLive()
        return
      }
      // Relative to the take's own start (not raw `transport.frame`, which
      // `loadSession` now seeds from `doc.audio.startSeconds` rather than 0) —
      // matches `doc.durationFrames`, which is likewise take-relative.
      const frame = replayEngine.replayFrame
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
      const rawAudio = engineRef.current?.audio.lastBuffer() ?? undefined
      // Take-baselining (session/types.ts): a take armed mid-track recorded
      // `doc.audio.startSeconds` seconds into this same buffer — slice the raw
      // PCM forward by that much so the muxed track lines up with what the
      // exported frames (which replay from take-relative time 0) actually show.
      const audio =
        rawAudio && doc.audio.kind === 'file' && doc.audio.startSeconds
          ? sliceExportAudioFromSeconds(rawAudio, doc.audio.startSeconds)
          : rawAudio
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
      {viewMode === 'studio' && (
      <aside className="panel">
        <div className="panel-header">
          <h1>Visualz</h1>
          {/* Full-screen entry point (the removed 'perform' strip mode's only
             surviving affordance): jumps straight into true Fullscreen-API
             fullscreen on the stage. Hidden where the API is unavailable
             (iPhone Safari) — there's nowhere for it to go. */}
          {fullscreenSupported && (
            <button type="button" className="session-button" onClick={() => setViewMode('full')}>
              Full screen
            </button>
          )}
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
          {/* PERFORM (tab id stays 'scene'): scene select, hand-off control,
             param knobs, keyboard hint, and (Pads/PERFORM batch) the
             trigger-pad grid + XY pad below the param list. */}
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
                </div>
                {/* task #34: hardware mapping happens only via the INPUTS
                   tab's Controls 1-8 ("Map controls…"/per-row Learn) — every
                   row still ALWAYS shows its 1-8 slot number (below) so the
                   positional model stays visible without a separate learn
                   flow living here too. */}
                {engine.scene.params.map((p, i) => (
                  <Knob key={p.name} engine={engine} schema={p} slot={i + 1} liveValue={paramValues[p.name] ?? p.default} />
                ))}
                <p className="keyboard-hint">{KEYBOARD_HINT}</p>
                {/* Pads/PERFORM batch (item 3): moved here from INPUTS —
                   full-size trigger pads + XY pad, below the param list. */}
                <div className="perform">
                  <TriggerPads engine={engine} />
                  <XyPad engine={engine} />
                </div>
                {/* Frame buttons F1-F8 (task #35): eight positional snapshot
                   slots below the pads — see FramesBlock's own doc comment. */}
                <FramesBlock
                  frames={frames}
                  storeArmed={storeArmed}
                  onToggleStore={() => setStoreArmed((a) => !a)}
                  onFrameClick={onFrameClick}
                  onFrameStore={storeFrame}
                  transitionSpeed={transitionSpeed}
                  onTransitionSpeedChange={setTransitionSpeed}
                />
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
                <div className="replay-status">
                  <p className="session-status">
                    replaying… frame {replay.frame}/{replay.total}
                  </p>
                  <button
                    type="button"
                    className="session-button"
                    onClick={() => replayCancelRef.current?.()}
                  >
                    Stop replay
                  </button>
                </div>
              )}
              {replay && replayAudioHint && <p className="session-status">{replayAudioHint}</p>}
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
             signal meters. (Pads/PERFORM batch: the trigger pads + XY pad
             moved to the PERFORM tab, below the param list — see below.) */}
          <div className="panel-tab-content" role="tabpanel" hidden={activeTab !== 'inputs'}>
            <label className="file">
              <input
                type="file"
                accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.flac,.aiff,.aif"
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
              // the panel free of a permanently-visible device list most
              // sessions never touch). Closed by default. task #34: hardware
              // mapping now lives ONLY here, via Controls 1-8's "Map
              // controls…" (sequential) and each row's own "Learn" (single) —
              // the old separate per-param "Learn" toggle is retired.
              <section className="midi-section">
                <button
                  type="button"
                  className={`tab-button${midiOpen ? ' tab-button-active' : ''}`}
                  onClick={() => setMidiOpen((open) => !open)}
                  aria-expanded={midiOpen}
                  aria-controls="midi-disclosure"
                >
                  MIDI
                  {(macroLearn !== null || midiDevices.length > 0) && <span className="tab-badge" aria-hidden="true" />}
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
                                onChange={(ev) => onToggleDeviceActive(d.id, ev.target.checked)}
                              />
                              {d.name}
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                    {/* Controls 1-8 (docs/MACROS.md §5, task #34): eight
                       generic macro slots — map hardware ONCE here, and it
                       drives whatever scene's params are live afterward,
                       surviving every switch. Gated on midiSupported like the
                       rest of the panel; there's no hardware to map without
                       it. This is now the ONLY hardware-mapping flow in the
                       app. */}
                    {midiSupported && (
                      <div className="macro-controls">
                        <div className="macro-controls-header">
                          <h3>Controls 1-8</h3>
                          <div className="macro-controls-header-buttons">
                            <button
                              type="button"
                              className={`session-button${macroLearn?.mode === 'sequential' ? ' midi-learning' : ''}`}
                              onClick={() => {
                                if (macroLearn?.mode === 'sequential') {
                                  setMacroLearn(null)
                                } else {
                                  setMacroLearn({ mode: 'sequential', slot: 1 })
                                }
                              }}
                            >
                              {macroLearn?.mode === 'sequential' ? 'Stop mapping' : 'Map controls…'}
                            </button>
                            {/* Persistence task: clears the whole CC->slot
                               table (and, via the sync effect, its
                               localStorage backing) in one action. */}
                            <button
                              type="button"
                              className="session-button"
                              onClick={() => setMacroCcBySlot(blankMacroCcBySlot())}
                            >
                              Clear mapping
                            </button>
                          </div>
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
                                  onClick={() => setMacroLearn({ mode: 'single', slot })}
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
 * rehearsal/armed/performing model, pinned in the panel footer. Rehearsal's
 * line only makes sense once there's something whose tweaks AREN'T being
 * recorded — hidden in demo mode. */
function PerformanceModeLine({
  mode,
  hasFile,
  takeSeconds,
}: {
  mode: PerformanceMode
  hasFile: boolean
  takeSeconds: number
}) {
  if (mode === 'rehearsal') {
    if (!hasFile) return null
    return <p className="perf-mode-line">rehearsal — tweaks are not recorded</p>
  }
  if (mode === 'armed') {
    return <p className="perf-mode-line">armed — ▶ starts the take</p>
  }
  return <p className="perf-mode-line perf-mode-line-performing">● TAKE {formatTime(takeSeconds)}</p>
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
  // CODE tab task: the "What does this code do?" disclosure's own open/closed
  // state — collapsed by default (same convention as the MIDI disclosure),
  // and reset whenever the scene remounts (this whole component is keyed on
  // `shader-${sceneId}-${sceneVersion}` by its caller, so a fresh mount here
  // already means "new scene" without any extra effect needed).
  const [docsOpen, setDocsOpen] = useState(false)

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

  // CODE tab task: keyed by the live scene's registry id (not the stage's own
  // `label`, which is a display string) so composite `blend-*` scenes — which
  // have no SHADER_DOCS entry at all — correctly show no disclosure, same as
  // any stage this file simply hasn't documented.
  const stageDoc = SHADER_DOCS[engine.scene.meta.id]?.[stageKey]

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
      {stageDoc && (
        <div className="shader-docs">
          <button
            type="button"
            className={`tab-button${docsOpen ? ' tab-button-active' : ''}`}
            aria-expanded={docsOpen}
            aria-controls="shader-docs-disclosure"
            onClick={() => setDocsOpen((open) => !open)}
          >
            What does this code do?
          </button>
          {docsOpen && (
            <div id="shader-docs-disclosure" className="shader-docs-content">
              <p>{stageDoc.summary}</p>
              {stageDoc.tryThis.length > 0 && (
                <>
                  <p className="shader-docs-heading">Things to try</p>
                  <ul className="shader-docs-try-list">
                    {stageDoc.tryThis.map((t, i) => (
                      <li key={i}>
                        <code>{t.target}</code> — {t.effect}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <p className="shader-docs-safety">
                You can&apos;t break anything: a bad edit keeps the last working version running and shows the error here.
              </p>
            </div>
          )}
        </div>
      )}
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

/**
 * The trigger-pad grid (T1-T4), rendered in the PERFORM tab below the param
 * list. Rendered with its own "?" guidance popover beside it.
 */
function TriggerPads({ engine }: { engine: Engine }) {
  return (
    <div className="pads-block">
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
      <InfoPopover label="Trigger pads info" text={PADS_HELP_TEXT} />
    </div>
  )
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

/** The XY performance pad, rendered in the PERFORM tab below the param list.
 * Rendered with its own "?" guidance popover. */
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
    <div className="xy-pad-block">
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
      <InfoPopover label="XY pad info" text={XY_HELP_TEXT} />
    </div>
  )
}

/**
 * Frame buttons F1-F8 (task #35): eight positional snapshot slots below the
 * PERFORM tab's pads, a Store toggle, and the transition-speed dial — all the
 * actual state/logic (frames array, store-armed, glide animator) lives in
 * App itself (session-scoped, must survive scene switches for free); this is
 * purely the render + click wiring. Right-click on a frame is a desktop
 * shortcut that stores directly, bypassing the Store toggle entirely.
 */
function FramesBlock({
  frames,
  storeArmed,
  onToggleStore,
  onFrameClick,
  onFrameStore,
  transitionSpeed,
  onTransitionSpeedChange,
}: {
  frames: (number[] | null)[]
  storeArmed: boolean
  onToggleStore: () => void
  onFrameClick: (index: number, shiftKey: boolean) => void
  onFrameStore: (index: number) => void
  transitionSpeed: number
  onTransitionSpeedChange: (seconds: number) => void
}) {
  return (
    <div className="frames-block">
      <div className="frames-header">
        <h3>Frames</h3>
        <InfoPopover label="Frames info" text={FRAMES_HELP_TEXT} />
      </div>
      <div className="frames-row">
        {frames.map((frame, i) => (
          <button
            key={i}
            type="button"
            className={`frame-button${frame ? ' frame-button-occupied' : ''}`}
            onClick={(ev) => onFrameClick(i, ev.shiftKey)}
            onContextMenu={(ev) => {
              ev.preventDefault()
              onFrameStore(i)
            }}
          >
            F{i + 1}
          </button>
        ))}
        <button
          type="button"
          className={`session-button${storeArmed ? ' store-armed' : ''}`}
          onClick={onToggleStore}
        >
          Store
        </button>
        <TransitionSpeedKnob seconds={transitionSpeed} onChange={onTransitionSpeedChange} />
      </div>
    </div>
  )
}

function Knob({
  engine,
  schema,
  slot,
  liveValue,
}: {
  engine: Engine
  schema: { name: string; label: string; min: number; max: number; default: number; step?: number }
  /** This param's 1-based position in `engine.scene.params` — docs/MACROS.md
   * §1/§4's positional slot number. Task #34: ALWAYS shown (dim mono, next to
   * the label) for a param within the first 8 positions, so the positional
   * Controls 1-8 model stays visible even when nothing is currently mapped —
   * hidden entirely for a param at position 9+, which no macro slot can ever
   * reach. Also still used for the "ctl N" source hint when this param is
   * macro-driven (see `macroDriven` below). */
  slot: number
  /** This param's most recently polled live value (App's 100ms poll,
   * `engine.scene.getParam` under the hood) — rendered on the slider instead
   * of local interactive state whenever `bound` is true, so a MIDI-learned or
   * expression-driven param visibly tracks the hardware/expression rather
   * than freezing the slider wherever it happened to be when the binding
   * landed. */
  liveValue: number
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
    <label className={`knob${macroClass}`}>
      <span>
        <span className="knob-label">
          {slot <= MACRO_SLOT_COUNT && <span className="knob-slot-num">{slot}</span>}
          {schema.label}
        </span>
        <em>{bound ? 'ƒ(t)' : macroDriven ? `ctl ${slot}` : displayValue.toFixed(2)}</em>
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
