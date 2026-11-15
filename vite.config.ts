import { execSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * The build's commit, shown in the interface.
 *
 * Without it there is no way to tell from a screenshot which build someone
 * is looking at — and a stale page looks exactly like a feature that was
 * never shipped. That cost several round trips of "it isn't there" against
 * builds where it was.
 */
const BUILD = (() => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'dev'
  }
})()

export default defineConfig({
  // Relative asset URLs so a packaged desktop build can load dist/index.html
  // over file:// without the absolute /assets path resolving to disk root.
  base: './',
  define: { __BUILD__: JSON.stringify(BUILD) },
  plugins: [react()],
})
