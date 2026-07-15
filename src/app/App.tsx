import { useEffect, useRef, useState } from 'react'
import { Engine } from '../engine/engine'
import { LissajousScene } from '../scenes/builtin/lissajous'
import { attachKeyboard } from '../mapping/keyboard'
import { serializeSession, parseSession } from '../session/serialize'
import type { SessionDoc } from '../session/types'
import './app.css'

const SIGNAL_NAMES = ['rms', 'bass', 'mid', 'high', 'beat', 'onset']
const KEYBOARD_HINT = '1-6 freqX · q/w/e freqY · space pulse drift · f/g flash/fade trail'

/** Creates and starts the normal live-mode engine on a canvas (factored out so
 * it can be re-invoked after a session replay finishes). */
function createLiveEngine(canvas: HTMLCanvasElement): Engine {
  const e = new Engine(canvas, new LissajousScene(), {
    mode: 'live',
    seed: 42,
    width: 960,
    height: 540,
  })
  e.start()
  return e
}

/** Triggers a browser download of a session doc as a JSON file. */
function downloadSession(doc: SessionDoc): void {
  const blob = new Blob([serializeSession(doc)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'visualz-session.json'
  a.click()
  URL.revokeObjectURL(url)
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<Engine | null>(null)
  const detachKeyboardRef = useRef<(() => void) | null>(null)
  const meterIntervalRef = useRef<number | null>(null)
  const [engine, setEngine] = useState<Engine | null>(null)
  const [levels, setLevels] = useState<Record<string, number>>({})
  const [trackName, setTrackName] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [replay, setReplay] = useState<{ frame: number; total: number } | null>(null)
  const [sessionError, setSessionError] = useState<string | null>(null)

  /** Wires up live-only side effects (signal meter polling, keyboard) for an engine. */
  const attachLiveEngine = (e: Engine) => {
    engineRef.current = e
    setEngine(e)
    meterIntervalRef.current = window.setInterval(() => setLevels(e.bus.snapshot()), 100)
    detachKeyboardRef.current = attachKeyboard(window, (event) => e.queueInput(event))
  }

  const detachLiveEngine = () => {
    if (meterIntervalRef.current !== null) {
      clearInterval(meterIntervalRef.current)
      meterIntervalRef.current = null
    }
    detachKeyboardRef.current?.()
    detachKeyboardRef.current = null
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || engineRef.current) return
    attachLiveEngine(createLiveEngine(canvas))
    return () => {
      detachLiveEngine()
      engineRef.current?.dispose()
      engineRef.current = null
    }
  }, [])

  const onFile = async (file: File | undefined) => {
    if (!file || !engineRef.current) return
    await engineRef.current.audio.playFile(file)
    setTrackName(file.name)
  }

  const onToggleRecording = () => {
    const e = engineRef.current
    if (!e) return
    if (e.isRecording) {
      const doc = e.stopRecording()
      setRecording(false)
      if (doc) downloadSession(doc)
    } else {
      e.startRecording()
      setRecording(true)
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

    const canvas = canvasRef.current
    if (!canvas) return

    // Stop and dispose the live engine before handing the canvas to a
    // render-mode replay engine.
    detachLiveEngine()
    engineRef.current?.dispose()
    engineRef.current = null
    setEngine(null)
    setRecording(false)

    const replayEngine = new Engine(canvas, new LissajousScene(), {
      mode: 'render',
      seed: doc.seed,
      width: 960,
      height: 540,
      fps: 60,
    })
    replayEngine.loadSession(doc)
    engineRef.current = replayEngine
    setReplay({ frame: 0, total: doc.durationFrames })

    const step = () => {
      if (engineRef.current !== replayEngine) return // superseded (e.g. unmount)
      replayEngine.renderFrames(1)
      const frame = replayEngine.transport.frame
      setReplay({ frame, total: doc.durationFrames })
      if (replayEngine.replayDone && frame >= doc.durationFrames) {
        replayEngine.dispose()
        engineRef.current = null
        setReplay(null)
        const liveCanvas = canvasRef.current
        if (liveCanvas) attachLiveEngine(createLiveEngine(liveCanvas))
        return
      }
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
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
            accept="audio/*"
            onChange={(ev) => onFile(ev.target.files?.[0])}
          />
          {trackName ?? 'Load audio file (demo signals until then)'}
        </label>

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
          <div className="session-controls">
            <button
              type="button"
              className="session-button"
              onClick={onToggleRecording}
              disabled={!engine || replay !== null}
            >
              {recording ? 'Stop' : 'Record'}
            </button>
            <label className="file session-file">
              <input
                type="file"
                accept="application/json"
                disabled={replay !== null}
                onChange={(ev) => {
                  const file = ev.target.files?.[0]
                  ev.target.value = ''
                  onLoadSession(file)
                }}
              />
              Load & replay
            </label>
          </div>
          {replay && (
            <p className="session-status">
              replaying… frame {replay.frame}/{replay.total}
            </p>
          )}
          {sessionError && <span className="expr-message">{sessionError}</span>}
        </section>

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
            <h2>{engine.scene.meta.name}</h2>
            {engine.scene.params.map((p) => (
              <Knob key={p.name} engine={engine} schema={p} />
            ))}
          </section>
        )}
      </aside>
    </div>
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
}: {
  engine: Engine
  schema: { name: string; label: string; min: number; max: number; default: number; step?: number }
}) {
  const [value, setValue] = useState(engine.scene.getParam(schema.name))
  const [exprText, setExprText] = useState('')
  const [bound, setBound] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const applyExpr = (text: string) => {
    const src = text.trim()
    if (src === '') {
      engine.clearBinding(schema.name)
      setBound(false)
      setError(null)
      return
    }
    try {
      engine.setBinding(schema.name, src)
      setBound(true)
      setError(null)
    } catch (e) {
      // Bad expression: previous binding (or the slider value) stays active.
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <label className="knob">
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
