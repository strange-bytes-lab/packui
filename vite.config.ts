import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// The UI builds to static assets that ship inside the package, which is what
// keeps packui's published `dependencies` empty. Vue and Vite are build-time only.
export default defineConfig({
  root: 'src/ui',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/ui', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    port: 7332,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7331',
        // The API requires a session token. In dev the token comes from
        // scripts/dev.mjs, which starts both this server and the API server.
        headers: process.env.PACKUI_TOKEN
          ? { authorization: `Bearer ${process.env.PACKUI_TOKEN}` }
          : undefined,
      },
    },
  },
})
