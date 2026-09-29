import react from '@vitejs/plugin-react'
import { loadEnv } from 'vite'
// defineConfig from vitest/config, not vite: the Vitest-aware variant knows
// about the `test` key, and `tsc -b` rejects the vite one during a build.
import { defineConfig } from 'vitest/config'

export default defineConfig(({ mode }) => {
  // A production bundle carries the workspace token it will send. Without
  // VITE_WORKSPACE_TOKEN the client would fall back to the dev token and
  // every save would fail with 401 at runtime, silently to whoever deployed
  // it. Refuse at build time instead. Dev and test keep the dev default.
  if (mode === 'production' && !loadEnv(mode, process.cwd(), 'VITE_').VITE_WORKSPACE_TOKEN) {
    throw new Error('VITE_WORKSPACE_TOKEN is not set: a production build needs the token the API expects')
  }
  return {
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
      // Vitest's 5000ms default is tight for tests that parse real PDFs with
      // pdf.js: fine in isolation, but under parallel workers on a loaded
      // machine several of them can queue behind each other and blow the
      // default. Room to breathe under contention, not a longer-running suite.
      testTimeout: 30000,
      alias: {
        // TESTS ONLY. pdf.js's default build reaches for DOMMatrix at import
        // time, which Node does not have; the legacy build is the one pdf.js
        // ships for non-browser environments.
        'pdfjs-dist': 'pdfjs-dist/legacy/build/pdf.mjs',
      },
    },
  }
})
