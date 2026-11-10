import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  server: {
    // 本地开发时把 /api 转发到 wrangler dev（默认 8787 端口）
    proxy: { '/api': 'http://localhost:8787' },
  },
});
