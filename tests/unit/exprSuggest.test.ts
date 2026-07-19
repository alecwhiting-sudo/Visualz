import { describe, expect, it } from 'vitest'
import { compile } from '../../src/dsl/compile'
import { placeholderFor, suggestionsFor } from '../../src/app/exprSuggest'
import type { ParamSchema } from '../../src/scenes/types'

/**
 * Expression guidance: the load-bearing promise is that every suggestion the
 * fx menu offers ACTUALLY COMPILES through the real DSL — a menu item that
 * errors on tap is worse than no menu. So this suite runs each generated
 * expression for a spread of real-world schema shapes through `compile()`.
 */

const SCHEMAS: ParamSchema[] = [
  { name: 'freqX', label: 'X frequency', min: 1, max: 12, default: 3, step: 1 },
  { name: 'drift', label: 'Drift', min: 0, max: 2, default: 0.35 },
  { name: 'feed', label: 'Feed', min: 0.01, max: 0.09, default: 0.037 },
  { name: 'spin', label: 'Spin', min: -1, max: 1, default: 0.1 },
  { name: 'trail', label: 'Trail', min: 0.7, max: 0.995, default: 0.92 },
  { name: 'count', label: 'Count', min: 1024, max: 262144, default: 65536, step: 1 },
]

describe('exprSuggest', () => {
  for (const schema of SCHEMAS) {
    it(`every suggestion for "${schema.name}" (${schema.min}..${schema.max}) compiles`, () => {
      const suggestions = suggestionsFor(schema)
      expect(suggestions).toHaveLength(7)
      for (const s of suggestions) {
        expect(() => compile(s.expr, `suggest.${schema.name}`)).not.toThrow()
        expect(s.label.length).toBeGreaterThan(5)
      }
    })
  }

  it('suggestions are range-mapped: the beat sweep spans the full param range', () => {
    const sweep = suggestionsFor(SCHEMAS[0]).find((s) => s.label === 'Sweep once per beat')! // freqX 1..12
    expect(sweep.expr).toBe('1 + beatPhase * 11')
  })

  it('all three analysis bands are offered: bass, mids, highs', () => {
    const labels = suggestionsFor(SCHEMAS[1]).map((s) => s.label)
    expect(labels).toContain('Pulse with the bass')
    expect(labels).toContain('Pulse with the mids')
    expect(labels).toContain('Pulse with the highs')
    const mids = suggestionsFor(SCHEMAS[1]).find((s) => s.label === 'Pulse with the mids')!
    const highs = suggestionsFor(SCHEMAS[1]).find((s) => s.label === 'Pulse with the highs')!
    expect(mids.expr).toContain('mid *')
    expect(highs.expr).toContain('high *')
  })

  it('integer-stepped params get whole numbers, float params keep decimals', () => {
    const intSweep = suggestionsFor(SCHEMAS[5])[1].expr
    expect(intSweep).not.toMatch(/\.\d/)
    const floatBass = suggestionsFor(SCHEMAS[2])[0].expr
    expect(floatBass).toMatch(/0\.0\d/)
  })

  it('no float noise in formatted numbers', () => {
    for (const schema of SCHEMAS) {
      for (const s of suggestionsFor(schema)) {
        expect(s.expr).not.toMatch(/\d\.\d{4,}/)
      }
    }
  })

  it('placeholders are range-specific, cycle signals by slot, and also compile', () => {
    const p1 = placeholderFor(SCHEMAS[0], 1)
    const p2 = placeholderFor(SCHEMAS[0], 2)
    expect(p1).toContain('bass')
    expect(p2).toContain('rms')
    expect(p1).not.toBe(p2)
    for (let slot = 1; slot <= 8; slot++) {
      const p = placeholderFor(SCHEMAS[1], slot)
      expect(() => compile(p.replace(/^e\.g\. /, ''), 'placeholder')).not.toThrow()
    }
    // Null slot (unslotted param) still yields a valid placeholder.
    expect(placeholderFor(SCHEMAS[1], null)).toContain('e.g. ')
  })
})
