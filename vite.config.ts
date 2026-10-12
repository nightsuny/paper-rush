import { defineConfig } from 'vite';

// base:'./' 让 build 产物可以直接双击 index.html 离线运行（file:// 或任意静态服务器）。
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4096,
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
});
