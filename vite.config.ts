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
    host: true,
    port: 5173,
    proxy: {
      '/api/jiosaavn-web': {
        target: 'https://www.jiosaavn.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/jiosaavn-web/, ''),
      },
      '/api/spotify-web': {
        target: 'https://open.spotify.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/spotify-web/, ''),
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
