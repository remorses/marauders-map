import { defineConfig } from 'vite'

export default defineConfig({
  build: { target: 'es2022' },
  // dev server next to the CLI (`node server/cli.ts`), which serves /api on 5317
  server: { port: 5316, proxy: { '/api': 'http://localhost:5317' } },
})
