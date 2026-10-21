import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 构建产物给 server 直接托管；开发时把 /api 代理到本地服务。
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4178',
        changeOrigin: true
      }
    }
  }
});
