import './env';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createRouter } from './router';

const app = new Hono();

app.route('/', createRouter());

// Built SPA assets, with an index.html fallback so client routes resolve.
app.use('/*', serveStatic({ root: './dist' }));
app.get('*', serveStatic({ path: './dist/index.html' }));

const port = Number(process.env.PORT) || 8080;
serve({ fetch: app.fetch, port }, info => {
  console.log(`ScholarMind server listening on :${info.port}`);
});
