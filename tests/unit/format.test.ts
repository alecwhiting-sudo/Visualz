import { describe, expect, it } from 'vitest'
import { CANVAS_FORMATS, exportSize, liveSize, type ExportTier } from '../../src/core/format'

const TIERS: ExportTier[] = ['standard', 'high', 'max']

/** Format label -> exact width/height ratio, for the integer sizes this table returns. */
const RATIO: Record<(typeof CANVAS_FORMATS)[number], number> = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1,
}

describe('liveSize', () => {
  it('is exactly 518,400 pixels for every format (equal GPU cost, Scene Contract F3)', () => {
    for (const f of CANVAS_FORMATS) {
      const { width, height } = liveSize(f)
      expect(width * height).toBe(518_400)
    }
  })

  it('has even width and height for every format', () => {
    for (const f of CANVAS_FORMATS) {
      const { width, height } = liveSize(f)
      expect(width % 2).toBe(0)
      expect(height % 2).toBe(0)
    }
  })

  it('matches the format label ratio exactly', () => {
    for (const f of CANVAS_FORMATS) {
      const { width, height } = liveSize(f)
      expect(width / height).toBe(RATIO[f])
    }
  })
})

describe('exportSize', () => {
  it('has even width and height for every format and tier (H.264 requirement)', () => {
    for (const f of CANVAS_FORMATS) {
      for (const tier of TIERS) {
        const { width, height } = exportSize(f, tier)
        expect(width % 2).toBe(0)
        expect(height % 2).toBe(0)
      }
    }
  })

  it('matches the format label ratio exactly', () => {
    for (const f of CANVAS_FORMATS) {
      for (const tier of TIERS) {
        const { width, height } = exportSize(f, tier)
        expect(width / height).toBe(RATIO[f])
      }
    }
  })

  it('16:9 sizes match App.tsx EXPORT_QUALITIES so wiring this in cannot change existing export output', () => {
    expect(exportSize('16:9', 'standard')).toEqual({ width: 1280, height: 720 })
    expect(exportSize('16:9', 'high')).toEqual({ width: 1920, height: 1080 })
    expect(exportSize('16:9', 'max')).toEqual({ width: 1920, height: 1080 })
  })
})
