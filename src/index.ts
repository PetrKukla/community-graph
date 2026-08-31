import { runMigrations } from "./db/sqlite/client";
import { config } from "./config/config";
import { app } from "./http/app";
import { websocket } from "./http/ws";

runMigrations();

const server = Bun.serve({
  port: config.server.port,
  hostname: config.server.host,
  fetch: app.fetch,
  websocket,
});

console.log(`community-graph listening on http://${server.hostname}:${server.port}`);
