import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../../db/sqlite/client';
import { getGraphStore, isNeo4jConfigured } from '../../adapters/graph';
import { methodNotAllowed } from '../middleware/methodNotAllowed';

export const healthRoute = new Hono();

healthRoute.get('/health', async (c) => {
  let sqliteStatus: string;
  try {
    db.run(sql`select 1`);
    sqliteStatus = 'ok';
  } catch (err) {
    sqliteStatus = err instanceof Error ? err.message : String(err);
  }

  let neo4jStatus: string;
  if (!isNeo4jConfigured()) {
    neo4jStatus = 'not_configured';
  } else {
    try {
      await getGraphStore().verifyConnectivity();
      neo4jStatus = 'ok';
    } catch (err) {
      neo4jStatus = err instanceof Error ? err.message : String(err);
    }
  }

  // only SQLite is required for steps 1-2; Neo4j is informational until you run graph-write
  const healthy = sqliteStatus === 'ok';
  return c.json(
    {
      status: healthy ? 'ok' : 'error',
      sqlite: sqliteStatus,
      neo4j: neo4jStatus
    },
    healthy ? 200 : 503
  );
});

healthRoute.all('/health', methodNotAllowed);
