import type { GraphStore } from '../../core/ports/GraphStore';
import { Neo4jGraphStore } from './Neo4jGraphStore';
import { getNeo4jDriver } from './driver';

let cached: GraphStore | null = null;

/** Returns the graph store (Neo4j), constructed once per process. Throws if Neo4j is not configured. */
export function getGraphStore(): GraphStore {
  cached ??= new Neo4jGraphStore(getNeo4jDriver());
  return cached;
}

export { isNeo4jConfigured, closeNeo4jDriver } from './driver';
