import type { EmbeddingProvider } from "../ports/EmbeddingProvider";
import type { LLMProvider } from "../ports/LLMProvider";
import { ENRICHMENT_SYSTEM_PROMPT, buildEnrichmentUserPrompt } from "./prompt";
import { enrichmentResponseSchema, type EnrichmentSegmentRaw } from "./schemas";
import type { DiscussionEnrichment, EnrichableMessage, EnrichmentOutcome, EnrichmentSegment } from "./types";

export interface EnrichDiscussionParams {
  discussionId: string; // for logging only
  messages: EnrichableMessage[]; // chronological
  llm: LLMProvider;
  embeddingProvider: EmbeddingProvider;
  maxMessagesPerCall: number;
}

export interface EnrichDiscussionResult {
  outcome: EnrichmentOutcome;
  raw: string;
}

function toDomainEnrichment(seg: EnrichmentSegmentRaw): DiscussionEnrichment {
  return {
    title: seg.title,
    summary: seg.summary,
    topics: seg.topics,
    entities: seg.entities,
    keyPoints: seg.key_points,
    sentiment: seg.sentiment,
    sentimentScore: seg.sentiment_score,
    language: seg.language,
    discussionType: seg.discussion_type,
    resolved: seg.resolved,
  };
}

function embeddingText(e: DiscussionEnrichment): string {
  return [e.title, e.summary, e.topics.join(", ")].map((s) => s.trim()).filter(Boolean).join(". ");
}

/**
 * Assigns every message to exactly one of the LLM's segments.
 * - honour the message_ids the LLM gave (first segment wins on a duplicate id)
 * - a message the LLM forgot goes to the segment of the chronologically nearest assigned message
 * - if the LLM gave no usable ids at all, fall back to contiguous chronological chunks
 */
function partitionMessages(messages: EnrichableMessage[], segments: EnrichmentSegmentRaw[]): EnrichableMessage[][] {
  const known = new Set(messages.map((m) => m.id));
  const segIndexById = new Map<string, number>();
  segments.forEach((seg, i) => {
    for (const id of seg.message_ids) {
      if (known.has(id) && !segIndexById.has(id)) segIndexById.set(id, i);
    }
  });

  const buckets: EnrichableMessage[][] = segments.map(() => []);

  if (segIndexById.size === 0) {
    const perChunk = Math.max(1, Math.ceil(messages.length / segments.length));
    messages.forEach((m, i) => {
      const idx = Math.min(segments.length - 1, Math.floor(i / perChunk));
      (buckets[idx] as EnrichableMessage[]).push(m);
    });
    return buckets;
  }

  const assigned = messages.filter((m) => segIndexById.has(m.id));
  for (const m of messages) {
    let idx = segIndexById.get(m.id);
    if (idx === undefined) {
      const t = Date.parse(m.createdAt);
      let bestDist = Number.POSITIVE_INFINITY;
      idx = segIndexById.get(assigned[0]!.id)!;
      for (const a of assigned) {
        const d = Math.abs(Date.parse(a.createdAt) - t);
        if (d < bestDist) {
          bestDist = d;
          idx = segIndexById.get(a.id)!;
        }
      }
    }
    (buckets[idx] as EnrichableMessage[]).push(m);
  }
  return buckets;
}

async function embed(provider: EmbeddingProvider, texts: string[]): Promise<(Float32Array | null)[]> {
  const nonEmpty = texts.map((t) => t.length > 0);
  const vectors = await provider.embed(texts.filter((_, i) => nonEmpty[i]));
  let cursor = 0;
  return texts.map((_, i) => (nonEmpty[i] ? (vectors[cursor++] ?? null) : null));
}

/**
 * Runs one staged discussion through the LLM and returns how it should be persisted:
 * `single` (keep the cluster whole) or `split` (one child per LLM segment, with messages
 * partitioned so nothing is lost). Requirement: a lone segment is always treated as `single`,
 * even if the LLM listed only some message ids.
 */
export async function enrichDiscussion(params: EnrichDiscussionParams): Promise<EnrichDiscussionResult> {
  const { discussionId, messages, llm, embeddingProvider, maxMessagesPerCall } = params;

  const { value, raw } = await llm.generateStructured({
    system: ENRICHMENT_SYSTEM_PROMPT,
    user: buildEnrichmentUserPrompt(messages, maxMessagesPerCall),
    schema: enrichmentResponseSchema,
    schemaName: "discussion_enrichment",
    context: `discussion=${discussionId} (${messages.length} zpráv)`,
  });

  const segments = value.segments;

  if (segments.length === 1) {
    const enrichment = toDomainEnrichment(segments[0]!);
    const [embedding] = await embed(embeddingProvider, [embeddingText(enrichment)]);
    return { outcome: { kind: "single", enrichment, embedding: embedding ?? null }, raw };
  }

  const buckets = partitionMessages(messages, segments);
  const enrichments = segments.map((seg) => toDomainEnrichment(seg));
  const embeddings = await embed(embeddingProvider, enrichments.map(embeddingText));

  const finalSegments: EnrichmentSegment[] = [];
  segments.forEach((_, i) => {
    const msgs = buckets[i] ?? [];
    if (msgs.length === 0) return;
    finalSegments.push({
      messageIds: msgs.map((m) => m.id),
      blockStartAt: msgs[0]!.createdAt,
      blockEndAt: msgs[msgs.length - 1]!.createdAt,
      enrichment: enrichments[i]!,
      embedding: embeddings[i] ?? null,
    });
  });

  // partition collapsed everything into one non-empty segment -> not really a split
  if (finalSegments.length <= 1) {
    const only = finalSegments[0];
    const enrichment = only?.enrichment ?? enrichments[0]!;
    const embedding = only?.embedding ?? embeddings[0] ?? null;
    return { outcome: { kind: "single", enrichment, embedding }, raw };
  }

  return { outcome: { kind: "split", segments: finalSegments }, raw };
}
