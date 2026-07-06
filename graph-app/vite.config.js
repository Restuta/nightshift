// Vite config for the /graph React Flow app — the one sanctioned build step in
// nightshift. base + outDir put the built bundle at public/graph-flow/ where the
// zero-dep server serves it statically; the dist IS committed so a fresh clone
// needs no install. The pure models (reducer.js, graph-model.js, digest.js, …)
// are NOT bundled — the app dynamic-imports them from the server root at runtime
// (see src/models.js), so a merged model fix goes live with zero rebuilds.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Dev-only convenience: proxy the board server's data + runtime-model routes so
// `vite dev` works against a running `node server.js --port 5188`. The build
// output never depends on this.
const BOARD = 'http://localhost:5188';
const proxyPaths = [
  '/events', '/sse', '/sessions', '/whoami', '/style.css',
  '/reducer.js', '/graph-model.js', '/digest.js', '/turn-id.js',
  '/session-label.js', '/session-picker.js', '/story-model.js',
  '/lanes-model.js', '/lanes-scale.js', '/fleet-summary.js',
];

export default defineConfig({
  plugins: [react()],
  base: '/graph-flow/',
  build: {
    outDir: path.resolve(here, '../public/graph-flow'),
    emptyOutDir: true,
    // Stable file names (no content hash): the server sends cache-control:
    // no-store anyway, and a stable name keeps the committed-dist diff minimal.
    rollupOptions: {
      // The pure models are RUNTIME imports from the board server's root —
      // external by design (the whole point: a model fix needs no rebuild).
      external: [
        '/reducer.js', '/graph-model.js', '/digest.js', '/turn-id.js',
        '/session-label.js', '/story-model.js', '/session-picker.js',
      ],
      output: {
        entryFileNames: 'assets/graph-app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/graph-app[extname]',
      },
    },
  },
  server: {
    proxy: Object.fromEntries(proxyPaths.map(p => [p, { target: BOARD }])),
  },
});
