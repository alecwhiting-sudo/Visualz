/**
 * Canvas format table: the sizes the live engine and the exporter use for each
 * supported aspect ratio. Output targets (aspect + resolution per tier) are
 * REQUIREMENTS.md §5.2; this module is just the lookup table, not the source
 * of truth for product decisions. Bitrate is a per-tier property owned by the
 * caller (`src/app/App.tsx`'s `EXPORT_QUALITIES`) — not tracked here, since
 * bitrate has no live-preview equivalent and doesn't belong in a table shared
 * with the live path.
 */

export type CanvasFormat = '16:9' | '9:16' | '1:1'

export const CANVAS_FORMATS: readonly CanvasFormat[] = ['16:9', '9:16', '1:1']

/**
 * Live-engine backing-store size per format. All three are exactly 518,400
 * pixels so GPU cost and the quality scaler behave identically across
 * formats (Scene Contract F3 relies on this: resolution-keyed sizing must be
 * able to assume a format-neutral pixel budget).
 */
export function liveSize(format: CanvasFormat): { width: number; height: number } {
  switch (format) {
    case '16:9':
      return { width: 960, height: 540 }
    case '9:16':
      return { width: 540, height: 960 }
    case '1:1':
      return { width: 720, height: 720 }
  }
}

export type ExportTier = 'standard' | 'high' | 'max'

/** Export dimensions per format and quality tier. 'high' and 'max' share a resolution — 'max' differs only in bitrate (owned by the caller, see module doc). */
export function exportSize(format: CanvasFormat, tier: ExportTier): { width: number; height: number } {
  const hi = tier !== 'standard'
  switch (format) {
    case '16:9':
      return hi ? { width: 1920, height: 1080 } : { width: 1280, height: 720 }
    case '9:16':
      return hi ? { width: 1080, height: 1920 } : { width: 720, height: 1280 }
    case '1:1':
      return hi ? { width: 1080, height: 1080 } : { width: 720, height: 720 }
  }
}
