import type { EmbeddingProvider } from "../ports/EmbeddingProvider";
import type { GraphStore } from "../ports/GraphStore";
import type { LLMProvider } from "../ports/LLMProvider";
import { config } from "../../config/config";
import { buildContext, type SqliteContextSource } from "./contextBuilder";
import { expand } from "./graphExpander";
import { fallbackPlan, planQuery } from "./queryPlanner";
import { rankCandidates } from "./ranker";
import { retrieve } from "./retriever";
import { synthesizeAnswer } from "./answerSynthesizer";
import type { QueryPlan } from "./schemas";
import type {
  Candidate,
  Citation,
  EvidenceItem,
  QueryAnswer,
  QueryDebug,
  QueryRequest,
  RetrievalFilters,
} from "./types";

export interface QueryDeps {
  llm: LLMProvider;
  graph: GraphStore;
  embedder: EmbeddingProvider;
  /** SQLite reads for context assembly - real repo in the route, a fake in tests. */
  sqlite: SqliteContextSource;
}

/** Thrown when the graph store is unreachable - the route maps this to 503. */
export class GraphUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphUnavailableError";
  }
}

/**
 * Hard retrieval filters come ONLY from the request body - the user's explicit scope. Anything the
 * planner infers (discussion type, ...) is a soft ranking signal handled in the ranker, never a
 * WHERE clause, so a wrong guess can't zero out recall.
 */
function requestFilters(req: QueryRequest): RetrievalFilters {
  const types = req.filters?.discussionTypes?.filter(Boolean) ?? [];
  const channels = req.filters?.channelIds?.filter(Boolean) ?? [];
  return {
    channelIds: channels.length > 0 ? channels : null,
    discussionTypes: types.length > 0 ? types : null,
    since: req.filters?.since ?? null,
  };
}

/** "D1", "[D3]", "d2,d4" -> Set{"D1","D3","D2","D4"} */
function parseUsedRefs(raw: string[]): Set<string> {
  const out = new Set<string>();
  for (const entry of raw) {
    for (const m of entry.toUpperCase().matchAll(/D\d+/g)) out.add(m[0]);
  }
  return out;
}

function noEvidenceText(lang: string): string {
  return lang.toLowerCase().startsWith("en")
    ? "I couldn't find enough in the community's history to answer this reliably."
    : "V historii komunity jsem k tvojí otázce nenašel dost podkladů, abych mohl spolehlivě odpovědět.";
}

function toCitations(items: EvidenceItem[], used: Set<string>): Citation[] {
  return items.map((it) => ({
    ref: it.ref,
    discussion_id: it.candidate.id,
    title: it.core?.title ?? it.candidate.title,
    channel: it.core?.channelName ?? null,
    discussion_type: it.core?.discussionType ?? it.candidate.discussionType,
    sentiment: it.core?.sentiment ?? it.candidate.sentiment,
    started_at: it.core?.startedAt ?? it.candidate.startedAt,
    score: Number(it.candidate.score.toFixed(4)),
    used: used.size === 0 ? true : used.has(it.ref),
  }));
}

function buildDebug(
  plan: QueryPlan,
  filters: RetrievalFilters,
  ranked: Candidate[],
  evidenceIds: Set<string>,
  timings: Record<string, number>,
): QueryDebug {
  return {
    plan,
    filters,
    candidates: ranked.slice(0, 40).map((c) => ({
      discussion_id: c.id,
      score: Number(c.score.toFixed(4)),
      vec_sim: Number(c.vecSim.toFixed(4)),
      anchor_hit: c.anchorHit,
      expansion_score: Number(c.expansionScore.toFixed(4)),
      sources: c.sources,
      in_evidence: evidenceIds.has(c.id),
    })),
    timings_ms: timings,
  };
}

/**
 * The full querying pipeline: plan -> retrieve -> expand -> rank -> context -> synthesize.
 * Two LLM calls (planner + synthesizer), both through the injected LLMProvider.
 */
