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
    // 默认只监听本机。开发服务器带 /api 代理，连着后端一起，
    // 对外开就把本机的用量数据也一起开出去了。要给局域网看用 --host 0.0.0.0。
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4178',
        changeOrigin: true
      }
    }
  }
});
