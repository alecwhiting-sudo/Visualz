import { expect, test } from '@playwright/test'

/**
 * Golden/behavioral tests for "Whip Line" (geometry family). Structure copied
 * from wildcards.spec.ts (boot helper, litPixelCount, minimalDoc) and
 * waves.spec.ts (the extremes-stability pattern with distinctLevelCount as a
 * second non-blank-but-not-NaN-washed signal, plus the byte-identical replay
 * check via loadSession).
 *
 * Frame 150 (5s at the demo audio's ~120 BPM / 30fps) is well past several
 * beat pulses — the ring buffer already holds multiple captured echoes by
 * then, which is what the golden/replay/aspect tests are meant to exercise
 * (not just the empty-buffer startup state).
 */

async function boot(page: import('@playwright/test').Page, size?: string) {
  await page.goto(`/?test=1&seed=42&scene=whipline${size ?? ''}`)
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

/** Distinct RGB-sum levels present on the canvas (waves.spec.ts's NaN-wash
 * guard: a degenerate all-one-color field collapses this to ~1). */
async function distinctLevelCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas')!
    const gl = canvas.getContext('webgl2')!
    const pixels = new Uint8Array(canvas.width * canvas.height * 4)
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    const levels = new Set<number>()
    for (let i = 0; i < pixels.length; i += 4) levels.add(pixels[i] + pixels[i + 1] + pixels[i + 2])
    return levels.size
  })
}

function minimalDoc(durationFrames: number, seed = 42) {
  return {
    version: 1,
    seed,
    fps: 30,
    scene: { id: 'whipline', params: {} },
    bindings: {},
    audio: { kind: 'demo' },
    durationFrames,
    events: [],
  }
}

// --- Golden: frame 150, default params -------------------------------------

test('whipline renders deterministically at frame 150', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => window.__viz!.renderFrames(150))
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(150)
  await expect(page.locator('canvas')).toHaveScreenshot('whipline-seed42-f150.png')
})

test('whipline canvas is not blank at frame 150', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => window.__viz!.renderFrames(150))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})

// --- Determinism: loadSession re-init, two runs, byte-identical pixelHash --
// (durationFrames=150 crosses several demo-audio beats, so this also proves
// the echo-ring-buffer capture — driven by the one-frame 'beat' pulse — is
// itself replayed identically, not just the continuous physics.)

test('whipline replays byte-identically via loadSession at f150', async ({ page }) => {
  await boot(page)
  const doc = minimalDoc(150)
  const hash1 = await page.evaluate((d) => {
    window.__viz!.loadSession(d)
    window.__viz!.renderFrames(150)
    return window.__viz!.pixelHash()
  }, doc)
  const hash2 = await page.evaluate((d) => {
    window.__viz!.loadSession(d)
    window.__viz!.renderFrames(150)
    return window.__viz!.pixelHash()
  }, doc)
  expect(hash2).toBe(hash1)
})

// --- Aspect-aware composition: golden + non-blank at all three export aspects,
// so the "bounces off the REAL screen edges at 16:9, 9:16, and 1:1" contract
// is checked visually, not just asserted in prose. -------------------------

test('whipline composes correctly at 9:16', async ({ page }) => {
  await boot(page, '&w=360&h=640')
  await page.evaluate(() => window.__viz!.renderFrames(150))
  await expect(page.locator('canvas')).toHaveScreenshot('whipline-9x16-f150.png')
})

test('whipline composes correctly at 1:1', async ({ page }) => {
  await boot(page, '&w=480&h=480')
  await page.evaluate(() => window.__viz!.renderFrames(150))
  await expect(page.locator('canvas')).toHaveScreenshot('whipline-1x1-f150.png')
})

for (const [label, size] of [
  ['16:9', undefined],
  ['9:16', '&w=360&h=640'],
  ['1:1', '&w=480&h=480'],
] as const) {
  test(`whipline canvas is not blank at ${label}`, async ({ page }) => {
    await boot(page, size)
    await page.evaluate(() => window.__viz!.renderFrames(150))
    expect(await litPixelCount(page)).toBeGreaterThan(2000)
  })
}

