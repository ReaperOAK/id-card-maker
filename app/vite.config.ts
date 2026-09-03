import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@engine': fileURLToPath(new URL('../src', import.meta.url)) } },
  // mupdf ships WASM and must not be pre-bundled by esbuild.
  optimizeDeps: { exclude: ['mupdf'] },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  test: { environment: 'jsdom', include: ['test/**/*.test.ts', 'test/**/*.test.tsx'] },
})
