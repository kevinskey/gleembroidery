import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset URLs so a packaged desktop build can load dist/index.html
  // over file:// without the absolute /assets path resolving to disk root.
  base: './',
  plugins: [react()],
})
