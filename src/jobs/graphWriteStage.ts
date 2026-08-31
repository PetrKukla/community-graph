import { config } from '../config/config';
import { buildDiscussionGraphPayload } from '../core/graphBuilder/discussionWriter';
import type { GraphStore } from '../core/ports/GraphStore';
import {
  getWritableDiscussions,
  loadDiscussionWriteInput,
  markDiscussionWritten
} from '../db/sqlite/repositories/graphWriteRepository';

export interface GraphWriteChannelResult {
  writtenDiscussionCount: number;
  skippedNoEnrichmentCount: number;
  failedCount: number;
  errors: { discussionId: string; error: string }[];
}

export interface GraphWriteChannelOptions {
  maxDiscussions?: number;
}

export async function graphWriteChannel(
  channelId: string,
  graphStore: GraphStore,
  options: GraphWriteChannelOptions = {}
): Promise<GraphWriteChannelResult> {
  let rows = getWritableDiscussions(channelId);
  if (options.maxDiscussions !== undefined)
    rows = rows.slice(0, options.maxDiscussions);

  const result: GraphWriteChannelResult = {
    writtenDiscussionCount: 0,
    skippedNoEnrichmentCount: 0,
    failedCount: 0,
    errors: []
  };

  for (const row of rows) {
    try {
      const input = loadDiscussionWriteInput(row);
      if (!input) {
        result.skippedNoEnrichmentCount++;
        continue;
      }
      const payload = buildDiscussionGraphPayload(
        input,
        config.embedding.dimensions
      );
      await graphStore.writeDiscussion(payload);
      markDiscussionWritten(row.id);
      result.writtenDiscussionCount++;
    } catch (err) {
      result.failedCount++;
      result.errors.push({
        discussionId: row.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return result;
}
