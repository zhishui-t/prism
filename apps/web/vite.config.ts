import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * 开发期把 /api 与 /studio 代理到 Prism server（默认 7777），
 * 避免 CORS 并让前端只依赖相对路径。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7777', changeOrigin: true },
      '/studio': { target: 'http://127.0.0.1:7777', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
})
