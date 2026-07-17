import { expect, test } from '@playwright/test'

/**
 * CODE tab task: the "What does this code do?" disclosure above the shader
 * editor — a plain-language summary + "Things to try" list for the current
 * scene+stage, sourced from `src/scenes/shaderDocs.ts` (verified against the
 * live stock GLSL in tests/unit/shaderDocs.test.ts). Real-app coverage (no
 * `?test=1` harness — see transport-ui.spec.ts for why): the CODE tab only
 * exists in the real App shell.
 */

test('CODE tab shows a closed-by-default disclosure that opens with the summary, try-list, and safety line', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.locator('.panel')).toBeVisible()

  await page.getByRole('tab', { name: 'CODE' }).click()
  const disclosureButton = page.getByRole('button', { name: 'What does this code do?' })
  await expect(disclosureButton).toBeVisible()
  await expect(disclosureButton).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.shader-docs-content')).toHaveCount(0)

  await disclosureButton.click()
  await expect(disclosureButton).toHaveAttribute('aria-expanded', 'true')
  const content = page.locator('.shader-docs-content')
  await expect(content).toBeVisible()
  // Default scene (lissajous) defaults to its first stage (line-fs).
  await expect(content).toContainText('Lissajous curve is drawn')
  await expect(content).toContainText('Things to try')
  await expect(content.locator('code').first()).toBeVisible()
  await expect(content).toContainText("You can't break anything")
})

test('disclosure content switches with the stage selector', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('tab', { name: 'CODE' }).click()
  await page.getByRole('button', { name: 'What does this code do?' }).click()

  const content = page.locator('.shader-docs-content')
  await expect(content).toContainText('Lissajous curve is drawn')

  const stageSelect = page.locator('.scene-select', { hasText: 'Stage' }).locator('select')
  await stageSelect.selectOption('fade-fs')

  await expect(content).toContainText("doesn't draw the curve at all")
  await expect(content).not.toContainText('Lissajous curve is drawn')
})

test('disclosure hides entirely for a scene with no SHADER_DOCS entry (a blend-* composite)', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.panel')).toBeVisible()

  const sceneSelect = page.locator('.scene-select', { hasText: 'Scene' }).locator('select')
  await sceneSelect.selectOption('blend-julia-flow')

  await page.getByRole('tab', { name: 'CODE' }).click()
  // The editor itself still renders (the composite has shader stages) — only
  // the disclosure is absent.
  await expect(page.locator('.shader-editor')).toBeVisible()
  await expect(page.getByRole('button', { name: 'What does this code do?' })).toHaveCount(0)
})

test('disclosure survives a scene switch: switching to Julia shows Julia\'s own doc', async ({ page }) => {
  await page.goto('/')
  const sceneSelect = page.locator('.scene-select', { hasText: 'Scene' }).locator('select')
  await sceneSelect.selectOption('julia')

  await page.getByRole('tab', { name: 'CODE' }).click()
  const disclosureButton = page.getByRole('button', { name: 'What does this code do?' })
  await expect(disclosureButton).toBeVisible()
  await disclosureButton.click()
  await expect(page.locator('.shader-docs-content')).toContainText('Julia sets are drawn')
})
