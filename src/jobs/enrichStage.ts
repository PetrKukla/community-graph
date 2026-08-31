import { config } from '../config/config';
import {
  enrichBatch,
  packDiscussionsIntoBatches,
  type EnrichBatchCluster,
  type EnrichDiscussionResult
} from '../core/enrichment/enrichmentPipeline';
import type { EmbeddingProvider } from '../core/ports/EmbeddingProvider';
import type { LLMProvider } from '../core/ports/LLMProvider';
import {
  getEnrichableDiscussions,
  getDiscussionMessages,
  resetPriorEnrichment,
  persistSingleEnrichment,
  persistSplitEnrichment,
  type EnrichableDiscussionRow
} from '../db/sqlite/repositories/enrichmentRepository';

export interface EnrichChannelResult {
  enrichedDiscussionCount: number; // discussions enriched as a single unit
  splitDiscussionCount: number; // discussions the LLM broke into children
  createdSegmentCount: number; // child discussions created by splits
  skippedEmptyCount: number;
  failedCount: number;
  batchCount: number; // LLM calls made for whole batches (Část 4.4)
  individualRetryCount: number; // discussions re-tried one-by-one after a batch call failed
  errors: { discussionId: string; error: string }[];
}

export interface EnrichChannelOptions {
  maxDiscussions?: number;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function enrichChannel(
  channelId: string,
  llm: LLMProvider,
  embeddingProvider: EmbeddingProvider,
  options: EnrichChannelOptions = {}
): Promise<EnrichChannelResult> {
  let rows = getEnrichableDiscussions(channelId);
  if (options.maxDiscussions !== undefined)
    rows = rows.slice(0, options.maxDiscussions);

  const result: EnrichChannelResult = {
    enrichedDiscussionCount: 0,
    splitDiscussionCount: 0,
    createdSegmentCount: 0,
    skippedEmptyCount: 0,
    failedCount: 0,
    batchCount: 0,
    individualRetryCount: 0,
    errors: []
  };

  // load messages up front (packing needs sizes); drop empties, reset re-enriched rows
  const rowById = new Map<string, EnrichableDiscussionRow>();
  const clusters: EnrichBatchCluster[] = [];
  for (const row of rows) {
    // a re-enriched discussion may already have children + enrichment rows from a prior run
    if (row.status === 'needs_reenrichment') resetPriorEnrichment(row.id);
    const messages = getDiscussionMessages(row.id);
    if (messages.length === 0) {
      result.skippedEmptyCount++;
      continue;
    }
    rowById.set(row.id, row);
    clusters.push({ discussionId: row.id, messages });
  }

  const batchParams = {
    llm,
    embeddingProvider,
    maxMessagesPerCall: config.llm.max_messages_per_call
  };
  const batches = packDiscussionsIntoBatches(clusters, {
    targetTokens: config.llm.enrichment_batch_target_tokens,
    maxDiscussions: config.llm.enrichment_batch_max_discussions,
    maxMessagesPerCall: config.llm.max_messages_per_call
  });

  for (const batch of batches) {
    result.batchCount++;
    let byDiscussion: Map<string, EnrichDiscussionResult>;
    try {
      byDiscussion = await enrichBatch(batch.clusters, batchParams);
    } catch (err) {
      if (
        config.llm.enrichment_batch_retry_individually &&
        batch.clusters.length > 1
      ) {
        byDiscussion = new Map();
        for (const cluster of batch.clusters) {
          result.individualRetryCount++;
          try {
            const solo = await enrichBatch([cluster], batchParams);
            for (const [k, v] of solo) byDiscussion.set(k, v);
          } catch (soloErr) {
            result.failedCount++;
            result.errors.push({
              discussionId: cluster.discussionId,
              error: errText(soloErr)
            });
          }
        }
      } else {
        for (const cluster of batch.clusters) {
          result.failedCount++;
          result.errors.push({
            discussionId: cluster.discussionId,
            error: errText(err)
          });
        }
        continue;
      }
    }

    for (const cluster of batch.clusters) {
      const res = byDiscussion.get(cluster.discussionId);
      if (!res) continue; // already counted as failed in the retry branch
      const row = rowById.get(cluster.discussionId)!;
      try {
        if (res.outcome.kind === 'single') {
          persistSingleEnrichment(
            row.id,
            res.outcome.enrichment,
            res.outcome.embedding,
            res.raw
          );
          result.enrichedDiscussionCount++;
        } else {
          const persisted = persistSplitEnrichment(
            row,
            res.outcome.segments,
            res.raw
          );
          result.splitDiscussionCount++;
          result.createdSegmentCount += persisted.length;
        }
      } catch (err) {
        result.failedCount++;
        result.errors.push({ discussionId: row.id, error: errText(err) });
      }
    }
  }

  return result;
}
