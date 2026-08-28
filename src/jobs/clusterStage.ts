import { config } from "../config/config";
import { splitIntoTimeBlocks, type TimeBlock } from "../core/clustering/timeBlockSplitter";
import { clusterBlock, assignThreadBlock } from "../core/clustering/clusterBlock";
import type { ClusterableMessage } from "../core/clustering/types";
import type { EmbeddingProvider } from "../core/ports/EmbeddingProvider";
import {
  getUnprocessedMessages,
  getMaxTimestamp,
  resolveReplyTargetDiscussion,
  findThreadDiscussion,
  persistClusterResults,
} from "../db/sqlite/repositories/discussionRepository";

export interface ClusterChannelResult {
  processedMessageCount: number;
  newDiscussionCount: number;
  extendedDiscussionCount: number;
  skippedOpenBlockMessageCount: number;
}

export async function clusterChannel(channelId: string, embeddingProvider: EmbeddingProvider): Promise<ClusterChannelResult> {
  const unprocessed = getUnprocessedMessages(channelId);
  if (unprocessed.length === 0) {
    return { processedMessageCount: 0, newDiscussionCount: 0, extendedDiscussionCount: 0, skippedOpenBlockMessageCount: 0 };
  }

  const maxTimestamp = getMaxTimestamp(channelId)!;

  const threadGroups = new Map<string, ClusterableMessage[]>();
  const mainStream: ClusterableMessage[] = [];
  for (const msg of unprocessed) {
    if (msg.threadId) {
      const arr = threadGroups.get(msg.threadId);
      if (arr) arr.push(msg);
      else threadGroups.set(msg.threadId, [msg]);
    } else {
      mainStream.push(msg);
    }
  }

  const totals: ClusterChannelResult = { processedMessageCount: 0, newDiscussionCount: 0, extendedDiscussionCount: 0, skippedOpenBlockMessageCount: 0 };

  // blocks are persisted one at a time, in chronological order, so that a reply within a *later*
  // block can resolve against a discussion finalized by an *earlier* block in this same run
  // (a Discord reply always points backwards in time, never forwards).
  const blocks = splitIntoTimeBlocks(mainStream, config.clustering.silence_gap_minutes, maxTimestamp);
  for (const block of blocks) {
    if (!block.closed) {
      totals.skippedOpenBlockMessageCount += block.messages.length;
      continue;
    }
    const result = await clusterBlock({
      block,
      channelId,
      wordLimit: config.clustering.short_message_word_limit,
      similarityThreshold: config.clustering.similarity_threshold,
      activeSubclusterIdleMinutes: config.clustering.active_subcluster_idle_minutes,
      embeddingProvider,
      resolveReplyTarget: resolveReplyTargetDiscussion,
    });
    const summary = persistClusterResults(channelId, [result], block.endAt);
    totals.processedMessageCount += summary.processedMessageCount;
    totals.newDiscussionCount += summary.newDiscussionCount;
    totals.extendedDiscussionCount += summary.extendedDiscussionCount;
  }

  // threads always get fully processed each run - there is no time-gap concept to keep them "open"
  for (const [threadId, threadMessages] of threadGroups) {
    const block: TimeBlock = {
      messages: threadMessages,
      startAt: threadMessages[0]!.createdAt,
      endAt: threadMessages[threadMessages.length - 1]!.createdAt,
      closed: true,
    };
    const existingDiscussionId = findThreadDiscussion(threadId);
    const result = assignThreadBlock(block, channelId, threadId, existingDiscussionId);
    const summary = persistClusterResults(channelId, [result], null);
    totals.processedMessageCount += summary.processedMessageCount;
    totals.newDiscussionCount += summary.newDiscussionCount;
    totals.extendedDiscussionCount += summary.extendedDiscussionCount;
  }

  return totals;
}
