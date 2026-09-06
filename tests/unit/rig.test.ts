import { describe, expect, it } from 'vitest'
import { classifyFile, parseRig, serializeRig, type SessionRig } from '../../src/session/rig'

/**
 * Session rig files (docs/SESSIONS.md): the tolerant parser is the
 * load-bearing piece — files referencing removed algorithms (Hyperbolic
 * precedent) or malformed entries must DEGRADE with warnings, never throw.
 */

const KNOWN = ['lissajous', 'julia', 'photoswarm']

function makeRig(): SessionRig {
  return {
    kind: 'session',
    version: 1,
    scenes: {
      lissajous: {
        params: { freqX: 7 },
        bindings: { freqY: '1 + bass * 11' },
        frames: [
          { values: [0.5, 0.2], exprs: [null, '1 + bass'] },
          null,
          null,
          null,
          null,
          null,
          null,
          null,
        ],
      },
      julia: { shaders: { 'render-fs': '// edited' } },
    },
    global: { transitionSpeed: 2, handoffFadeSeconds: 1.5, macroView: 1, switchTargetId: 'julia' },
  }
}

describe('session rig', () => {
  it('round-trips serialize -> parse losslessly for known scenes', () => {
    const { rig, warnings } = parseRig(serializeRig(makeRig()), KNOWN)
    expect(warnings).toEqual([])
    expect(rig.scenes.lissajous.params).toEqual({ freqX: 7 })
    expect(rig.scenes.lissajous.bindings).toEqual({ freqY: '1 + bass * 11' })
    expect(rig.scenes.lissajous.frames?.[0]).toEqual({ values: [0.5, 0.2], exprs: [null, '1 + bass'] })
    expect(rig.scenes.julia.shaders).toEqual({ 'render-fs': '// edited' })
    expect(rig.global).toEqual({ transitionSpeed: 2, handoffFadeSeconds: 1.5, macroView: 1, switchTargetId: 'julia' })
  })

  it('drops unknown scene ids with a warning instead of failing (removed-algorithm files load)', () => {
    const rig = makeRig()
    rig.scenes.hyperbolic = { params: { p: 7 } }
    const parsed = parseRig(serializeRig(rig), KNOWN)
    expect(parsed.rig.scenes.hyperbolic).toBeUndefined()
    expect(parsed.warnings.some((w) => w.includes('hyperbolic'))).toBe(true)
    expect(parsed.rig.scenes.lissajous).toBeDefined() // the rest survives
  })

  it('sanitizes malformed values: non-numeric params dropped, frames clamped to [0,1]', () => {
    const text = JSON.stringify({
      kind: 'session',
      version: 1,
      scenes: {
        lissajous: {
          params: { freqX: 3, bad: 'nope', inf: Infinity },
          frames: [[2, -1, 0.5], 'garbage', null],
        },
      },
      global: { transitionSpeed: 999, macroView: 7 },
    })
    const { rig } = parseRig(text, KNOWN)
    expect(rig.scenes.lissajous.params).toEqual({ freqX: 3 })
    expect(rig.scenes.lissajous.frames?.[0]).toEqual({ values: [1, 0, 0.5], exprs: [null, null, null] })
    expect(rig.scenes.lissajous.frames?.[1]).toBeNull()
    expect(rig.global.transitionSpeed).toBe(10) // clamped to the dial's max
    expect(rig.global.macroView).toBeUndefined() // 7 is not a valid view
  })

  it('version-tolerant: an OLD bare-number[] frame slot (pre-expression-capture) parses as an all-unbound frame', () => {
    const text = JSON.stringify({
      kind: 'session',
      version: 1,
      scenes: { lissajous: { frames: [[0.5, 0.2], null, null, null, null, null, null, null] } },
      global: {},
    })
    const { rig, warnings } = parseRig(text, KNOWN)
    expect(warnings).toEqual([])
    expect(rig.scenes.lissajous.frames?.[0]).toEqual({ values: [0.5, 0.2], exprs: [null, null] })
  })

  it('a new-shape frame slot with a malformed exprs array falls back to null per-index', () => {
    const text = JSON.stringify({
      kind: 'session',
      version: 1,
      scenes: {
        lissajous: {
          frames: [{ values: [0.5, 0.2], exprs: ['1 + bass', 42] }, null, null, null, null, null, null, null],
        },
      },
      global: {},
    })
    const { rig } = parseRig(text, KNOWN)
    expect(rig.scenes.lissajous.frames?.[0]).toEqual({ values: [0.5, 0.2], exprs: ['1 + bass', null] })
  })

  it('untouched scenes cost nothing: empty entries are dropped on serialize', () => {
    const rig = makeRig()
    rig.scenes.photoswarm = {}
    const text = serializeRig(rig)
    expect(JSON.parse(text).scenes.photoswarm).toBeUndefined()
  })

  it('rejects only structurally unusable files', () => {
    expect(() => parseRig('not json', KNOWN)).toThrow(/JSON/)
    expect(() => parseRig('{"kind":"performance"}', KNOWN)).toThrow(/session/)
    expect(() => parseRig('{"kind":"session","version":99}', KNOWN)).toThrow(/version/)
  })

  it('classifyFile routes sessions, performances (including legacy kind-less takes), and garbage', () => {
    expect(classifyFile(serializeRig(makeRig()))).toBe('session')
    expect(classifyFile(JSON.stringify({ version: 1, durationFrames: 30, events: [] }))).toBe('performance')
    expect(classifyFile(JSON.stringify({ kind: 'performance' }))).toBe('performance')
    expect(classifyFile('{"random":true}')).toBe('unknown')
    expect(classifyFile('garbage')).toBe('unknown')
  })
})