export async function answerQuestion(req: QueryRequest, deps: QueryDeps): Promise<QueryAnswer> {
  const cfg = config.query;
  const timings: Record<string, number> = {};
  const clock = <T>(name: string, p: Promise<T>): Promise<T> => {
    const t0 = performance.now();
    return p.finally(() => {
      timings[name] = Math.round(performance.now() - t0);
    });
  };

  // ensure vector + fulltext indexes exist; this is also our "is Neo4j up?" probe
  try {
    await deps.graph.bootstrap();
  } catch (err) {
    throw new GraphUnavailableError(err instanceof Error ? err.message : String(err));
  }

  const vocab = await deps.graph.sampleLabelVocab(cfg.vocab_sample_size).catch(() => ({ topics: [], entities: [] }));

  let plan: QueryPlan;
  try {
    plan = await clock("plan", planQuery(req.question, deps.llm, vocab));
  } catch (err) {
    console.error(`[query] planner failed, using fallback: ${err instanceof Error ? err.message : String(err)}`);
    plan = fallbackPlan(req.question);
    timings["plan"] = timings["plan"] ?? 0;
  }

  const runRetrieval = async (f: RetrievalFilters, suffix: string) => {
    const { questionVector, candidates } = await clock(`retrieve${suffix}`, retrieve(req.question, plan, f, deps, cfg));
    await clock(`expand${suffix}`, expand(candidates, questionVector, deps, cfg));
    return rankCandidates(candidates, plan, cfg);
  };

  let filters = requestFilters(req);
  let { ranked, evidence } = await runRetrieval(filters, "");
  let relaxedNote: string | null = null;

  // A request-body type/date filter that returns nothing gets one relaxed retry (channels kept)
  // so an over-tight user scope degrades to a noted best-effort answer, not a silent blank.
  if (evidence.length === 0 && (filters.discussionTypes || filters.since)) {
    const relaxed: RetrievalFilters = { channelIds: filters.channelIds, discussionTypes: null, since: null };
    const retry = await runRetrieval(relaxed, "-relaxed");
    if (retry.evidence.length > 0) {
      ({ ranked, evidence } = retry);
      filters = relaxed;
      relaxedNote =
        "Zadaný filtr (typ diskuze nebo datum) nic nevrátil – odpověď je z nejbližších odpovídajících diskuzí mimo něj.";
    }
  }

  const evidenceIds = new Set(evidence.map((c) => c.id));

  if (evidence.length === 0) {
    const answer: QueryAnswer = {
      answer: noEvidenceText(plan.answer_language),
      confidence: "low",
      citations: [],
      used_discussion_count: 0,
      intent: plan.intent,
      answer_language: plan.answer_language,
    };
    if (req.debug) answer.debug = buildDebug(plan, filters, ranked, evidenceIds, timings);
    return answer;
  }

  const { contextText, items } = await clock("context", buildContext(evidence, deps, cfg));
  const draft = await clock("synthesize", synthesizeAnswer(req.question, plan, contextText, deps.llm));

  const used = parseUsedRefs(draft.used_citations);
  const citations = toCitations(items, used);
  const usedCount = citations.filter((c) => c.used).length || items.length;

  let confidence = draft.confidence;
  if (confidence === "high" && items.length < 2) confidence = "medium";
  if (relaxedNote && confidence === "high") confidence = "medium";

  const notes = [relaxedNote, draft.caveats].filter((s): s is string => Boolean(s));

  const answer: QueryAnswer = {
    answer: notes.length > 0 ? `${draft.answer}\n\n_Poznámka: ${notes.join(" ")}_` : draft.answer,
    confidence,
    citations,
    used_discussion_count: usedCount,
    intent: plan.intent,
    answer_language: plan.answer_language,
  };
  if (req.debug) answer.debug = buildDebug(plan, filters, ranked, evidenceIds, timings);
  return answer;
}
