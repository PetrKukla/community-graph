import { runMigrations } from "./db/sqlite/client";
import { config } from "./config/config";
import { app } from "./http/app";

runMigrations();

const server = Bun.serve({
  port: config.server.port,
  fetch: app.fetch,
});

console.log(`community-graph listening on http://localhost:${server.port}`);
