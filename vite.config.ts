import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'KNOX Music',
        short_name: 'KNOX',
        description: 'Your music, your device, your control. Local-first music app.',
        theme_color: '#0b0b12',
        background_color: '#0b0b12',
        display: 'standalone',
        start_url: '.',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      // FreeToUse's public API sends no `access-control-allow-origin`, so a
      // direct browser fetch() is always blocked by CORS (search looks
      // "broken" with only partial results). Proxying same-origin avoids
      // CORS entirely in dev. Enable with:
      //   VITE_FREETOUSE_API_BASE_URL=/api/freetouse
      '/api/freetouse': {
        target: 'https://api.freetouse.com/v3',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/freetouse/, ''),
      },
      // Optional same-origin proxies for restrictive networks. Jamendo and
      // Internet Archive already send `access-control-allow-origin: *`, so
      // these are off by default — only set the env vars below to use them.
      '/api/jamendo': {
        target: 'https://api.jamendo.com/v3.0',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/jamendo/, ''),
      },
      '/api/archive': {
        target: 'https://archive.org',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/archive/, ''),
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
  } as never,
});
