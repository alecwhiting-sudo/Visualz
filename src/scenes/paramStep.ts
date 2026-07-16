/**
 * Value quantization shared by every control that commits a value against a
 * `ParamSchema`'s `step` — the perform strip's `RotaryKnob` (a manual
 * drag/wheel commit) and the engine's `MacroRouter` (docs/MACROS.md §4/§6:
 * "step-snapping in the router identical to RotaryKnob's commit logic").
 * One formula, in one place neither `app/` nor `engine/` has to import from
 * the other to reach, so a macro-driven param and a manually-dragged rotary
 * land on the exact same quantized values for the same schema. A schema with
 * no `step` passes `raw` through unchanged (matching the studio slider's bare
 * `<input type="range">`, which has no snapping of its own beyond the
 * browser's native `step` handling).
 */
export function snapToStep(raw: number, min: number, max: number, step?: number): number {
  if (!step) return raw
  return Math.min(max, Math.max(min, Math.round((raw - min) / step) * step + min))
}
