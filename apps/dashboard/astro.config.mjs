// Switchboard dashboard: SSR on 127.0.0.1 only. Never deployed (no Netlify).
import node from '@astrojs/node';
import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  server: { host: '127.0.0.1', port: 4321 },
  devToolbar: { enabled: false },
  vite: {
    // Share the core package with the CLI (plain TypeScript, bundled by Vite).
    resolve: { alias: { '@core': fileURLToPath(new URL('../../packages/core', import.meta.url)) } },
    server: { strictPort: true, host: '127.0.0.1' },
  },
});
