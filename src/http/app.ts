import { Hono } from "hono";
import { apiKeyAuth } from "./middleware/apiKey";
import { healthRoute } from "./routes/health";
import { ingestRoute } from "./routes/ingest";
import { clusterizeRoute } from "./routes/clusterize";
import { enrichRoute } from "./routes/enrich";
import { graphWriteRoute } from "./routes/graphWrite";
import { jobsRoute } from "./routes/jobs";
import { discussionsRoute } from "./routes/discussions";
import { enrichmentRoute } from "./routes/enrichment";

export const app = new Hono();

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

app.route("/api/v1", api);
