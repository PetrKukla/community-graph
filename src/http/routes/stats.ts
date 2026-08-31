import { Hono } from 'hono';
import { computeFullStats } from '../../db/sqlite/repositories/statsRepository';
import { methodNotAllowed } from '../middleware/methodNotAllowed';

export const statsRoute = new Hono();

// Dashboard aggregates. Purely SQLite - works without Neo4j (topic/entity totals come from the
// enrichment JSON, not the graph). Clients cache this with TanStack Query + a staleTime.
statsRoute.get('/stats', (c) => c.json(computeFullStats()));

statsRoute.all('/stats', methodNotAllowed);
