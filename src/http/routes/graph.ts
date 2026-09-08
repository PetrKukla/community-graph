import { Hono } from 'hono';
import type { Context } from 'hono';
import { config } from '../../config/config';
import { getGraphStore, isNeo4jConfigured } from '../../adapters/graph';
import { methodNotAllowed } from '../middleware/methodNotAllowed';

export const graphRoute = new Hono();

/** Most graph endpoints need Neo4j; without it the rest of the dashboard still works. */
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

/**
 * Schema + counts for the whole graph: node labels, relationship types, totals and a
 * best-effort "last write" timestamp. Unlike the other graph endpoints this answers 200
 * even when Neo4j is not configured (`{ configured: false }`) so the dashboard can render
 * an empty state without treating it as an error.
 */
graphRoute.get('/graph/meta', (c) => {
  if (!isNeo4jConfigured())
    return c.json({ configured: false, reachable: false });
  return run(c, async () => ({
    configured: true,
    reachable: true,
    ...(await getGraphStore().graphMeta())
  }));
});
graphRoute.all('/graph/meta', methodNotAllowed);

graphRoute.get('/graph/overview', (c) => {
  const blocked = requireNeo4j(c);
  if (blocked) return blocked;
  const channelId = c.req.query('channel_id') || undefined;
  const limit = Number(c.req.query('limit')) || config.web.graph_overview_limit;
  return run(c, () => getGraphStore().graphOverview({ channelId, limit }));
});
graphRoute.all('/graph/overview', methodNotAllowed);

/**
 * Connected subgraph within `depth` (1-2, default 1) hops of one or more seed nodes.
 * `seeds` is a comma-separated list of Neo4j elementIds. Backs "show in graph" from a
 * search hit or a citation.
 */
graphRoute.get('/graph/subgraph', (c) => {
  const blocked = requireNeo4j(c);
  if (blocked) return blocked;
  const seeds = (c.req.query('seeds') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (seeds.length === 0)
    return c.json(
      { error: 'invalid_request', details: 'seeds is required' },
      400
    );
  const depth = Number(c.req.query('depth')) || 1;
  const limit = Number(c.req.query('limit')) || 250;
  return run(c, () => getGraphStore().subgraph(seeds, depth, limit));
});
graphRoute.all('/graph/subgraph', methodNotAllowed);

graphRoute.get('/graph/search', (c) => {
  const blocked = requireNeo4j(c);
  if (blocked) return blocked;
  const q = c.req.query('q') ?? '';
  const limit = Number(c.req.query('limit')) || 20;
  const labels = (c.req.query('labels') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return run(c, async () => {
    const nodes = await getGraphStore().searchNodes(q, { limit, labels });
    const grouped: Record<string, number> = {};
    for (const n of nodes) grouped[n.label] = (grouped[n.label] ?? 0) + 1;
    return { query: q, nodes, grouped, truncated: nodes.length >= limit };
  });
});
graphRoute.all('/graph/search', methodNotAllowed);

/**
 * Domain id -> Neo4j elementId, so a citation can deep-link to /graph?focus=<discussion_id>.
 * Registered before `/graph/node/:id` so the literal path wins over the param.
 */
graphRoute.get('/graph/node/by-domain-id', async (c) => {
  const blocked = requireNeo4j(c);
  if (blocked) return blocked;
  const label = c.req.query('label') ?? '';
  const id = c.req.query('id') ?? '';
  if (!label || !id)
    return c.json(
      { error: 'invalid_request', details: 'label and id are required' },
      400
    );
  try {
    const elementId = await getGraphStore().nodeIdByDomainId(label, id);
    if (!elementId) return c.json({ error: 'not_found' }, 404);
    return c.json({ element_id: elementId });
  } catch (err) {
    return c.json(
      {
        error: 'graph_query_failed',
        message: err instanceof Error ? err.message : String(err)
      },
      502
    );
  }
});
graphRoute.all('/graph/node/by-domain-id', methodNotAllowed);

graphRoute.get('/graph/node/:id/neighbors', (c) => {
  const blocked = requireNeo4j(c);
  if (blocked) return blocked;
  const limit = Number(c.req.query('limit')) || 40;
  return run(c, () => getGraphStore().nodeNeighbors(c.req.param('id'), limit));
});
graphRoute.all('/graph/node/:id/neighbors', methodNotAllowed);

/** One node with its props, degree and adjacent relationship-type counts. `404` if unknown. */
graphRoute.get('/graph/node/:id', async (c) => {
  const blocked = requireNeo4j(c);
  if (blocked) return blocked;
  try {
    const detail = await getGraphStore().nodeDetail(c.req.param('id'));
    if (!detail) return c.json({ error: 'not_found' }, 404);
    return c.json(detail);
  } catch (err) {
    return c.json(
      {
        error: 'graph_query_failed',
        message: err instanceof Error ? err.message : String(err)
      },
      502
    );
  }
});
graphRoute.all('/graph/node/:id', methodNotAllowed);
