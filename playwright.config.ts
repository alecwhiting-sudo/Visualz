import { defineConfig } from '@playwright/test'

const CI = !!process.env.CI

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  // CI runners rasterize all WebGL on SwiftShader (pure CPU) on ~4 vCPUs;
  // two parallel workers starved each other (and the shared GPU process) so
  // badly that screenshot stability waits and heavy replay evaluates flaked
  // by timeout. Serial is slower in wall-clock but stable — the accepted
  // trade. Local runs keep Playwright's default parallelism.
  workers: CI ? 1 : undefined,
  expect: {
    // On CI, capturing/compositing a SwiftShader canvas plus app re-renders
    // under load routinely outlast the 5s default; 15s is headroom, not a
    // correctness change (assertions still fail fast on real mismatches once
    // the shot is taken).
    timeout: CI ? 15_000 : 5_000,
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
