import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API serves this bundle from `apps/web/dist` (see apps/server/src/main.ts)
// with an SPA fallback for deep links. The API knows nothing about a base path,
// so the build uses relative asset URLs. In dev, `/api` is proxied to the API
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
