import { config } from "../config/config";
import { enrichDiscussion } from "../core/enrichment/enrichmentPipeline";
import type { EmbeddingProvider } from "../core/ports/EmbeddingProvider";
import type { LLMProvider } from "../core/ports/LLMProvider";
import {
  getEnrichableDiscussions,
  getDiscussionMessages,
  resetPriorEnrichment,
  persistSingleEnrichment,
  persistSplitEnrichment,
} from "../db/sqlite/repositories/enrichmentRepository";

export interface EnrichChannelResult {
  enrichedDiscussionCount: number; // discussions enriched as a single unit
  splitDiscussionCount: number; // discussions the LLM broke into children
  createdSegmentCount: number; // child discussions created by splits
  skippedEmptyCount: number;
  failedCount: number;
  errors: { discussionId: string; error: string }[];
}

export interface EnrichChannelOptions {
  maxDiscussions?: number;
}

export async function enrichChannel(
  channelId: string,
  llm: LLMProvider,
  embeddingProvider: EmbeddingProvider,
  options: EnrichChannelOptions = {},
): Promise<EnrichChannelResult> {
  let rows = getEnrichableDiscussions(channelId);
  if (options.maxDiscussions !== undefined) rows = rows.slice(0, options.maxDiscussions);

  const result: EnrichChannelResult = {
    enrichedDiscussionCount: 0,
    splitDiscussionCount: 0,
    createdSegmentCount: 0,
    skippedEmptyCount: 0,
    failedCount: 0,
    errors: [],
  };

  for (const row of rows) {
    try {
      // a re-enriched discussion may already have children + enrichment rows from a prior run
      if (row.status === "needs_reenrichment") resetPriorEnrichment(row.id);

      const messages = getDiscussionMessages(row.id);
      if (messages.length === 0) {
        result.skippedEmptyCount++;
        continue;
      }

      const { outcome, raw } = await enrichDiscussion({
        messages,
        llm,
        embeddingProvider,
        maxMessagesPerCall: config.llm.max_messages_per_call,
      });

      if (outcome.kind === "single") {
        persistSingleEnrichment(row.id, outcome.enrichment, outcome.embedding, raw);
        result.enrichedDiscussionCount++;
      } else {
        const persisted = persistSplitEnrichment(row, outcome.segments, raw);
        result.splitDiscussionCount++;
        result.createdSegmentCount += persisted.length;
      }
    } catch (err) {
      result.failedCount++;
      result.errors.push({ discussionId: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}
