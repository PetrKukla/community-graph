import { describe, expect, test } from "bun:test";
import type { EmbeddingProvider } from "../../src/core/ports/EmbeddingProvider";
import type { GraphStore } from "../../src/core/ports/GraphStore";
import type { LLMProvider, LLMStructuredRequest, LLMStructuredResult } from "../../src/core/ports/LLMProvider";
import type { SqliteContextSource } from "../../src/core/query/contextBuilder";
import type { DiscussionCore, DiscussionMatch } from "../../src/core/query/types";
import { answerQuestion, GraphUnavailableError, type QueryDeps } from "../../src/core/query/queryPipeline";

const PLAN = {
  search_queries: ["názory uživatelů na Smarty", "kritika cen Smarty"],
  topics: ["Smarty"],
  entities: ["Smarty"],
  intent: "opinion" as const,
  filter_discussion_types: [],
  filter_since: null,
  filter_usernames: [],
  answer_language: "cs",
};

const ANSWER = {
  answer: "Lidé jsou na Smarty spíš negativní kvůli cenám [D1].",
  used_citations: ["D1"],
  confidence: "high" as const,
  caveats: null,
};

interface LlmScript {
  planCalls: number;
  synthCalls: number;
  failPlanOnce?: boolean;
}

function makeLlm(script: LlmScript): LLMProvider {
  return {
    async generateStructured<T>(req: LLMStructuredRequest<T>): Promise<LLMStructuredResult<T>> {
      if (req.schemaName === "query_plan") {
        script.planCalls++;
        if (script.failPlanOnce && script.planCalls === 1) throw new Error("planner boom");
        return { value: PLAN as unknown as T, raw: JSON.stringify(PLAN) };
      }
      if (req.schemaName === "community_answer") {
        script.synthCalls++;
        return { value: ANSWER as unknown as T, raw: JSON.stringify(ANSWER) };
      }
      throw new Error(`unexpected schema ${req.schemaName}`);
    },
  };
}

const embedder: EmbeddingProvider = {
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array([1, 0, 0]));
  },
};

const sqlite: SqliteContextSource = {
  getEnrichmentBits: () => new Map(),
  getDiscussionMessagesForQuery: () => [],
};

function match(id: string, score: number, sentiment: string): DiscussionMatch {
  return {
    id,
    title: `Diskuze ${id}`,
    summary: `Shrnutí ${id}`,
    channelId: "c1",
    discussionType: "discussion",
    sentiment,
    resolved: null,
    startedAt: null,
    score,
  };
}

function core(id: string, sentiment: string): DiscussionCore {
  return {
    id,
    title: `Diskuze ${id}`,
    summary: `Shrnutí ${id}`,
    topics: ["Smarty"],
    entities: [],
    sentiment,
    discussionType: "discussion",
    resolved: null,
    startedAt: null,
    messageCount: 5,
    participantCount: 2,
    channelId: "c1",
    channelName: "hardware",
    participants: [{ name: "alice", messageCount: 3 }],
  };
}

interface FakeGraphOpts {
  bootstrapThrows?: boolean;
  vectorHits?: DiscussionMatch[];
}

function makeGraph(opts: FakeGraphOpts = {}): GraphStore {
  const g: Partial<GraphStore> = {
    bootstrap: async () => {
      if (opts.bootstrapThrows) throw new Error("connection refused");
    },
    sampleLabelVocab: async () => ({ topics: ["Smarty"], entities: ["Smarty"] }),
    searchDiscussionsByVector: async () => (opts.vectorHits ?? []).map((m) => ({ ...m })),
    getDiscussionsByAnchors: async () => [],
    expandDiscussions: async () => [],
    getDiscussionCores: async (ids: string[]) => {
      const sentiments: Record<string, string> = { d1: "negative", d2: "negative", d3: "positive" };
      return ids.map((id) => core(id, sentiments[id] ?? "neutral"));
    },
  };
  return g as GraphStore;
}

function deps(graph: GraphStore, llm: LLMProvider): QueryDeps {
  return { llm, graph, embedder, sqlite };
}

describe("answerQuestion", () => {
  test("happy path: synthesises an answer with citations from the vector hits", async () => {
    const script: LlmScript = { planCalls: 0, synthCalls: 0 };
    const graph = makeGraph({ vectorHits: [match("d1", 0.82, "negative"), match("d2", 0.55, "negative")] });

    const out = await answerQuestion({ question: "Jaký mají lidé názor na Smarty?", debug: true }, deps(graph, makeLlm(script)));

    expect(script.planCalls).toBe(1);
    expect(script.synthCalls).toBe(1);
    expect(out.answer).toContain("negativní");
    expect(out.confidence).toBe("high");
    expect(out.citations.map((c) => c.discussion_id)).toEqual(["d1", "d2"]);
    expect(out.citations[0]?.used).toBe(true);
    expect(out.citations[1]?.used).toBe(false);
    expect(out.used_discussion_count).toBe(1);
    expect(out.intent).toBe("opinion");
    expect(out.debug?.timings_ms).toBeDefined();
    expect(out.debug?.candidates.length).toBeGreaterThan(0);
  });

  test("no evidence: returns the canned low-confidence answer and never calls the synthesiser", async () => {
    const script: LlmScript = { planCalls: 0, synthCalls: 0 };
    const out = await answerQuestion({ question: "Co si myslí komunita o kávovarech?" }, deps(makeGraph({ vectorHits: [] }), makeLlm(script)));

    expect(script.planCalls).toBe(1);
    expect(script.synthCalls).toBe(0);
    expect(out.confidence).toBe("low");
    expect(out.citations).toHaveLength(0);
    expect(out.answer.toLowerCase()).toContain("nenašel");
  });

  test("graph unreachable: bootstrap failure surfaces as GraphUnavailableError", async () => {
    const script: LlmScript = { planCalls: 0, synthCalls: 0 };
    const call = answerQuestion({ question: "cokoliv a něco navíc" }, deps(makeGraph({ bootstrapThrows: true }), makeLlm(script)));
    await expect(call).rejects.toBeInstanceOf(GraphUnavailableError);
  });

  test("planner failure: falls back to a raw-question plan and still answers", async () => {
    const script: LlmScript = { planCalls: 0, synthCalls: 0, failPlanOnce: true };
    const graph = makeGraph({ vectorHits: [match("d1", 0.9, "negative")] });

    const out = await answerQuestion({ question: "Na Linuxu mi nefunguje zvuk po aktualizaci" }, deps(graph, makeLlm(script)));

    expect(script.synthCalls).toBe(1);
    expect(out.answer).toContain("negativní");
    // one evidence item only -> "high" from the model is clamped down
    expect(out.confidence).toBe("medium");
  });
});
