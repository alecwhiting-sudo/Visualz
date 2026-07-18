import { useRef } from 'react'
import { describeArc, dragDeltaToValue, polarToCartesian, valueToAngle, wheelDeltaToValue } from './rotaryMath'

const RADIUS = 42
const NEEDLE_INNER = 12
const NEEDLE_OUTER = 34
const TRACK_START = -135
const TRACK_END = 135

const MIN_SECONDS = 0.1
const MAX_SECONDS = 10
const DEFAULT_SECONDS = 1
// log10(0.1) / log10(10) — the knob operates in log space internally.
const LOG_MIN = -1
const LOG_MAX = 1

function toLog(seconds: number): number {
  return Math.log10(Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, seconds)))
}
function fromLog(log: number): number {
  return Math.pow(10, Math.min(LOG_MAX, Math.max(LOG_MIN, log)))
}

/**
 * Frame F1-F8 task (#35): a standalone RotaryKnob-style dial for the PERFORM
 * tab's "transition speed" (shift+press glide duration, 0.1-10s) — App-local
 * state, NOT a scene param, so it can't be macro/MIDI-mapped or recorded into
 * a session (it governs HOW a frame press plays out, not what a take itself
 * reproduces). Deliberately a separate component from `RotaryKnob.tsx` (which
 * is hard-wired to an `Engine` + `ParamSchema`) but shares its exact
 * drag/wheel/angle math (`rotaryMath.ts`) so it looks and feels identical.
 *
 * Operates on log10(seconds) internally: 0.1s-10s spans two decades, so a
 * linear drag would make the low end (where most musical transition times
 * live) impossibly twitchy relative to the high end — the "log feel" the
 * task asks for.
 */
export function TransitionSpeedKnob({
  seconds,
  onChange,
  label = 'Transition',
  ariaLabel = 'Transition speed',
  minLabel,
}: {
  seconds: number
  onChange: (seconds: number) => void
  /** Dial caption — the handoff-glide reuse (task: "a glide for handoffs")
   * relabels the same dial "Handoff". */
  label?: string
  ariaLabel?: string
  /** Shown instead of "0.1s" when the dial sits at its bottom stop — the
   * handoff dial's bottom stop means "hard cut", not a 0.1s dissolve. */
  minLabel?: string
}) {
  const dragRef = useRef<{ pointerId: number; startY: number; startLog: number } | null>(null)
  const logValue = toLog(seconds)

  const commit = (log: number) => onChange(fromLog(log))

  const onPointerDown = (ev: React.PointerEvent<SVGSVGElement>) => {
    ev.currentTarget.setPointerCapture(ev.pointerId)
    dragRef.current = { pointerId: ev.pointerId, startY: ev.clientY, startLog: logValue }
  }

  const onPointerMove = (ev: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== ev.pointerId) return
    const deltaY = ev.clientY - drag.startY
    commit(dragDeltaToValue(drag.startLog, deltaY, LOG_MIN, LOG_MAX, ev.shiftKey))
  }

  const onPointerUp = (ev: React.PointerEvent<SVGSVGElement>) => {
    if (dragRef.current?.pointerId === ev.pointerId) dragRef.current = null
  }

  const onWheel = (ev: React.WheelEvent<SVGSVGElement>) => {
    ev.preventDefault()
    commit(wheelDeltaToValue(logValue, ev.deltaY, LOG_MIN, LOG_MAX))
  }

  const onDoubleClick = () => onChange(DEFAULT_SECONDS)

  const angle = valueToAngle(logValue, LOG_MIN, LOG_MAX)
  const trackPath = describeArc(50, 50, RADIUS, TRACK_START, TRACK_END)
  const valuePath = describeArc(50, 50, RADIUS, TRACK_START, angle)
  const needleStart = polarToCartesian(50, 50, NEEDLE_INNER, angle)
  const needleEnd = polarToCartesian(50, 50, NEEDLE_OUTER, angle)

  return (
    <div className="rotary-knob">
      <span className="rotary-knob-label">{label}</span>
      <svg
        className="rotary-knob-dial"
        width={48}
        height={48}
        viewBox="0 0 100 100"
        role="slider"
        aria-label={ariaLabel}
        aria-valuemin={MIN_SECONDS}
        aria-valuemax={MAX_SECONDS}
        aria-valuenow={seconds}
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
      <span className="rotary-knob-value">
        {minLabel !== undefined && seconds <= MIN_SECONDS + 1e-9 ? minLabel : `${seconds.toFixed(1)}s`}
      </span>
    </div>
  )
}
