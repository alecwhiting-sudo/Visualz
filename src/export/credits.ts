/**
 * Automatic credits overlay for exported video (user-requested feature).
 *
 * Pure, dependency-free helpers only — no `Date.now`/`performance.now`/
 * `Math.random` (this lives outside `src/app/`, so the hard rule applies), no
 * canvas-state assumptions beyond what's passed in. `render.ts` is the only
 * caller that decides *whether* to composite credits at all (gated on both
 * lines being blank after trim, so the byte-identical-when-unused guarantee
 * lives there, not here).
 *
 * `creditsAlpha`'s signature is deliberately general — a time window
 * (`windowSec` before the end, fading in over `fadeSec`) rather than a
 * hardcoded "last 5 seconds" — so a future INTRO variant (show for the first
 * `N` seconds instead of the last) can reuse the exact same function with a
 * different window placement, once that's asked for.
 */

export interface CreditsWindowOpts {
  /** How many seconds before the end of the video the credits start fading
   * in. Default 5. */
  windowSec?: number
  /** How long the fade-in takes, in seconds. Default 1. */
  fadeSec?: number
}

const DEFAULT_WINDOW_SEC = 5
const DEFAULT_FADE_SEC = 1

/**
 * Opacity (0..1) for the credits overlay at `timeSec` into a video of total
 * length `durationSec`. Fades linearly from 0 to 1 over `fadeSec` seconds
 * starting at `durationSec - windowSec`, then holds at 1 through the end.
 *
 * For a video shorter than `windowSec`, the window start clamps to 0 (i.e.
 * `max(0, durationSec - windowSec)`) — the credits show from t=0 with the
 * same fade shape, rather than a window start before the video even begins.
 */
export function creditsAlpha(timeSec: number, durationSec: number, opts: CreditsWindowOpts = {}): number {
  const windowSec = opts.windowSec ?? DEFAULT_WINDOW_SEC
  const fadeSec = opts.fadeSec ?? DEFAULT_FADE_SEC
  const start = Math.max(0, durationSec - windowSec)
  if (timeSec <= start) return 0
  if (fadeSec <= 0) return 1
  const t = (timeSec - start) / fadeSec
  return Math.min(1, Math.max(0, t))
}

/** Fraction of `line1`'s alpha that `line2` renders at, at full opacity —
 * "slightly dimmer" per spec. */
const LINE2_ALPHA_FACTOR = 0.8

const FONT_STACK = "system-ui, -apple-system, Helvetica, Arial, sans-serif"
/** Padding from the bottom-right corner, as a fraction of frame height. */
const PADDING_FRAC = 0.035
/** Line 1 font size, as a fraction of frame height. */
const LINE1_SIZE_FRAC = 0.032
/** Line 2 font size, as a fraction of frame height. */
// Equal to line 1 (user request) — the lines differ by dimness, not size.
const LINE2_SIZE_FRAC = 0.032
/** Vertical gap between the two lines' baselines, as a multiple of line 2's
 * font size. */
const LINE_GAP_FACTOR = 1.5

/**
 * Draws the two credit lines bottom-right onto `ctx`, at `alpha` (the overall
 * fade-in progress from `creditsAlpha`). White text with a dark shadow for
 * legibility on bright ink, right-aligned, normal weight. A no-op for a blank
 * (post-trim) line, and entirely a no-op when `alpha <= 0`.
 */
export function drawCredits(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  line1: string,
  line2: string,
  alpha: number,
): void {
  if (alpha <= 0) return
  const l1 = line1.trim()
  const l2 = line2.trim()
  if (!l1 && !l2) return

  const padding = height * PADDING_FRAC
  const size1 = height * LINE1_SIZE_FRAC
  const size2 = height * LINE2_SIZE_FRAC
  const x = width - padding
  // Overflow guard (review finding): fillText's maxWidth condenses a too-long
  // line to fit between the left frame edge (mirror padding) and the anchor,
  // instead of silently clipping off-frame at narrow aspects (9:16).
  const maxWidth = width - padding * 2

  ctx.save()
  ctx.textAlign = 'right'
  ctx.textBaseline = 'alphabetic'
  ctx.shadowColor = 'rgba(0, 0, 0, 0.65)'

  // Bottom line (line2) anchors to the padding; line1 sits above it.
  const line2Y = height - padding
  const line1Y = line2Y - size2 * LINE_GAP_FACTOR

  if (l1) {
    ctx.font = `normal ${size1}px ${FONT_STACK}`
    ctx.shadowBlur = size1 * 0.2
    ctx.shadowOffsetY = size1 * 0.05
    ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`
    ctx.fillText(l1, x, line1Y, maxWidth)
  }
  if (l2) {
    ctx.font = `normal ${size2}px ${FONT_STACK}`
    ctx.shadowBlur = size2 * 0.2
    ctx.shadowOffsetY = size2 * 0.05
    ctx.fillStyle = `rgba(255, 255, 255, ${alpha * LINE2_ALPHA_FACTOR})`
    ctx.fillText(l2, x, line2Y, maxWidth)
  }

  ctx.restore()
}

/** Whether `line1`/`line2` are active (at least one non-blank after trim) —
 * the single gate every caller (export compositing, replay overlay, the
 * SESSION-tab persistence) should share so "both blank" reliably means
 * "nothing changes anywhere". */
export function creditsActive(line1: string, line2: string): boolean {
  return line1.trim().length > 0 || line2.trim().length > 0
}
