import type { DiscussionGraphPayload } from "../graphBuilder/types";
import type {
  DiscussionCore,
  DiscussionMatch,
  ExpansionMatch,
  LabelVocab,
  RetrievalFilters,
} from "../query/types";

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

/** Name changes to push onto nodes that already exist in the graph (Část 4.1). */
export interface DictionaryNames {
  guilds?: { id: string; name: string | null }[];
  channels?: { id: string; name: string | null }[];
  users?: { id: string; username: string | null; displayName: string | null }[];
}

/**
 * Hexagonal boundary for the graph store (Neo4j today). Core code depends only on this port.
 * Every write must be idempotent at the payload granularity - the caller guarantees a given
 * discussion is handed over at most once (SQLite status flips to 'written' afterwards), so the
 * implementation may use plain counters in MERGE ... ON MATCH.
 */
export interface GraphStore {
  /** Create constraints, the discussion vector index and the label fulltext index if missing. Safe to call repeatedly. */
  bootstrap(): Promise<void>;
  /** Write one enriched discussion and all its nodes/edges in a single transaction. */
  writeDiscussion(payload: DiscussionGraphPayload): Promise<void>;
  /**
   * Update name properties on EXISTING User / Channel / Guild nodes (MATCH ... SET, never MERGE).
   * Nodes not yet in the graph are left alone - they get their name at graph-write time.
   * Returns how many nodes were actually touched.
   */
  syncDictionaryNames(names: DictionaryNames): Promise<{ updatedNodes: number }>;
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

  // --- read-only retrieval for querying (Část 3) ---------------------------

  /** Most-referenced Topic / Entity names, handed to the query planner as the graph's vocabulary. */
  sampleLabelVocab(limit: number): Promise<LabelVocab>;
  /** ANN search over the discussion vector index; `score` is cosine similarity 0..1. */
  searchDiscussionsByVector(vector: Float32Array, k: number, filters: RetrievalFilters): Promise<DiscussionMatch[]>;
  /** Discussions reached from Topic / Entity nodes whose name matches the plan (fulltext). Rows carry `embedding`. */
  getDiscussionsByAnchors(
    topics: string[],
    entities: string[],
    limit: number,
    filters: RetrievalFilters,
  ): Promise<DiscussionMatch[]>;
  /** One hop out of the seed discussions along meaningful edges. Rows carry `embedding` for TS re-ranking. */
  expandDiscussions(seedIds: string[], totalLimit: number): Promise<ExpansionMatch[]>;
  /** Everything context assembly needs about a set of discussions: channel, participants, entities, scalars. */
  getDiscussionCores(ids: string[]): Promise<DiscussionCore[]>;
}
