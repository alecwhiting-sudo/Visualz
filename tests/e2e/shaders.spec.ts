import { expect, test } from '@playwright/test'

/**
 * The "code" authoring layer (REQUIREMENTS.md §3.1 layer 3 / ARCHITECTURE.md
 * §3.3): shader stages are hot-recompiled in place; a GLSL error leaves the
 * last good program rendering; edits record and replay deterministically.
 * Never touches the golden-image PNGs in golden.spec.ts.
 */

async function boot(page: import('@playwright/test').Page, query: string) {
  await page.goto(`/?test=1${query}`)
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

test('hot-recompile changes pixels; bad GLSL keeps last good program', async ({ page }) => {
  await boot(page, '&seed=42')

  const hashA = await page.evaluate(() => {
    window.__viz!.renderFrames(30)
    return window.__viz!.pixelHash()
  })

  // Edit line-fs to force pure red, built from the live stock source via text
  // replacement so this stays valid if the shader's exact GLSL evolves.
  const err1 = await page.evaluate(() => {
    const stage = window.__viz!.getShaderSources().find((s) => s.key === 'line-fs')!
    const edited = stage.source.replace('outColor = vec4(uColor, 1.0);', 'outColor = vec4(1.0, 0.0, 0.0, 1.0);')
    return window.__viz!.setShaderSource('line-fs', edited)
  })
  expect(err1).toBeNull()

  const hashB = await page.evaluate(() => {
    window.__viz!.renderFrames(30)
    return window.__viz!.pixelHash()
  })
  expect(hashB).not.toBe(hashA)
  expect(await litPixelCount(page)).toBeGreaterThan(500)

  // Now submit garbage GLSL: setShaderSource must throw (surfaced as a non-null
  // error string) and the previous (red) program must keep rendering.
  const err2 = await page.evaluate(() => window.__viz!.setShaderSource('line-fs', 'void main() { syntax'))
  expect(err2).not.toBeNull()
  expect(err2!.toLowerCase()).toContain('error')

  await page.evaluate(() => window.__viz!.renderFrames(10))
  expect(await litPixelCount(page)).toBeGreaterThan(500)
})

test('shader edits record and replay deterministically', async ({ page }) => {
  await boot(page, '&seed=42')

  const hash1 = await page.evaluate(() => {
    window.__viz!.startRecording()
    window.__viz!.renderFrames(20)
    const stage = window.__viz!.getShaderSources().find((s) => s.key === 'line-fs')!
    const edited = stage.source.replace('outColor = vec4(uColor, 1.0);', 'outColor = vec4(1.0, 0.0, 0.0, 1.0);')
    const err = window.__viz!.setShaderSource('line-fs', edited)
    if (err) throw new Error(`unexpected compile error: ${err}`)
    window.__viz!.renderFrames(40)
    return window.__viz!.pixelHash()
  })

  const hash2 = await page.evaluate(() => {
    const doc = window.__viz!.stopRecording()
    window.__viz!.loadSession(doc)
    window.__viz!.renderFrames(60)
    return window.__viz!.pixelHash()
  })

  expect(hash2).toBe(hash1)
})

test('flowfield update shader is editable', async ({ page }) => {
  await boot(page, '&seed=42&scene=flowfield&count=4096')
  const baselineHash = await page.evaluate(() => {
    window.__viz!.renderFrames(60)
    return window.__viz!.pixelHash()
  })

  // Fresh boot: session-less edit, direct comparison against the baseline run.
  await boot(page, '&seed=42&scene=flowfield&count=4096')
  const { err, matched } = await page.evaluate(() => {
    const stage = window.__viz!.getShaderSources().find((s) => s.key === 'update-fs')!
    // Flip the relative sign between psi()'s two vnoise2 terms — a small,
    // still-valid rotation of the field's maths (this is THE creative surface
    // per the task spec).
    const edited = stage.source.replace('+ 0.5*vnoise2', '- 0.5*vnoise2')
    return { err: window.__viz!.setShaderSource('update-fs', edited), matched: edited !== stage.source }
  })
  expect(matched).toBe(true) // replacement actually matched the live stock source
  expect(err).toBeNull()

  await page.evaluate(() => window.__viz!.renderFrames(60))
  expect(await litPixelCount(page)).toBeGreaterThan(500)
  const editedHash = await page.evaluate(() => window.__viz!.pixelHash())
  expect(editedHash).not.toBe(baselineHash)
})
