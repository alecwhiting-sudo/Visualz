import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // GitHub Pages serves project sites under /<repo>/; the Pages workflow sets
  // VIZ_BASE=/Visualz/. Local dev, preview, and CI tests keep '/'.
  base: process.env.VIZ_BASE ?? '/',
  plugins: [react()],
  server: { port: 5173 },
  preview: { port: 4173 },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
})
