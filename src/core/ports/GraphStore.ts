import type { DiscussionGraphPayload } from "../graphBuilder/types";

/** One node in a graph view sent to the dashboard. `id` is Neo4j's stable elementId. */
export interface GraphViewNode {
  id: string;
  label: string; // primary Neo4j label: User | Channel | Discussion | Topic | Entity
  caption: string; // human-readable text for the node
  props: Record<string, unknown>;
  degree: number; // total degree in the graph (not just within this view)
}

export interface GraphViewEdge {
  id: string;
  source: string;
  target: string;
  type: string; // relationship type
  props: Record<string, unknown>;
}

export interface GraphView {
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
}

export interface GraphOverviewOptions {
  channelId?: string;
  /** Target upper bound on node count for the first render. */
  limit: number;
}

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

  // --- read-only views for the dashboard ------------------------------------

  /** A sampled subgraph around the most recent discussions, for the first render. */
  graphOverview(options: GraphOverviewOptions): Promise<GraphView>;
  /** Immediate neighbourhood of one node, for expand-on-click. */
  nodeNeighbors(id: string, limit: number): Promise<GraphView>;
  /** Candidate nodes matching a free-text query (Topic/Entity name, Discussion title, username). */
  searchNodes(query: string, limit: number): Promise<GraphViewNode[]>;
}
