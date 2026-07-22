import { chromium } from 'playwright'

const frame = Number(process.argv[2] ?? 200)
const out = process.argv[3] ?? '/tmp/claude-0/-home-user-Visualz/a902492a-cffa-514f-a0d9-c19a624f0f99/scratchpad/whipline_tune.png'
const size = process.argv[4] ?? ''
const params = process.argv[5] ? JSON.parse(process.argv[5]) : {}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage()
await page.goto(`http://localhost:4173/?test=1&seed=42&scene=whipline${size}`)
await page.waitForFunction(() => window.__viz !== undefined)
await page.evaluate((p) => {
  for (const [k, v] of Object.entries(p)) window.__viz.setParam(k, v)
}, params)
await page.evaluate((n) => window.__viz.renderFrames(n), frame)
await page.locator('canvas').screenshot({ path: out })
await browser.close()
console.log('saved', out, 'at frame', frame)
