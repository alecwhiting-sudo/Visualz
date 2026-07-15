import { useEffect, useRef, useState } from 'react'
import { Engine } from '../engine/engine'
import { LissajousScene } from '../scenes/builtin/lissajous'
import './app.css'

const SIGNAL_NAMES = ['rms', 'bass', 'mid', 'high']

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<Engine | null>(null)
  const [engine, setEngine] = useState<Engine | null>(null)
  const [levels, setLevels] = useState<Record<string, number>>({})
  const [trackName, setTrackName] = useState<string | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || engineRef.current) return
    const e = new Engine(canvas, new LissajousScene(), {
      mode: 'live',
      seed: 42,
      width: 960,
      height: 540,
    })
    engineRef.current = e
    e.start()
    setEngine(e)

    const meter = setInterval(() => setLevels(e.bus.snapshot()), 100)
    return () => {
      clearInterval(meter)
      e.stop()
    }
  }, [])

  const onFile = async (file: File | undefined) => {
    if (!file || !engineRef.current) return
    await engineRef.current.audio.playFile(file)
    setTrackName(file.name)
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

function Knob({
  engine,
  schema,
}: {
  engine: Engine
  schema: { name: string; label: string; min: number; max: number; default: number; step?: number }
}) {
  const [value, setValue] = useState(engine.scene.getParam(schema.name))
  return (
    <label className="knob">
      <span>
        {schema.label} <em>{value.toFixed(2)}</em>
      </span>
      <input
        type="range"
        min={schema.min}
        max={schema.max}
        step={schema.step ?? 0.01}
        value={value}
        onChange={(ev) => {
          const v = Number(ev.target.value)
          setValue(v)
          engine.setParam(schema.name, v)
        }}
      />
    </label>
  )
}
