import { runMigrations } from './db/sqlite/client';
import { env } from './config/env';
import { app } from './http/app';
import { websocket } from './http/ws';
import { recoverInterruptedJobs } from './jobs/recovery';

runMigrations();

const server = Bun.serve({
  port: env.SERVER_PORT,
  hostname: env.SERVER_HOST,
  fetch: app.fetch,
  websocket
});

console.log(
  `community-graph listening on http://${server.hostname}:${server.port}`
);

// Re-dispatch jobs a previous process left running/pending (stages are idempotent).
recoverInterruptedJobs();
