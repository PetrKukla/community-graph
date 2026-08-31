import type { EmbeddingProvider } from '../ports/EmbeddingProvider';
import type { GraphStore } from '../ports/GraphStore';
import type { Config } from '../../config/config';
import { cosine } from './scoring';
import type { QueryPlan } from './schemas';
import type {
  DiscussionMatch,
  RetrievalFilters,
  WorkingCandidate
} from './types';

export interface RetrievalResult {
  /** Embedding of the raw question - reused by expansion re-ranking. */
  questionVector: Float32Array;
  /** Merged candidates keyed by discussion id. */
  candidates: Map<string, WorkingCandidate>;
}

function blank(m: DiscussionMatch): WorkingCandidate {
  return {
    id: m.id,
    title: m.title,
    summary: m.summary,
    channelId: m.channelId,
    discussionType: m.discussionType,
    sentiment: m.sentiment,
    resolved: m.resolved,
    startedAt: m.startedAt,
    vecSim: 0,
    anchorHit: false,
    expansionScore: 0,
    via: null,
    sources: new Set()
  };
}

function dedupeQueries(
  question: string,
  extra: string[],
  cap: number
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const q of [question, ...extra]) {
    const t = q.trim();
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= cap + 1) break; // +1 because the raw question always counts as one
  }
  return out;
}

/**
 * Fáze 2 - vector seed search over every rephrasing + lexical anchoring on Topic/Entity names,
 * merged by discussion id. Anchor rows are scored against the question vector so they compete on
 * the same scale as vector hits.
 */
export async function retrieve(
  question: string,
  plan: QueryPlan,
  filters: RetrievalFilters,
  deps: { graph: GraphStore; embedder: EmbeddingProvider },
  cfg: Config['query']
): Promise<RetrievalResult> {
  const queries = dedupeQueries(
    question,
    plan.search_queries,
    cfg.search_query_variants
  );
  const vectors = await deps.embedder.embed(queries);
  const questionVector = vectors[0] ?? new Float32Array();

  const candidates = new Map<string, WorkingCandidate>();
  const touch = (m: DiscussionMatch): WorkingCandidate => {
    let c = candidates.get(m.id);
    if (!c) {
      c = blank(m);
      candidates.set(m.id, c);
    }
    return c;
  };

  // 2a - vector seeds (one search per rephrasing, in parallel)
  const perQuery = await Promise.all(
    vectors.map((v) =>
      v.length > 0
        ? deps.graph.searchDiscussionsByVector(v, cfg.vector_top_k, filters)
        : Promise.resolve([])
    )
  );
  for (const hits of perQuery) {
    for (const m of hits) {
      const c = touch(m);
      c.vecSim = Math.max(c.vecSim, m.score);
      c.sources.add('vector');
    }
  }

  // 2b - lexical anchors on Topic / Entity names
  const anchorHits = await deps.graph.getDiscussionsByAnchors(
    plan.topics,
    plan.entities,
    cfg.anchor_limit,
    filters
  );
  for (const m of anchorHits) {
    const c = touch(m);
    c.anchorHit = true;
    c.sources.add('anchor');
    if (m.embedding && questionVector.length > 0) {
      c.vecSim = Math.max(c.vecSim, cosine(questionVector, m.embedding));
    }
  }

  return { questionVector, candidates };
}
