import react from '@vitejs/plugin-react'
// defineConfig from vitest/config, not vite: the Vitest-aware variant knows
// about the `test` key, and `tsc -b` rejects the vite one during a build.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    // The API runs on :8000 in dev; the browser talks to /api on the same
    // origin so no CORS story is needed anywhere.
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
  test: {
    environment: 'node', // domain layer is pure TS, no DOM needed
    include: ['tests/**/*.test.ts'],
    alias: {
      // TESTS ONLY. pdf.js's default build reaches for DOMMatrix at import
      // time, which Node does not have; the legacy build is the one pdf.js
      // ships for non-browser environments.
      'pdfjs-dist': 'pdfjs-dist/legacy/build/pdf.mjs',
    },
  },
})
