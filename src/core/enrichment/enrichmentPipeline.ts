import type { EmbeddingProvider } from '../ports/EmbeddingProvider';
import type { LLMProvider } from '../ports/LLMProvider';
import {
  ENRICHMENT_SYSTEM_PROMPT,
  buildBatchEnrichmentUserPrompt,
  buildEnrichmentUserPrompt,
  renderMessageLine
} from './prompt';
import { enrichmentResponseSchema, type EnrichmentSegmentRaw } from './schemas';
import type {
  DiscussionEnrichment,
  EnrichableMessage,
  EnrichmentOutcome,
  EnrichmentSegment
} from './types';

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
    resolved: seg.resolved
  };
}

function embeddingText(e: DiscussionEnrichment): string {
  return [e.title, e.summary, e.topics.join(', ')]
    .map((s) => s.trim())
    .filter(Boolean)
    .join('. ');
}

/**
 * Assigns every message to exactly one of the LLM's segments.
 * - honour the message_ids the LLM gave (first segment wins on a duplicate id)
 * - a message the LLM forgot goes to the segment of the chronologically nearest assigned message
 * - if the LLM gave no usable ids at all, fall back to contiguous chronological chunks
 */
function partitionMessages(
  messages: EnrichableMessage[],
  segments: EnrichmentSegmentRaw[]
): EnrichableMessage[][] {
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

async function embed(
  provider: EmbeddingProvider,
  texts: string[]
): Promise<(Float32Array | null)[]> {
  const nonEmpty = texts.map((t) => t.length > 0);
  const vectors = await provider.embed(texts.filter((_, i) => nonEmpty[i]));
  let cursor = 0;
  return texts.map((_, i) =>
    nonEmpty[i] ? (vectors[cursor++] ?? null) : null
  );
}

/**
 * Turns the segments the LLM returned *for one parent discussion* into the persistable outcome:
 * `single` (keep the cluster whole) or `split` (one child per segment, messages partitioned so
 * nothing is lost). A lone segment is always `single`, even if the LLM listed only some ids.
 */
async function resolveOutcome(
  messages: EnrichableMessage[],
  segments: EnrichmentSegmentRaw[],
  embeddingProvider: EmbeddingProvider
): Promise<EnrichmentOutcome> {
  if (segments.length === 1) {
    const enrichment = toDomainEnrichment(segments[0]!);
    const [embedding] = await embed(embeddingProvider, [
      embeddingText(enrichment)
    ]);
    return { kind: 'single', enrichment, embedding: embedding ?? null };
  }

  const buckets = partitionMessages(messages, segments);
  const enrichments = segments.map((seg) => toDomainEnrichment(seg));
  const embeddings = await embed(
    embeddingProvider,
    enrichments.map(embeddingText)
  );

  const finalSegments: EnrichmentSegment[] = [];
  segments.forEach((_, i) => {
    const msgs = buckets[i] ?? [];
    if (msgs.length === 0) return;
    finalSegments.push({
      messageIds: msgs.map((m) => m.id),
      blockStartAt: msgs[0]!.createdAt,
      blockEndAt: msgs[msgs.length - 1]!.createdAt,
      enrichment: enrichments[i]!,
      embedding: embeddings[i] ?? null
    });
  });

  // partition collapsed everything into one non-empty segment -> not really a split
  if (finalSegments.length <= 1) {
    const only = finalSegments[0];
    const enrichment = only?.enrichment ?? enrichments[0]!;
    const embedding = only?.embedding ?? embeddings[0] ?? null;
    return { kind: 'single', enrichment, embedding };
  }

  return { kind: 'split', segments: finalSegments };
}

// --- batching (Část 4.4) -----------------------------------------------------

export interface EnrichBatchCluster {
  discussionId: string;
  messages: EnrichableMessage[]; // chronological
}

export interface EnrichBatchParams {
  llm: LLMProvider;
  embeddingProvider: EmbeddingProvider;
  maxMessagesPerCall: number;
}

export interface PackBatchesOptions {
  /** Target prompt token budget for one call; 0 disables batching (one call per discussion). */
  targetTokens: number;
  /** Hard cap on clusters in one call. */
  maxDiscussions: number;
  /** Cap on the SUM of messages across one batch. */
  maxMessagesPerCall: number;
}

export interface EnrichmentBatch {
  clusters: EnrichBatchCluster[];
}

// vendor-free token estimate: chars/token ~ 3.5 for Czech, ~40 tokens of framing per cluster
const CHARS_PER_TOKEN = 3.5;
const OVERHEAD_PER_CLUSTER = 40;

function estimateClusterTokens(c: EnrichBatchCluster): number {
  let chars = 0;
  for (const m of c.messages) chars += renderMessageLine(m).length + 2;
  return OVERHEAD_PER_CLUSTER + Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Greedy first-fit bin-packing of discussions (kept in `blockStartAt` order by the caller) into
 * batches under `targetTokens` / `maxDiscussions` / `maxMessagesPerCall`. A discussion bigger
 * than the budget on its own goes into its own batch. `targetTokens === 0` => one per batch.
 */
export function packDiscussionsIntoBatches(
  clusters: EnrichBatchCluster[],
  opts: PackBatchesOptions
): EnrichmentBatch[] {
  if (opts.targetTokens <= 0) return clusters.map((c) => ({ clusters: [c] }));

  const batches: EnrichmentBatch[] = [];
  let current: EnrichBatchCluster[] = [];
  let curTokens = 0;
  let curMessages = 0;

  const flush = () => {
    if (current.length > 0) batches.push({ clusters: current });
    current = [];
    curTokens = 0;
    curMessages = 0;
  };

  for (const c of clusters) {
    const tokens = estimateClusterTokens(c);
    const msgs = c.messages.length;
    const wouldOverflow =
      current.length > 0 &&
      (curTokens + tokens > opts.targetTokens ||
        current.length + 1 > opts.maxDiscussions ||
        curMessages + msgs > opts.maxMessagesPerCall);
    if (wouldOverflow) flush();
    current.push(c);
    curTokens += tokens;
    curMessages += msgs;
    // a lone cluster already over a limit: close it out on its own
    if (
      current.length === 1 &&
      (curTokens > opts.targetTokens || curMessages > opts.maxMessagesPerCall)
    ) {
      flush();
    }
  }
  flush();
  return batches;
}

/**
 * Enriches one batch of clusters in a single LLM call and maps the returned segments back onto
 * their parent discussions. Returns one {@link EnrichDiscussionResult} per input cluster.
 *
 * Mapping rules (Část 4.4):
 * - message ownership is authoritative: a segment's `message_ids` decide which parent(s) it feeds
 * - a segment whose ids span several parents is cut along the ownership boundary
 * - a segment with no usable ids falls back to its `source_cluster` label (or the lone cluster)
 * - a cluster the model skipped entirely is re-enriched with its own call, never dropped
 */
export async function enrichBatch(
  clusters: EnrichBatchCluster[],
  params: EnrichBatchParams
): Promise<Map<string, EnrichDiscussionResult>> {
  const out = new Map<string, EnrichDiscussionResult>();
  if (clusters.length === 0) return out;

  const single = clusters.length === 1;
  const labelled = clusters.map((c, i) => ({ ...c, label: `c${i + 1}` }));
  const parentByLabel = new Map(labelled.map((c) => [c.label, c.discussionId]));
  const ownerByMessageId = new Map<string, string>();
  for (const c of labelled) {
    for (const m of c.messages) ownerByMessageId.set(m.id, c.discussionId);
  }
  const totalMessages = labelled.reduce((n, c) => n + c.messages.length, 0);

  const first = labelled[0]!;
  const user = single
    ? buildEnrichmentUserPrompt(first.messages, params.maxMessagesPerCall)
    : buildBatchEnrichmentUserPrompt(labelled, params.maxMessagesPerCall);

  const { value, raw } = await params.llm.generateStructured({
    system: ENRICHMENT_SYSTEM_PROMPT,
    user,
    schema: enrichmentResponseSchema,
    schemaName: 'discussion_enrichment',
    context: single
      ? `discussion=${first.discussionId} (${first.messages.length} zpráv)`
      : `batch ${labelled.length} diskuzí (${totalMessages} zpráv)`
  });

  // group segments per parent discussion, cutting cross-parent segments along ownership
  const segsByParent = new Map<string, EnrichmentSegmentRaw[]>();
  for (const c of labelled) segsByParent.set(c.discussionId, []);

  for (const seg of value.segments) {
    const idsByParent = new Map<string, string[]>();
    for (const id of seg.message_ids) {
      const owner = ownerByMessageId.get(id);
      if (!owner) continue;
      const arr = idsByParent.get(owner) ?? [];
      arr.push(id);
      idsByParent.set(owner, arr);
    }

    if (idsByParent.size === 0) {
      const fallback =
        (seg.source_cluster && parentByLabel.get(seg.source_cluster)) ||
        (single ? first.discussionId : undefined);
      if (fallback) {
        segsByParent.get(fallback)!.push({ ...seg, message_ids: [] });
      }
      continue;
    }

    for (const [parent, ids] of idsByParent) {
      segsByParent.get(parent)!.push({ ...seg, message_ids: ids });
    }
  }

  const omitted: EnrichBatchCluster[] = [];
  for (const c of labelled) {
    const segs = segsByParent.get(c.discussionId)!;
    if (segs.length === 0) {
      omitted.push({ discussionId: c.discussionId, messages: c.messages });
      continue;
    }
    const outcome = await resolveOutcome(
      c.messages,
      segs,
      params.embeddingProvider
    );
    out.set(c.discussionId, { outcome, raw });
  }

  // clusters the model skipped entirely -> resolve each on its own (single-cluster => no recursion)
  for (const c of omitted) {
    const solo = await enrichBatch([c], params);
    for (const [k, v] of solo) out.set(k, v);
  }

  return out;
}

/**
 * Thin wrapper over {@link enrichBatch} for the one-discussion case. Kept so callers and tests
 * that enrich a single discussion don't have to think in batches.
 */
export async function enrichDiscussion(
  params: EnrichDiscussionParams
): Promise<EnrichDiscussionResult> {
  const map = await enrichBatch(
    [{ discussionId: params.discussionId, messages: params.messages }],
    {
      llm: params.llm,
      embeddingProvider: params.embeddingProvider,
      maxMessagesPerCall: params.maxMessagesPerCall
    }
  );
  return map.get(params.discussionId)!;
}
