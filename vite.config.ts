import './server/env';
import path from 'path';
import { defineConfig, type PreviewServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { getRequestListener } from '@hono/node-server';
import { createRouter } from './server/router';

/**
 * Mounts the same Hono router the production server uses, so development and
 * Cloud Run exercise one implementation rather than two.
 */
const apiPlugin = () => {
  const attach = (server: ViteDevServer | PreviewServer) => {
    const listener = getRequestListener(createRouter().fetch);
    server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith('/api')) return next();
      listener(req, res);
    });
  };
  return { name: 'scholarmind-api', configureServer: attach, configurePreviewServer: attach };
};

export default defineConfig(() => ({
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
  plugins: [react(), apiPlugin()],
  // No `define` for the API key: it is server-side only and must never be
  // inlined into the client bundle.
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
}));
