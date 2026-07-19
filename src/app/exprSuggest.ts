import type { ParamSchema } from '../scenes/types'

/**
 * Expression guidance (user-approved design: smart placeholders + a
 * tap-to-apply "fx" menu per param row). Everything here is a pure function
 * of the param's schema, so it's unit-testable — and the unit test goes one
 * step further and COMPILES every generated expression through the real DSL,
 * so a suggestion that wouldn't parse can never ship.
 *
 * Range-mapping: every suggestion is written against the param's own
 * [min, max] span, so tapping one always produces motion inside the param's
 * legal range — the single biggest stumbling block with a blank expression
 * box (a bare `bass * 2` barely moves a 1..12 param and blows out a 0..0.1
 * one).
 */

export interface ExprSuggestion {
  /** Plain-words label shown in the menu ("Pulse with the bass"). */
  label: string
  /** The ready-to-apply DSL expression. */
  expr: string
}

/** Step-aware number formatting: integer-stepped params get whole numbers,
 * everything else 1-3 significant decimals without float noise. */
function fmt(value: number, schema: Pick<ParamSchema, 'step'>): string {
  if (schema.step !== undefined && schema.step >= 1) return String(Math.round(value))
  const rounded = Math.round(value * 1000) / 1000
  return String(rounded)
}

/**
 * The tap-to-apply suggestions for one param. Deliberately five, in a fixed
 * teaching order: audio-follow, beat-lock, onset-hit, autonomous motion,
 * performance-pad — one exemplar per signal family the DSL exposes.
 */
export function suggestionsFor(schema: ParamSchema): ExprSuggestion[] {
  const span = schema.max - schema.min
  const lo = (f: number) => fmt(schema.min + span * f, schema)
  const amp = (f: number) => fmt(span * f, schema)
  const mid = fmt(schema.min + span * 0.5, schema)
  return [
    { label: 'Pulse with the bass', expr: `${lo(0.2)} + bass * ${amp(0.6)}` },
    { label: 'Sweep once per beat', expr: `${lo(0)} + beatPhase * ${amp(1)}` },
    { label: 'Kick on every onset', expr: `${lo(0.15)} + env(0.01, 0.4, onset) * ${amp(0.7)}` },
    { label: 'Slow autonomous wave', expr: `${mid} + sin(time * 0.4) * ${amp(0.35)}` },
    { label: 'Follow the XY pad (x)', expr: `${lo(0)} + pad.x * ${amp(1)}` },
  ]
}

/** Signals rotated through the greyed-out placeholder examples, so scanning
 * down a param list passively teaches the vocabulary. */
const PLACEHOLDER_SIGNALS = ['bass', 'rms', 'beatPhase', 'high', 'pad.y'] as const

/**
 * A range-correct, param-specific placeholder for the expression box —
 * teaching by osmosis instead of the old one-size-fits-none static example.
 * `slot` (1-based macro position, null when unslotted) just picks which
 * signal the example shows, cycling so neighboring rows differ.
 */
export function placeholderFor(schema: ParamSchema, slot: number | null): string {
  const span = schema.max - schema.min
  const signal = PLACEHOLDER_SIGNALS[((slot ?? 1) - 1) % PLACEHOLDER_SIGNALS.length]
  const base = fmt(schema.min + span * 0.2, schema)
  const amp = fmt(span * 0.6, schema)
  return `e.g. ${base} + ${signal} * ${amp}`
}
