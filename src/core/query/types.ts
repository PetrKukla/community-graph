import type { QueryIntent, QueryPlan } from "./schemas";

/** POST /api/v1/query body, after validation. */
export interface QueryRequest {
  question: string;
  filters?: {
    channelIds?: string[];
    discussionTypes?: string[];
    since?: string; // ISO 8601
  };
  debug?: boolean;
}

/** Retrieval-time filters, after merging the request body with the LLM plan (body wins). */
export interface RetrievalFilters {
  channelIds: string[] | null;
  discussionTypes: string[] | null;
  since: string | null;
}

/** Sampled from the graph and handed to the planner so it proposes labels that actually exist. */
export interface LabelVocab {
  topics: string[];
  entities: string[];
}

/** A Discussion node as returned by the graph read methods. */
export interface DiscussionMatch {
  id: string;
  title: string | null;
  summary: string | null;
  channelId: string | null;
  discussionType: string | null;
  sentiment: string | null;
  resolved: boolean | null;
  startedAt: string | null;
  /** Raw cosine score from the vector index (seeds) or 0 for anchor/expansion rows scored in TS. */
  score: number;
  /** Present on anchor / expansion rows so the pipeline can score them against the question vector. */
  embedding?: number[] | null;
}

export type ExpansionVia = "continuation" | "shared_topic" | "shared_entity" | "cooccurring_topic";

export interface ExpansionMatch extends DiscussionMatch {
  seedId: string;
  via: ExpansionVia;
}

export type CandidateSource = "vector" | "anchor" | "expansion";

/** Mutable accumulator while retrieval + expansion merge their hits by discussion id. */
export interface WorkingCandidate {
  id: string;
  title: string | null;
  summary: string | null;
  channelId: string | null;
  discussionType: string | null;
  sentiment: string | null;
  resolved: boolean | null;
  startedAt: string | null;
  vecSim: number;
  anchorHit: boolean;
  expansionScore: number;
  via: ExpansionVia | null;
  sources: Set<CandidateSource>;
}

/** A discussion in the running for the evidence set, with its score broken down for debug. */
export interface Candidate {
  id: string;
  title: string | null;
  summary: string | null;
  channelId: string | null;
  discussionType: string | null;
  sentiment: string | null;
  resolved: boolean | null;
  startedAt: string | null;
  vecSim: number; // best cosine similarity to any question vector, 0..1
  anchorHit: boolean; // matched a Topic/Entity name from the plan
  expansionScore: number; // 0 if not reached via expansion, else the via-weight
  via: ExpansionVia | null;
  recencyBoost: number; // 0..1
  preferenceBoost: number; // small additive: type preference + resolved-on-troubleshooting
  score: number; // final fused score
  sources: CandidateSource[];
}

/** The core of a discussion pulled from Neo4j for context assembly. */
export interface DiscussionCore {
  id: string;
  title: string | null;
  summary: string | null;
  topics: string[];
  entities: string[];
  sentiment: string | null;
  discussionType: string | null;
  resolved: boolean | null;
  startedAt: string | null;
  messageCount: number | null;
  participantCount: number | null;
  channelId: string | null;
  channelName: string | null;
  participants: Array<{ name: string; messageCount: number | null }>;
}

export interface RawMessage {
  authorLabel: string;
  content: string;
  createdAt: string;
}

/** One evidence item: candidate + graph core + optional SQLite detail, with a stable [D#] ref. */
export interface EvidenceItem {
  ref: string; // "D1", "D2", ...
  candidate: Candidate;
  core: DiscussionCore | null;
  summary: string | null; // from SQLite enrichment, fallback for a missing graph summary
  keyPoints: string[];
  rawMessages: RawMessage[];
}

export interface Citation {
  ref: string;
  discussion_id: string;
  title: string | null;
  channel: string | null;
  discussion_type: string | null;
  sentiment: string | null;
  started_at: string | null;
  score: number;
  used: boolean;
}

export interface QueryAnswer {
  answer: string;
  confidence: "high" | "medium" | "low";
  citations: Citation[];
  used_discussion_count: number;
  intent: QueryIntent;
  answer_language: string;
  debug?: QueryDebug;
}

export interface QueryDebug {
  plan: QueryPlan;
  filters: RetrievalFilters;
  candidates: Array<{
    discussion_id: string;
    score: number;
    vec_sim: number;
    anchor_hit: boolean;
    expansion_score: number;
    sources: string[];
    in_evidence: boolean;
  }>;
  timings_ms: Record<string, number>;
}
