import { useRef, useState } from 'react'
import type { Engine } from '../engine/engine'
import type { ParamSchema } from '../scenes/types'
import { useParamBinding } from './paramBinding'
import { describeArc, dragDeltaToValue, polarToCartesian, valueToAngle, wheelDeltaToValue } from './rotaryMath'

const RADIUS = 42
const NEEDLE_INNER = 12
const NEEDLE_OUTER = 34
const TRACK_START = -135
const TRACK_END = 135

/**
 * SampleArk-style rotary control: a compact SVG dial (track + value arc +
 * needle) with a mono-caps label above and the numeric value below. Emits
 * through the same `engine.setParam`/learn-arm path the studio sliders use
 * (App.tsx's `Knob`) so values record into sessions and MIDI-learn arming
 * works identically regardless of which control the performer touches.
 *
 * Interaction: vertical drag (pointer-captured — full range over ~150px,
 * Shift for 10x finer precision), mouse wheel, double-click to reset to
 * `schema.default`. All three are no-ops while the param is bound (an
 * expression or MIDI-learned CC/note) — same as the studio slider's
 * `disabled` — and the dial instead renders `liveValue`, the engine's
 * currently-polled value, so a bound knob visibly tracks the hardware/expression.
 */
export function RotaryKnob({
  engine,
  schema,
  liveValue,
  learnArm,
  armed = false,
  size = 48,
}: {
  engine: Engine
  schema: ParamSchema
  /** This param's most recently polled live value (App's 100ms poll) —
   * rendered instead of local interactive state whenever the param is bound. */
  liveValue: number
  /** Present only while the panel's global Learn mode is on; arms this param
   * as the next MIDI-learn bind target. Called on drag/wheel, same as the
   * studio slider's onChange. */
  learnArm?: () => void
  /** True when this is the currently-armed learn target — highlights the dial. */
  armed?: boolean
  size?: number
}) {
  const { bound } = useParamBinding(engine, schema.name)
  // Local interactive value — same pattern as the studio Knob: seeded once
  // from the engine at mount, then driven purely by this control's own
  // pointer/wheel/dblclick handlers. Only read while unbound; a bound param
  // always renders `liveValue` instead, so this never fights the poll.
  const [value, setValue] = useState(engine.scene.getParam(schema.name))
  const dragRef = useRef<{ pointerId: number; startY: number; startValue: number } | null>(null)

  const displayValue = bound ? liveValue : value

  const commit = (raw: number) => {
    // Snap to the schema's step (review finding): the studio slider is
    // step-constrained by its range input, so the rotary must be too —
    // otherwise integer params (lissajous freqX, kaleido segments, …) get
    // fractional values the slider can never produce.
    const step = schema.step
    const v = step
      ? Math.min(schema.max, Math.max(schema.min, Math.round((raw - schema.min) / step) * step + schema.min))
      : raw
    setValue(v)
    engine.setParam(schema.name, v)
    learnArm?.()
  }

  const onPointerDown = (ev: React.PointerEvent<SVGSVGElement>) => {
    if (bound) return
    ev.currentTarget.setPointerCapture(ev.pointerId)
    dragRef.current = { pointerId: ev.pointerId, startY: ev.clientY, startValue: value }
  }

  const onPointerMove = (ev: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== ev.pointerId || bound) return
    const deltaY = ev.clientY - drag.startY
    commit(dragDeltaToValue(drag.startValue, deltaY, schema.min, schema.max, ev.shiftKey))
  }

  const onPointerUp = (ev: React.PointerEvent<SVGSVGElement>) => {
    if (dragRef.current?.pointerId === ev.pointerId) dragRef.current = null
  }

  const onWheel = (ev: React.WheelEvent<SVGSVGElement>) => {
    if (bound) return
    ev.preventDefault()
    commit(wheelDeltaToValue(value, ev.deltaY, schema.min, schema.max))
  }

  const onDoubleClick = () => {
    if (bound) return
    commit(schema.default)
  }

  const angle = valueToAngle(displayValue, schema.min, schema.max)
  const trackPath = describeArc(50, 50, RADIUS, TRACK_START, TRACK_END)
  const valuePath = describeArc(50, 50, RADIUS, TRACK_START, angle)
  const needleStart = polarToCartesian(50, 50, NEEDLE_INNER, angle)
  const needleEnd = polarToCartesian(50, 50, NEEDLE_OUTER, angle)

  return (
    <div className={`rotary-knob${bound ? ' rotary-knob-bound' : ''}${armed ? ' rotary-knob-armed' : ''}`}>
      <span className="rotary-knob-label">{schema.label}</span>
      <svg
        className="rotary-knob-dial"
        width={size}
        height={size}
        viewBox="0 0 100 100"
        role="slider"
        aria-label={schema.label}
        aria-valuemin={schema.min}
        aria-valuemax={schema.max}
        aria-valuenow={displayValue}
        aria-disabled={bound}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
      >
        <circle cx="50" cy="50" r={RADIUS} className="rotary-knob-face" />
        <path d={trackPath} className="rotary-knob-track" />
        <path d={valuePath} className="rotary-knob-value-arc" />
        <line x1={needleStart.x} y1={needleStart.y} x2={needleEnd.x} y2={needleEnd.y} className="rotary-knob-needle" />
        <circle cx="50" cy="50" r="6" className="rotary-knob-hub" />
      </svg>
      <span className="rotary-knob-value">{displayValue.toFixed(2)}</span>
    </div>
  )
}
