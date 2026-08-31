import { runMigrations } from "./db/sqlite/client";
import { config } from "./config/config";
import { app } from "./http/app";

runMigrations();

const server = Bun.serve({
  port: config.server.port,
  hostname: config.server.host,
  fetch: app.fetch,
});

console.log(`community-graph listening on http://${server.hostname}:${server.port}`);
