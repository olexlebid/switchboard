// Switchboard dashboard: SSR on 127.0.0.1 only. Never deployed (no Netlify).
import node from '@astrojs/node';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [react()],
  server: { host: '127.0.0.1', port: 4321 },
  devToolbar: { enabled: false },
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        // Share the core package with the CLI (plain TypeScript, bundled by Vite).
        '@core': fileURLToPath(new URL('../../packages/core', import.meta.url)),
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: { strictPort: true, host: '127.0.0.1' },
  },
});
