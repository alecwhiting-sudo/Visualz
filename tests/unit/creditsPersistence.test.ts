import { describe, expect, it } from 'vitest'
import { blankCreditsLines, parseCreditsLines } from '../../src/app/creditsPersistence'

describe('parseCreditsLines', () => {
  it('returns blank lines for null/absent input', () => {
    expect(parseCreditsLines(null)).toEqual(blankCreditsLines())
  })

  it('parses a valid stored value back out unchanged', () => {
    const stored = { line1: 'Alec Whiting', line2: 'divurj.com' }
    expect(parseCreditsLines(JSON.stringify(stored))).toEqual(stored)
  })

  it('falls back to blank for malformed JSON', () => {
    expect(parseCreditsLines('{not json')).toEqual(blankCreditsLines())
  })

  it('falls back to blank for non-object JSON', () => {
    expect(parseCreditsLines(JSON.stringify([1, 2]))).toEqual(blankCreditsLines())
  })

  it('drops non-string fields individually rather than invalidating the whole value', () => {
    expect(parseCreditsLines(JSON.stringify({ line1: 5, line2: 'ok' }))).toEqual({ line1: '', line2: 'ok' })
  })
})
