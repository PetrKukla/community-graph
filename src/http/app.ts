import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { config } from "../config/config";
import { apiKeyAuth } from "./middleware/apiKey";
import { healthRoute } from "./routes/health";
import { ingestRoute } from "./routes/ingest";
import { clusterizeRoute } from "./routes/clusterize";
import { enrichRoute } from "./routes/enrich";
import { graphWriteRoute } from "./routes/graphWrite";
import { jobsRoute } from "./routes/jobs";
import { discussionsRoute } from "./routes/discussions";
import { enrichmentRoute } from "./routes/enrichment";
import { streamRoute } from "./routes/stream";
import { statsRoute } from "./routes/stats";
import { aiCallsRoute } from "./routes/aiCalls";

export const app = new Hono();

// In dev the frontend is served by Vite on its own port and proxies /api through; the proxy
// keeps same-origin so CORS is only needed for the occasional direct browser call. In prod the
// bundle is served from this same origin, so CORS stays off.
if (process.env.NODE_ENV !== "production") {
  app.use("/api/*", cors({ origin: `http://localhost:${config.web.dev_port}` }));
}

app.route("/", healthRoute);

const api = new Hono();
api.use("*", apiKeyAuth);
api.route("/", ingestRoute);
api.route("/", clusterizeRoute);
api.route("/", enrichRoute);
api.route("/", graphWriteRoute);
api.route("/", jobsRoute);
api.route("/", discussionsRoute);
api.route("/", enrichmentRoute);

// Web-interface read APIs (disabled entirely when [web] enabled = false).
if (config.web.enabled) {
  api.route("/", streamRoute);
  api.route("/", statsRoute);
  api.route("/", aiCallsRoute);
}

app.route("/api/v1", api);

// Static SPA: serve web/dist, falling back to index.html for client-side routes. Registered last
// so it never shadows the API or /health. Disabled entirely when [web] enabled = false.
if (config.web.enabled) {
  app.use("/*", serveStatic({ root: "./web/dist" }));
  app.get("/*", serveStatic({ path: "./web/dist/index.html" }));
}
