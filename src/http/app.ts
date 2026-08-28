import { Hono } from "hono";
import { apiKeyAuth } from "./middleware/apiKey";
import { healthRoute } from "./routes/health";
import { ingestRoute } from "./routes/ingest";
import { clusterizeRoute } from "./routes/clusterize";
import { jobsRoute } from "./routes/jobs";
import { discussionsRoute } from "./routes/discussions";

export const app = new Hono();

app.route("/", healthRoute);

const api = new Hono();
api.use("*", apiKeyAuth);
api.route("/", ingestRoute);
api.route("/", clusterizeRoute);
api.route("/", jobsRoute);
api.route("/", discussionsRoute);

app.route("/api/v1", api);
