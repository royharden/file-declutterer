import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Web build only. The CLI (cli/) and the inactive legacy sources (src/engine, supabase)
// are never part of the browser import graph.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: true },
})
