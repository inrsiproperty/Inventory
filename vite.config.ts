import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// BASE_PATH is set by the GitHub Pages workflow to "/<repo-name>/".
// For Azure Static Web Apps or local dev it stays "/".
const base = process.env.BASE_PATH || '/';

export default defineConfig({
  base,
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false, // registered in src/main.tsx
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Inventory App',
        short_name: 'Inventory',
        description: 'Photo-evidenced property inventories, saved to your OneDrive.',
        theme_color: '#1d4ed8',
        background_color: '#0b1220',
        display: 'standalone',
        orientation: 'portrait',
        start_url: base,
        scope: base,
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // New versions take over straight away instead of waiting for every tab to close.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // Cache the whole app shell so it opens with no signal.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        navigateFallback: 'index.html',
        // Never cache Microsoft sign-in or Graph calls.
        navigateFallbackDenylist: [/^\/\.auth/],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
    }),
  ],
  build: {
    target: 'es2020',
    sourcemap: false,
  },
});
