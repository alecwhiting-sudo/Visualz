import { expect, test } from '@playwright/test'

/**
 * Portrait band-coverage harness (docs/SCENE_CONTRACT.md F4): for every
 * `framing: 'field'` scene, asserts a 9:16 (540x960) frame AND a 1:1
 * (720x720) frame carries ink across every horizontal band, not just a
 * centred strip — mechanical enforcement of "full-bleeds at every aspect"
 * for the class of scene the contract says holds that property by
 * construction (F1/F2). Uses the `bandCoverage` harness hook
 * (`src/testing/hooks.ts` / `src/gpu/readback.ts`): splits the frame into
 * `BANDS` equal-height horizontal strips (index 0 = top) and returns each
 * strip's mean of `max(r,g,b)` per pixel, 0-255.
 *
 * Scene list mirrors docs/FRAMING_AUDIT.md section A ("Conformant today —
 * declaration-only"), the `framing: 'field'` subset: cymatics, morph
 * (Morphogen — registry id is 'morph', not 'morphogen'), resonance,
 * mandeldive, orbitdive, physarum, waves, glyphrain — plus flowfield,
 * grayscott, and kaleido, added by their section B.1/B.2/B.3 F1/F2/F3
 * migrations (docs/FRAMING_AUDIT.md). The `'bounded'` scenes from that same
 * section (guilloche/whipline/whipstorm) are NOT covered here — F4 only
 * *requires* band coverage for `'field'`.
 *
 * Settle-frame counts and any test-mode query flags (`&count=`/`&grid=`) are
 * copied from each scene's own golden spec — same seed=42, same frame — so
 * this probes the composition of a frame that already has a checked-in
 * golden, just measured a different way.
 */

const BANDS = 6
const DEFAULT_FLOOR = 6 // out of 255 — the task's starting floor

interface FieldScene {
  id: string
  extraQuery?: string
  settleFrames: number
  floor?: number // per-scene override when DEFAULT_FLOOR is too strict for a legitimately-darker idle
  slow?: boolean // mirrors the source spec's test.slow() for scenes with expensive first-readback cost
}

// Keep in sync with docs/FRAMING_AUDIT.md section A's `framing: 'field'` list
// (plus flowfield/grayscott/kaleido, migrated per section B.1/B.2/B.3).
const FIELD_SCENES: FieldScene[] = [
  { id: 'cymatics', settleFrames: 150 },
  { id: 'morph', settleFrames: 90 },
  { id: 'resonance', settleFrames: 300 },
  { id: 'mandeldive', settleFrames: 450, slow: true },
  { id: 'orbitdive', settleFrames: 150 },
  { id: 'physarum', extraQuery: '&count=16384', settleFrames: 200, slow: true },
  { id: 'waves', extraQuery: '&grid=128', settleFrames: 150 },
  { id: 'glyphrain', settleFrames: 90 },
  // flowfield: floor 3, not 6 — a sparse continuously-flowing swarm whose
  // outer bands legitimately read dim (4.1-4.4 at seed 42/settle 90, exactly
  // reproducible) but carry real ink; the failure this check exists to catch
  // (the pre-migration inscribed-square, structurally empty outer bands)
  // reads ~0 and still fails floor 3 by a wide margin. Architect calibration
  // call — do not raise settleFrames to chase a pass, band density is not
  // monotonic in settle for a flowing swarm.
  { id: 'flowfield', extraQuery: '&count=16384', settleFrames: 90, floor: 3 },
  // grayscott/kaleido: COVER migration (docs/FRAMING_AUDIT.md section B.2/B.3).
  // Settle/query copied from each scene's own golden spec (tests/e2e/grayscott.spec.ts,
  // tests/e2e/newscenes.spec.ts).
  { id: 'grayscott', extraQuery: '&grid=128', settleFrames: 96 },
  { id: 'kaleido', settleFrames: 90 },
]

const ASPECTS = [
  { label: '9:16', size: '&w=540&h=960' },
  { label: '1:1', size: '&w=720&h=720' },
] as const

async function boot(page: import('@playwright/test').Page, scene: FieldScene, size: string) {
  await page.goto(`/?test=1&seed=42&scene=${scene.id}${scene.extraQuery ?? ''}${size}`)
  await page.waitForFunction(() => window.__viz !== undefined)
}

for (const scene of FIELD_SCENES) {
  for (const aspect of ASPECTS) {
    test(`${scene.id} carries ink in every band at ${aspect.label}`, async ({ page }) => {
      if (scene.slow) test.slow()
      await boot(page, scene, aspect.size)
      await page.evaluate((n) => window.__viz!.renderFrames(n), scene.settleFrames)
      const bands = await page.evaluate((n) => window.__viz!.bandCoverage(n), BANDS)
      const floor = scene.floor ?? DEFAULT_FLOOR
      expect(bands.length).toBe(BANDS)
      for (let i = 0; i < bands.length; i++) {
        expect(bands[i], `${scene.id} @ ${aspect.label}: band ${i}/${bands.length} (top=0) = ${bands[i]}, floor ${floor}`).toBeGreaterThan(floor)
      }
    })
  }
}
