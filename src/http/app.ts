import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from 'hono/bun';
import { config } from '../config/config';
import { env } from '../config/env';
import { apiKeyAuth } from './middleware/apiKey';
import { embedHeaders } from './middleware/embed';
import { healthRoute } from './routes/health';
import { ingestRoute } from './routes/ingest';
import { dictionaryRoute } from './routes/dictionary';
import { pipelineRoute } from './routes/pipeline';
import { clusterizeRoute } from './routes/clusterize';
import { enrichRoute } from './routes/enrich';
import { graphWriteRoute } from './routes/graphWrite';
import { jobsRoute } from './routes/jobs';
import { discussionsRoute } from './routes/discussions';
import { enrichmentRoute } from './routes/enrichment';
import { queryRoute } from './routes/query';
import { streamRoute } from './routes/stream';
import { statsRoute } from './routes/stats';
import { aiCallsRoute } from './routes/aiCalls';
import { graphRoute } from './routes/graph';
import { webAskRoute } from './routes/webAsk';

export const app = new Hono();

// Allow an approved dashboard to frame the SPA (frame-ancestors CSP). Runs on every
// response; no-op unless WEB_EMBED_ORIGINS is set. See COMMUNITY_GRAPH_INTEGRATION.md.
app.use('*', embedHeaders);

// CORS for /api/*: the Vite dev server (dev only) plus any WEB_EMBED_ORIGINS. A
// server-side proxy on the dashboard needs none of this, but a browser that calls the
// API directly (dev, or an embedded page fetching cross-origin) does. In prod the bundle
// is served from this same origin, so with no embed origins configured CORS stays off.
const corsOrigins = [
  ...(process.env.NODE_ENV !== 'production'
    ? [`http://localhost:${config.web.dev_port}`]
    : []),
  ...env.WEB_EMBED_ORIGINS
];
if (corsOrigins.length > 0) {
  app.use('/api/*', cors({ origin: corsOrigins }));
}

app.route('/', healthRoute);

const api = new Hono();
api.use('*', apiKeyAuth);
api.route('/', ingestRoute);
api.route('/', dictionaryRoute);
api.route('/', pipelineRoute);
api.route('/', clusterizeRoute);
api.route('/', enrichRoute);
api.route('/', graphWriteRoute);
api.route('/', jobsRoute);
api.route('/', discussionsRoute);
api.route('/', enrichmentRoute);
api.route('/', queryRoute);

// Web-interface read APIs (disabled entirely when [web] enabled = false).
if (config.web.enabled) {
  api.route('/', streamRoute);
  api.route('/', statsRoute);
  api.route('/', aiCallsRoute);
  api.route('/', graphRoute);
  api.route('/', webAskRoute);
}

app.route('/api/v1', api);

// Static SPA: serve web/dist, falling back to index.html for client-side routes. Registered last
// so it never shadows the API or /health. Disabled entirely when [web] enabled = false.
if (config.web.enabled) {
  app.use('/*', serveStatic({ root: './web/dist' }));
  app.get('/*', serveStatic({ path: './web/dist/index.html' }));
}