// --- Extremes: rotSpeed=3, tension=1, bounce=1, drive=1, thickness=3,
// trail=0.995, pulse=1, echoes=16 (every param pushed to its max, the
// combination most likely to blow up a hand-rolled verlet+constraint loop)
// must never destabilize. The fixed per-substep DAMPING plus wall-clamped
// bounce positions are what make this safe regardless of params; this test
// is the executable proof, mirroring waves.spec.ts's extremes test:
// non-blank AND many distinct brightness levels (a NaN/Inf wash collapses to
// ~1 level) AND byte-identical across two independent 300-frame runs (a NaN
// would make IEEE754 comparisons diverge between runs in ways bounded
// arithmetic can't). ----------------------------------------------------

test('whipline stays bounded and finite at extreme params over 300 frames', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => {
    window.__viz!.setParam('rotSpeed', 3)
    window.__viz!.setParam('tension', 1)
    window.__viz!.setParam('bounce', 1)
    window.__viz!.setParam('drive', 1)
    window.__viz!.setParam('thickness', 3)
    window.__viz!.setParam('trail', 0.995)
    window.__viz!.setParam('pulse', 1)
    window.__viz!.setParam('echoes', 16)
  })
  await page.evaluate(() => window.__viz!.renderFrames(300))
  expect(await page.evaluate(() => window.__viz!.frame())).toBe(300)
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
  expect(await distinctLevelCount(page)).toBeGreaterThan(50)

  const hash1 = await page.evaluate(() => window.__viz!.pixelHash())

  await boot(page)
  await page.evaluate(() => {
    window.__viz!.setParam('rotSpeed', 3)
    window.__viz!.setParam('tension', 1)
    window.__viz!.setParam('bounce', 1)
    window.__viz!.setParam('drive', 1)
    window.__viz!.setParam('thickness', 3)
    window.__viz!.setParam('trail', 0.995)
    window.__viz!.setParam('pulse', 1)
    window.__viz!.setParam('echoes', 16)
  })
  await page.evaluate(() => window.__viz!.renderFrames(300))
  const hash2 = await page.evaluate(() => window.__viz!.pixelHash())

  expect(hash2).toBe(hash1)
})

// --- Code layer: 'line-fs' and 'fade-fs' stages are both exposed and
// hot-recompilable, mirroring lissajous.spec-style shader-edit smoke tests
// used elsewhere (e.g. wildcards.spec.ts's morph render-fs test). ----------

test('whipline exposes line-fs and fade-fs; bad GLSL keeps last good program', async ({ page }) => {
  await boot(page)
  const keys = await page.evaluate(() => window.__viz!.getShaderSources().map((s) => s.key))
  expect(keys).toEqual(['line-fs', 'fade-fs'])

  const hashA = await page.evaluate(() => {
    window.__viz!.renderFrames(30)
    return window.__viz!.pixelHash()
  })

  const { err: err1, matched } = await page.evaluate(() => {
    const stage = window.__viz!.getShaderSources().find((s) => s.key === 'line-fs')!
    const edited = stage.source.replace(
      'outColor = vec4(uColor, uAlpha);',
      'outColor = vec4(1.0, 0.0, 0.0, uAlpha);',
    )
    return { err: window.__viz!.setShaderSource('line-fs', edited), matched: edited !== stage.source }
  })
  expect(matched).toBe(true)
  expect(err1).toBeNull()

  const hashB = await page.evaluate(() => {
    window.__viz!.renderFrames(30)
    return window.__viz!.pixelHash()
  })
  expect(hashB).not.toBe(hashA)
  expect(await litPixelCount(page)).toBeGreaterThan(2000)

  const err2 = await page.evaluate(() => window.__viz!.setShaderSource('line-fs', 'void main() { syntax'))
  expect(err2).not.toBeNull()
  expect(err2!.toLowerCase()).toContain('error')

  await page.evaluate(() => window.__viz!.renderFrames(10))
  expect(await litPixelCount(page)).toBeGreaterThan(2000)
})
