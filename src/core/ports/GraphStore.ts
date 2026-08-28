import type { DiscussionGraphPayload } from "../graphBuilder/types";

/**
 * Hexagonal boundary for the graph store (Neo4j today). Core code depends only on this port.
 * Every write must be idempotent at the payload granularity - the caller guarantees a given
 * discussion is handed over at most once (SQLite status flips to 'written' afterwards), so the
 * implementation may use plain counters in MERGE ... ON MATCH.
 */
export interface GraphStore {
  /** Create constraints and the discussion vector index if missing. Safe to call repeatedly. */
  bootstrap(): Promise<void>;
  /** Write one enriched discussion and all its nodes/edges in a single transaction. */
  writeDiscussion(payload: DiscussionGraphPayload): Promise<void>;
  /** Throws if the store is unreachable. */
  verifyConnectivity(): Promise<void>;
  close(): Promise<void>;
}
