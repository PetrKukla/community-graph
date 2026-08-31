import { Hono } from 'hono';
import type { Context } from 'hono';
import { config } from '../../config/config';
import { getGraphStore, isNeo4jConfigured } from '../../adapters/graph';
import { methodNotAllowed } from '../middleware/methodNotAllowed';

export const graphRoute = new Hono();

/** All graph endpoints need Neo4j; without it the rest of the dashboard still works. */
function requireNeo4j(c: Context): Response | null {
  if (!isNeo4jConfigured())
    return c.json({ error: 'neo4j_not_configured' }, 503);
  return null;
}

async function run<T>(c: Context, work: () => Promise<T>): Promise<Response> {
  try {
    return c.json((await work()) as Record<string, unknown>);
  } catch (err) {
    return c.json(
      {
        error: 'graph_query_failed',
        message: err instanceof Error ? err.message : String(err)
      },
      502
    );
  }
}

graphRoute.get('/graph/overview', (c) => {
  const blocked = requireNeo4j(c);
  if (blocked) return blocked;
  const channelId = c.req.query('channel_id') || undefined;
  const limit = Number(c.req.query('limit')) || config.web.graph_overview_limit;
  return run(c, () => getGraphStore().graphOverview({ channelId, limit }));
});
graphRoute.all('/graph/overview', methodNotAllowed);

graphRoute.get('/graph/node/:id/neighbors', (c) => {
  const blocked = requireNeo4j(c);
  if (blocked) return blocked;
  const limit = Number(c.req.query('limit')) || 40;
  return run(c, () => getGraphStore().nodeNeighbors(c.req.param('id'), limit));
});
graphRoute.all('/graph/node/:id/neighbors', methodNotAllowed);

graphRoute.get('/graph/search', (c) => {
  const blocked = requireNeo4j(c);
  if (blocked) return blocked;
  const q = c.req.query('q') ?? '';
  return run(c, async () => ({
    nodes: await getGraphStore().searchNodes(q, 20)
  }));
});
graphRoute.all('/graph/search', methodNotAllowed);
