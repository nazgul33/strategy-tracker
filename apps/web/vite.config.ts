import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API does NOT serve this bundle yet: static serving of `apps/web/dist` is
// Task 15. When it lands, the API will know nothing about a base path, so the
// build already uses relative asset URLs. In dev, `/api` is proxied to the API
// process.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:8080', changeOrigin: true } },
  },
});
