import { expect, test } from '@playwright/test'

/**
 * Scene handoff (docs/HANDOFF.md): a live switch captures A's rendered frame,
 * builds B, and hands the snapshot to B's duck-typed `ingest()` — an in-place
 * `Engine.switchScene` (§4) that records/replays/exports identically via a
 * `switch` session event (§5/§7). Same render-mode `?test=1` harness as the
 * other e2e specs.
 *
 * Golden pair: flowfield -> photoswarm — a CONTRACTIVE sink (spring-damped
 * swarm), per the spec's explicit warning: a Gray-Scott *sink* in a golden
 * would amplify ordinary cross-GPU 1-LSB readback variance instead of
 * damping it (docs/HANDOFF.md §1/§10). Other tests use grayscott -> kaleido
 * and lissajous -> tunnel to exercise the remaining ingesting scenes
 * (photoswarm/flowfield/grayscott/kaleido/tunnel) across the suite.
 */

test.setTimeout(120_000) // export determinism below drives VP9 encode, same budget as export.spec.ts

const PARTICLE_TEST_COUNT = 16384 // 128^2 rung — bounds flowfield's/photoswarm's per-frame GPGPU cost on SwiftShader.
const GRAYSCOTT_TEST_GRID = 96 // smaller than the 256 ship default — bounds grayscott's 16-substep cost as the handoff source.

async function boot(
  page: import('@playwright/test').Page,
  scene: string,
  opts: { size?: string; seed?: number; extra?: string } = {},
) {
  const seed = opts.seed ?? 42
  const size = opts.size ?? ''
  const extra = opts.extra ?? ''
  await page.goto(`/?test=1&seed=${seed}&scene=${scene}${size}${extra}`)
  await page.waitForFunction(() => window.__viz !== undefined)
}

async function litPixelCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas')!
    const gl = canvas.getContext('webgl2')!
    const pixels = new Uint8Array(canvas.width * canvas.height * 4)
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    let lit = 0
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 30) lit++
    }
    return lit
  })
}

function minimalDoc(sceneId: string, durationFrames: number, seed = 42) {
  return {
    version: 1,
    seed,
    fps: 30,
    scene: { id: sceneId, params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames,
    events: [] as unknown[],
  }
}

// --- 1. Handoff golden: flowfield -> photoswarm (required, contractive sink) --

const GOLDEN_A_FRAMES = 60
const GOLDEN_B_FRAMES = 60

test('flowfield -> photoswarm handoff renders deterministically', async ({ page }) => {
  await boot(page, 'flowfield', { extra: `&count=${PARTICLE_TEST_COUNT}` })
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_A_FRAMES)
  await page.evaluate(() => window.__viz!.switchScene('photoswarm'))
  // B (photoswarm) boots at the default 256^2 particle-count rung — shrink it
  // to the same CI-bounded rung as A, same convention as particles.spec.ts.
  await page.evaluate((count) => window.__viz!.setParam('count', count), PARTICLE_TEST_COUNT)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_B_FRAMES)
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(GOLDEN_A_FRAMES + GOLDEN_B_FRAMES)
  await expect(page.locator('canvas')).toHaveScreenshot('handoff-flowfield-to-photoswarm-f120.png')
})

