import { describe, expect, it } from 'vitest'
import { SCENES } from '../../src/scenes/registry'
import { SHADER_DOCS } from '../../src/scenes/shaderDocs'

/**
 * CODE tab task: `SHADER_DOCS`'s whole value depends on every `tryThis.target`
 * actually appearing in the scene's CURRENT stock GLSL — a doc pointing at
 * code that isn't there is worse than none (see shaderDocs.ts's module
 * comment). Scenes are constructible and `getShaderSources()`-able without a
 * GL context: every builtin scene's editable-source fields are set by plain
 * instance-field initializers (e.g. `private lineSource = LINE_FS`), not
 * inside `init()`, so `new Scene().getShaderSources()` returns the real stock
 * source with no `Gpu`/WebGL mock needed at all.
 */

describe('SHADER_DOCS', () => {
  const sceneIds = Object.keys(SHADER_DOCS)

  it('covers all 17 builtin scenes (not the blend-* composites)', () => {
    expect(sceneIds.sort()).toEqual(
      [
        'flowfield',
        'fractallab',
        'glyphgeometry',
        'glyphlattice',
        'glyphrain',
        'grayscott',
        'julia',
        'kaleido',
        'lissajous',
        'mandeldive',
        'morph',
        'orbitdive',
        'photoswarm',
        'physarum',
        'resonance',
        'tunnel',
        'waves',
      ].sort(),
    )
  })

  for (const sceneId of sceneIds) {
    describe(sceneId, () => {
      const entry = SCENES[sceneId]

      it('is a registered scene', () => {
        expect(entry).toBeDefined()
      })

      if (entry) {
        const scene = entry.create()
        const sources = scene.getShaderSources ? scene.getShaderSources() : []
        const stages = SHADER_DOCS[sceneId]

        for (const [stageKey, doc] of Object.entries(stages)) {
          it(`stage "${stageKey}" exists and every tryThis target is verbatim in its stock source`, () => {
            const stage = sources.find((s) => s.key === stageKey)
            expect(stage, `scene "${sceneId}" has no shader stage "${stageKey}"`).toBeDefined()
            if (!stage) return

            expect(doc.summary.length).toBeGreaterThan(20)
            expect(doc.tryThis.length).toBeGreaterThanOrEqual(3)
            expect(doc.tryThis.length).toBeLessThanOrEqual(5)

            for (const t of doc.tryThis) {
              expect(
                stage.source.includes(t.target),
                `${sceneId}.${stageKey}: tryThis target ${JSON.stringify(t.target)} not found verbatim in stock source`,
              ).toBe(true)
              expect(t.effect.length).toBeGreaterThan(10)
            }
          })
        }

        it('has a doc entry for every stage the scene actually exposes', () => {
          for (const stage of sources) {
            expect(stages[stage.key], `scene "${sceneId}" exposes stage "${stage.key}" with no SHADER_DOCS entry`).toBeDefined()
          }
        })
      }
    })
  }
})
