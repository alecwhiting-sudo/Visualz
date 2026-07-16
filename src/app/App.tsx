import { useEffect, useRef, useState } from 'react'
import { Engine } from '../engine/engine'
import { SCENES } from '../scenes/registry'
import { attachKeyboard } from '../mapping/keyboard'
import { attachMidi, type MidiDevice, type MidiHandle } from '../mapping/midi'
import { serializeSession, parseSession } from '../session/serialize'
import type { SessionDoc } from '../session/types'
import { exportSession } from '../export/client'
import type { ExportProgress } from '../export/render'
import type { ExportCodec } from '../export/encode'
import './app.css'

const SIGNAL_NAMES = ['rms', 'bass', 'mid', 'high', 'beat', 'onset']
const KEYBOARD_HINT = '1-6 freqX · q/w/e freqY · space pulse drift · f/g flash/fade trail'

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

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
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
  const [sceneId, setSceneId] = useState(DEFAULT_SCENE_ID)
  const [levels, setLevels] = useState<Record<string, number>>({})
  const [trackName, setTrackName] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  // Hot-armed recording: with a track loaded but not playing, Record becomes
  // Arm, and the next ▶ press starts audio AND the session recording in the
  // same tick — a synced start, so takes armed from a full stop align exactly
  // with the beginning of the track.
  const [armed, setArmed] = useState(false)
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

  /** Wires up live-only side effects (signal meter polling, keyboard) for an engine. */
  const attachLiveEngine = (e: Engine) => {
    engineRef.current = e
    setEngine(e)
    meterIntervalRef.current = window.setInterval(() => {
      setLevels(e.bus.snapshot())
      setAudioBlocked(e.audio.isPlaying && e.audio.contextState !== 'running')
      setPlayback({
        time: e.audio.time,
        duration: e.audio.duration,
        playing: e.audio.isPlaying,
        hasFile: e.audio.hasFile,
      })
    }, 100)
    detachKeyboardRef.current = attachKeyboard(window, (event) => e.queueInput(event))
    midiHandleRef.current = attachMidi(
      e,
      (state) => {
        setMidiSupported(state.supported)
        setMidiDevices(state.devices)
      },
      (signalName) => {
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
          e.setBinding(target, signalName)
        } catch {
          // `midi.cc.<n>`/`midi.note.<n>` always compile; guard anyway rather
          // than crash on a future change to signal-name validity.
        }
        setArmedParam(null)
      },
    )
  }

  const detachLiveEngine = () => {
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
      const doc = engineRef.current.stopRecording()
      if (doc) setLastSession(doc)
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

  const onToggleRecording = () => {
    const e = engineRef.current
    if (!e) return
    if (e.isRecording) {
      const doc = e.stopRecording()
      setRecording(false)
      if (doc) setLastSession(doc)
    } else if (e.audio.hasFile && !e.audio.isPlaying) {
      // Recording can't start against a frozen transport (engine throws), so
      // with a stopped/paused track the button ARMS instead: the next ▶ press
      // starts audio and the recording together on the same frame.
      setArmed((a) => !a)
    } else {
      try {
        e.startRecording()
        setRecording(true)
      } catch (err) {
        // Should be unreachable given the arm branch above; keeps UI state
        // honest if engine.startRecording ever rejects for a new reason.
        setSessionError(err instanceof Error ? err.message : String(err))
      }
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
    <div className="app">
      <div className="stage">
        <canvas ref={canvasRef} />
      </div>
      <aside className="panel">
        <h1>Visualz</h1>
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

        {engine && playback.hasFile && (
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
                // startRecording's not-playing guard passes and audio + the
                // recording start on the same transport frame.
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
                  try {
                    engine.startRecording()
                    setRecording(true)
                  } catch (err) {
                    setSessionError(err instanceof Error ? err.message : String(err))
                  }
                }
              }}
              aria-label={playback.playing ? 'Pause' : 'Play'}
            >
              {playback.playing ? '⏸' : '▶'}
            </button>
            <button
              type="button"
              className="session-button"
              disabled={recording}
              onClick={() => engine.stopAudio()}
              aria-label="Stop and rewind"
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
          <div className="session-controls">
            <button
              type="button"
              className={`session-button${armed && !recording ? ' record-armed' : ''}`}
              onClick={onToggleRecording}
              disabled={!engine || replay !== null || exporting !== null}
            >
              {recording
                ? 'Stop'
                : playback.hasFile && !playback.playing
                  ? armed
                    ? 'Armed ●'
                    : 'Arm'
                  : 'Record'}
            </button>
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
          {lastSession && (
            <div className="session-controls">
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
                onClick={() => exportVideo(lastSession)}
              >
                Export video
              </button>
              <button
                type="button"
                className="session-button"
                disabled={replay !== null || exporting !== null}
                onClick={() => downloadSession(lastSession)}
              >
                Save
              </button>
            </div>
          )}
          {armed && !recording && (
            <p className="session-status">armed — press ▶ to start the track and the recording together</p>
          )}
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

        {engine && (
          <section>
            <h2>MIDI</h2>
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
          </section>
        )}

        {engine && (
          <section>
            <h2>Perform</h2>
            <div className="perform">
              <TriggerPads engine={engine} />
              <XyPad engine={engine} />
            </div>
            <p className="keyboard-hint">{KEYBOARD_HINT}</p>
          </section>
        )}

        {engine && (
          <section>
            <label className="scene-select">
              Scene
              <select
                value={sceneId}
                disabled={replay !== null || exporting !== null}
                onChange={(ev) => onSceneChange(ev.target.value)}
              >
                {Object.entries(SCENES).map(([id, entry]) => (
                  <option key={id} value={id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
            <h2>{engine.scene.meta.name}</h2>
            {engine.scene.params.map((p) => (
              <Knob
                key={p.name}
                engine={engine}
                schema={p}
                learnArm={learnMode ? () => setArmedParam(p.name) : undefined}
                armed={armedParam === p.name}
              />
            ))}
          </section>
        )}

        {engine && <ShaderPanel engine={engine} />}
      </aside>
    </div>
  )
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
  learnArm,
  armed = false,
}: {
  engine: Engine
  schema: { name: string; label: string; min: number; max: number; default: number; step?: number }
  /** Present (and callable) only while the panel's global Learn mode is on;
   * calling it arms this param as the next MIDI-learn bind target. Slider
   * drags call it on every change while learn mode is on — the "tweak a
   * param to arm it" flow (see App's MIDI section). */
  learnArm?: () => void
  /** True when this is the currently-armed learn target — highlights the row. */
  armed?: boolean
}) {
  const [value, setValue] = useState(engine.scene.getParam(schema.name))
  const [exprText, setExprText] = useState(engine.getBinding(schema.name) ?? '')
  const [bound, setBound] = useState(engine.getBinding(schema.name) !== undefined)
  const [error, setError] = useState<string | null>(null)
  // Tracks the last binding this component itself observed, so the effect
  // below can tell "the engine's binding changed under us" (a MIDI-learn
  // bind, or a fresh engine from a scene switch/session load) apart from our
  // own applyExpr calls, which already keep exprText/bound in sync.
  const lastSeenBindingRef = useRef(engine.getBinding(schema.name))

  useEffect(() => {
    const current = engine.getBinding(schema.name)
    if (current !== lastSeenBindingRef.current) {
      lastSeenBindingRef.current = current
      setExprText(current ?? '')
      setBound(current !== undefined)
      setError(null)
    }
  })

  const applyExpr = (text: string) => {
    const src = text.trim()
    if (src === '') {
      engine.clearBinding(schema.name)
      lastSeenBindingRef.current = undefined
      setBound(false)
      setError(null)
      return
    }
    try {
      engine.setBinding(schema.name, src)
      lastSeenBindingRef.current = src
      setBound(true)
      setError(null)
    } catch (e) {
      // Bad expression: previous binding (or the slider value) stays active.
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <label className={`knob${armed ? ' knob-armed' : ''}`}>
      <span>
        {schema.label} <em>{bound ? 'ƒ(t)' : value.toFixed(2)}</em>
      </span>
      <input
        type="range"
        min={schema.min}
        max={schema.max}
        step={schema.step ?? 0.01}
        value={value}
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
