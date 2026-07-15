import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: {
    toHaveScreenshot: {
      // Software rasterizers differ slightly between Chromium builds; goldens
      // guard composition, and a separate non-blank assertion guards regression
      // to black.
      maxDiffPixelRatio: 0.03,
    },
  },
  use: {
    baseURL: 'http://localhost:4173',
    launchOptions: {
      // Force SwiftShader so WebGL2 renders identically on GPU-less CI runners.
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  webServer: {
    command: 'npm run build && npm run preview',
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
