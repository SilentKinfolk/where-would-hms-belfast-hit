import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the static build works whether it's served from a domain
  // root or a sub-path (e.g. GitHub Pages project pages).
  base: './',
  server: {
    host: true,
    port: 5173,
    // Forward /api/* to the local describe proxy (optional AI descriptions).
    proxy: {
      '/api': 'http://localhost:8787'
    }
  }
});