test('flowfield -> photoswarm handoff canvas is not blank', async ({ page }) => {
  await boot(page, 'flowfield', { extra: `&count=${PARTICLE_TEST_COUNT}` })
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_A_FRAMES)
  await page.evaluate(() => window.__viz!.switchScene('photoswarm'))
  await page.evaluate((count) => window.__viz!.setParam('count', count), PARTICLE_TEST_COUNT)
  await page.evaluate((n) => window.__viz!.renderFrames(n), GOLDEN_B_FRAMES)
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

// --- 2. Replay byte-identity spanning a switch (required — proves I3-I7) -----
// grayscott -> kaleido: exercises the two texture-primed ingests (luminance ->
// chemistry field, and resample -> feedback buffer) in the same test.

const REPLAY_A_FRAMES = 20
const REPLAY_B_FRAMES = 20

async function recordHandoffDoc(page: import('@playwright/test').Page, toScene: string, k: number, m: number) {
  return page.evaluate(
    ({ toScene, k, m }) => {
      window.__viz!.startRecording()
      window.__viz!.renderFrames(k)
      window.__viz!.switchScene(toScene)
      window.__viz!.renderFrames(m)
      return window.__viz!.stopRecording()
    },
    { toScene, k, m },
  )
}

test('replay is byte-identical across a switch, run twice (invariants I3-I7)', async ({ page }) => {
  await boot(page, 'grayscott', { extra: `&grid=${GRAYSCOTT_TEST_GRID}` })
  const doc = await recordHandoffDoc(page, 'kaleido', REPLAY_A_FRAMES, REPLAY_B_FRAMES)
  const liveHash = await page.evaluate(() => window.__viz!.pixelHash())

  // `loadSession` requires the constructed scene to match `doc.scene.id`
  // (the *initial* scene, grayscott) — the live engine above is no longer
  // that instance (the in-place switch already swapped it to kaleido), same
  // as the real app's replay path always building a fresh Engine for
  // `doc.scene.id` (App.tsx's replaySession, export/render.ts's
  // renderSessionToVideo). Re-boot fresh before each replay.
  const replayOnce = async () => {
    await boot(page, 'grayscott', { extra: `&grid=${GRAYSCOTT_TEST_GRID}` })
    return page.evaluate((d) => {
      window.__viz!.loadSession(d)
      window.__viz!.renderFrames((d as { durationFrames: number }).durationFrames)
      return window.__viz!.pixelHash()
    }, doc)
  }

  const replay1 = await replayOnce()
  expect(replay1).toBe(liveHash)

  // CLAUDE.md's double-run rule: replay a second time and assert byte-identity
  // against both the live hash and the first replay.
  const replay2 = await replayOnce()
  expect(replay2).toBe(liveHash)
  expect(replay2).toBe(replay1)
})

// --- 3. Export determinism spanning a switch ---------------------------------

const EXPORT_A_FRAMES = 15
const EXPORT_B_FRAMES = 15

test('export determinism spans a switch', async ({ page }) => {
  await boot(page, 'flowfield', { extra: `&count=${PARTICLE_TEST_COUNT}` })
  const doc = await page.evaluate(
    ({ toScene, k, m, count }) => {
      window.__viz!.startRecording()
      window.__viz!.renderFrames(k)
      window.__viz!.switchScene(toScene)
      window.__viz!.setParam('count', count)
      window.__viz!.renderFrames(m)
      return window.__viz!.stopRecording()
    },
    { toScene: 'photoswarm', k: EXPORT_A_FRAMES, m: EXPORT_B_FRAMES, count: PARTICLE_TEST_COUNT },
  )

  const [run1, run2] = await page.evaluate(async (sessionDoc) => {
    const opts = { width: 320, height: 180, fps: 30, collectHashes: true }
    const a = await window.__viz!.exportSession(sessionDoc, opts)
    const b = await window.__viz!.exportSession(sessionDoc, opts)
    return [a, b]
  }, doc)

  expect(run1.frameHashes?.length).toBe(EXPORT_A_FRAMES + EXPORT_B_FRAMES)
  // Two exports of the same session (which crosses a mid-replay switch) must
  // encode byte-identical per-frame readback content — the OffscreenCanvas
  // worker building the initial scene then switching mid-replay introduces no
  // divergence. (Not compared to live-replay: different render resolution.)
  expect(run2.frameHashes).toEqual(run1.frameHashes)
})

// --- 4. Edge case: A->A is a deterministic soft reset ------------------------

test('A->A switch is a deterministic soft reset', async ({ page }) => {
  const runTwice = async () => {
    await boot(page, 'flowfield', { extra: `&count=${PARTICLE_TEST_COUNT}` })
    return page.evaluate((n) => {
      window.__viz!.renderFrames(n)
      window.__viz!.switchScene('flowfield') // A -> A: dispose + fresh init + self-ingest
      window.__viz!.renderFrames(n)
      return window.__viz!.pixelHash()
    }, 20)
  }
  const hash1 = await runTwice()
  const hash2 = await runTwice()
  expect(hash2).toBe(hash1)
})

// --- 5. Edge case: unknown scene id throws -----------------------------------

test('switchScene throws on an unknown scene id', async ({ page }) => {
  await boot(page, 'lissajous')
  const message = await page.evaluate(() => {
    try {
      window.__viz!.switchScene('nope')
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  })
  expect(message).not.toBeNull()
  expect(message!.toLowerCase()).toMatch(/unknown scene/)
})

test('a hand-built doc with a bad toScene throws when replayed', async ({ page }) => {
  await boot(page, 'lissajous')
  const doc = { ...minimalDoc('lissajous', 5), events: [{ frame: 2, type: 'switch', toScene: 'nope' }] }
  const message = await page.evaluate((d) => {
    try {
      window.__viz!.loadSession(d)
      window.__viz!.renderFrames((d as { durationFrames: number }).durationFrames)
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }, doc)
  expect(message).not.toBeNull()
  expect(message!.toLowerCase()).toMatch(/unknown scene/)
})

// --- 6. Architect amendment §5a: a recording started AFTER a handoff --------
// (invariant I11) — lissajous -> tunnel (tunnel's ingest is otherwise
// untouched by the other tests in this file, and the "weakest fit" scene is
// exactly the one this test should hold to the same standard as the rest).

test('§5a: a recording started after a handoff replays the true post-switch state (invariant I11)', async ({
  page,
}) => {
  await boot(page, 'lissajous')
  // Switch A -> B (tunnel ingests) BEFORE any recording exists, matching the
  // spec's literal sequence — `startRecording` snapshots the engine at a
  // point where the live scene is already B, born from the switch's ingest
  // snapshot, which lives nowhere in the doc except `storedImage`.
  const { doc, liveHash } = await page.evaluate((n) => {
    window.__viz!.switchScene('tunnel')
    window.__viz!.startRecording() // recording starts AFTER the switch: no 'switch' event in the log
    window.__viz!.renderFrames(n)
    const recordedDoc = window.__viz!.stopRecording()
    return { doc: recordedDoc, liveHash: window.__viz!.pixelHash() }
  }, 20)

  // `loadSession` on the SAME (already-tunnel) engine is valid here — unlike
  // the replay test above, no re-boot is needed because the live engine's
  // current scene ('tunnel') already matches `doc.scene.id`.
  const replayHash = await page.evaluate((d) => {
    window.__viz!.loadSession(d)
    window.__viz!.renderFrames((d as { durationFrames: number }).durationFrames)
    return window.__viz!.pixelHash()
  }, doc)

  expect(replayHash).toBe(liveHash)

  // The doc actually carries the handoff snapshot as scene.image (proves
  // storedImage picked up the switch's ingest snapshot, not a stale/absent
  // image) with zero 'switch' events — the switch itself predates recording.
  const typedDoc = doc as {
    scene: { id: string; image?: { width: number; height: number; data: string } }
    events: unknown[]
  }
  expect(typedDoc.scene.id).toBe('tunnel')
  expect(typeof typedDoc.scene.image?.data).toBe('string')
  expect(typedDoc.events.filter((e) => (e as { type: string }).type === 'switch')).toEqual([])
})
