import { describe, expect, it } from 'vitest'
import { FxChain, FX_ENABLED_PARAM, buildFxPasses } from '../../src/fx/chain'

// Pure logic only (ordering/bypass/param routing) — no GPU: `init`/`render`
// need a real WebGL2 context, exercised instead by tests/e2e/fx.spec.ts.

describe('FxChain', () => {
  it('starts with every built-in pass disabled', () => {
    const chain = new FxChain()
    expect(chain.hasEnabled).toBe(false)
    for (const p of chain.passes) expect(chain.isEnabled(p.meta.id)).toBe(false)
  })

  it('lists the fixed built-in pass order', () => {
    const chain = new FxChain()
    expect(chain.passes.map((p) => p.meta.id)).toEqual(['kaleido', 'mirror', 'rgbshift', 'pixelate', 'posterize', 'zoompulse'])
  })

  it('enabling a pass via the reserved "enabled" param name flips hasEnabled', () => {
    const chain = new FxChain()
    chain.setParam('kaleido', FX_ENABLED_PARAM, 1)
    expect(chain.isEnabled('kaleido')).toBe(true)
    expect(chain.hasEnabled).toBe(true)
    chain.setParam('kaleido', FX_ENABLED_PARAM, 0)
    expect(chain.hasEnabled).toBe(false)
  })

  it('treats any enabled value >= 0.5 as on, matching a 0/1 recorded toggle', () => {
    const chain = new FxChain()
    chain.setParam('mirror', 'enabled', 0.4)
    expect(chain.isEnabled('mirror')).toBe(false)
    chain.setParam('mirror', 'enabled', 0.5)
    expect(chain.isEnabled('mirror')).toBe(true)
  })

  it('getParam falls back to the schema default for an untouched param', () => {
    const chain = new FxChain()
    const kaleido = chain.passes.find((p) => p.meta.id === 'kaleido')!
    for (const p of kaleido.params) {
      expect(chain.getParam('kaleido', p.name)).toBe(p.default)
    }
  })

  it('setParam/getParam round-trip an ordinary param', () => {
    const chain = new FxChain()
    chain.setParam('pixelate', 'cells', 42)
    expect(chain.getParam('pixelate', 'cells')).toBe(42)
  })

  it('is tolerant of an unknown pass id (no-op set, 0 get)', () => {
    const chain = new FxChain()
    expect(() => chain.setParam('nonexistent', 'foo', 1)).not.toThrow()
    expect(chain.getParam('nonexistent', 'foo')).toBe(0)
    expect(chain.isEnabled('nonexistent')).toBe(false)
  })

  it('reset() disables every pass and restores param defaults', () => {
    const chain = new FxChain()
    chain.setParam('kaleido', FX_ENABLED_PARAM, 1)
    chain.setParam('kaleido', 'segments', 12)
    chain.reset()
    expect(chain.hasEnabled).toBe(false)
    expect(chain.getParam('kaleido', 'segments')).toBe(6)
  })

  it('buildFxPasses returns fresh, independent pass instances each call', () => {
    const a = buildFxPasses()
    const b = buildFxPasses()
    expect(a).not.toBe(b)
    expect(a[0]).not.toBe(b[0])
  })
})
