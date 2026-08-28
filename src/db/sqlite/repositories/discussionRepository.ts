import { and, eq, sql } from "drizzle-orm";
import { db } from "../client";
import { messages, discussionsLocal, channelCheckpoints } from "../schema";
import type { ClusterableMessage } from "../../../core/clustering/types";
import type { FinalizedDiscussion, MessageAssignment } from "../../../core/clustering/types";

export function getUnprocessedMessages(channelId: string): ClusterableMessage[] {
  const rows = db
    .select({
      id: messages.id,
      authorId: messages.authorId,
      content: messages.content,
      createdAt: messages.createdAt,
      replyToMessageId: messages.replyToMessageId,
      threadId: messages.threadId,
      mentions: messages.mentions,
      wordCount: messages.wordCount,
    })
    .from(messages)
    .where(and(eq(messages.channelId, channelId), eq(messages.processed, 0)))
    .orderBy(messages.createdAt)
    .all();
  return rows;
}

export function getMaxTimestamp(channelId: string): string | null {
  const row = db
    .select({ max: sql<string | null>`max(${messages.createdAt})` })
    .from(messages)
    .where(eq(messages.channelId, channelId))
    .get();
  return row?.max ?? null;
}

export function resolveReplyTargetDiscussion(messageId: string): string | null {
  const row = db
    .select({ discussionId: messages.discussionId })
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.processed, 1)))
    .get();
  return row?.discussionId ?? null;
}

export function findThreadDiscussion(threadId: string): string | null {
  const row = db.select({ id: discussionsLocal.id }).from(discussionsLocal).where(eq(discussionsLocal.threadId, threadId)).get();
  return row?.id ?? null;
}

export interface DeleteChannelMessagesResult {
  deletedMessageCount: number;
  deletedDiscussionCount: number;
}

/**
 * Debug-only: wipes a channel's messages, staged discussions and checkpoint so it can be
 * re-ingested from scratch (e.g. after tuning clustering thresholds in config.toml).
 */
export function deleteChannelMessages(channelId: string): DeleteChannelMessagesResult {
  return db.transaction((tx) => {
    const deletedMessages = tx.delete(messages).where(eq(messages.channelId, channelId)).returning({ id: messages.id }).all();
    const deletedDiscussions = tx
      .delete(discussionsLocal)
      .where(eq(discussionsLocal.channelId, channelId))
      .returning({ id: discussionsLocal.id })
      .all();
    tx.delete(channelCheckpoints).where(eq(channelCheckpoints.channelId, channelId)).run();
    return { deletedMessageCount: deletedMessages.length, deletedDiscussionCount: deletedDiscussions.length };
  });
}

export interface PersistSummary {
  processedMessageCount: number;
  newDiscussionCount: number;
  extendedDiscussionCount: number;
}

/**
 * Persists the outcome of clustering one or more (already-decided, closed) blocks in a single transaction:
 * upserts discussions_local rows, bumps message_count on discussions that absorbed messages from elsewhere,
 * links every processed message to its discussion, and advances the channel checkpoint.
 */
export function persistClusterResults(
  channelId: string,
  results: { assignments: MessageAssignment[]; discussions: FinalizedDiscussion[] }[],
  closedThroughAt: string | null,
): PersistSummary {
  const now = new Date().toISOString();
  const allDiscussions = results.flatMap((r) => r.discussions);
  const allAssignments = results.flatMap((r) => r.assignments);
  const newOrExtendedIds = new Set(allDiscussions.map((d) => d.id));

  return db.transaction((tx) => {
    let newDiscussionCount = 0;
    let extendedDiscussionCount = 0;

    for (const d of allDiscussions) {
      if (d.isExtension) {
        tx.update(discussionsLocal)
          .set({
            blockEndAt: d.blockEndAt,
            messageCount: sql`${discussionsLocal.messageCount} + ${d.messageCount}`,
            status: "needs_reenrichment",
          })
          .where(eq(discussionsLocal.id, d.id))
          .run();
        extendedDiscussionCount++;
      } else {
        tx.insert(discussionsLocal)
          .values({
            id: d.id,
            channelId: d.channelId,
            threadId: d.threadId,
            blockStartAt: d.blockStartAt,
            blockEndAt: d.blockEndAt,
            status: "clustering",
            messageCount: d.messageCount,
            centroidEmbedding: d.centroidEmbedding
              ? Buffer.from(d.centroidEmbedding.buffer, d.centroidEmbedding.byteOffset, d.centroidEmbedding.byteLength)
              : null,
            continuationOfDiscussionId: d.continuationOfDiscussionId ?? null,
            continuationReason: d.continuationReason ?? null,
          })
          .run();
        newDiscussionCount++;
      }
    }

    for (const a of allAssignments) {
      tx.update(messages).set({ processed: 1, discussionId: a.discussionId }).where(eq(messages.id, a.messageId)).run();
    }

    const bumps = new Map<string, number>();
    for (const a of allAssignments) {
      if (newOrExtendedIds.has(a.discussionId)) continue;
      bumps.set(a.discussionId, (bumps.get(a.discussionId) ?? 0) + 1);
    }
    for (const [discussionId, count] of bumps) {
      tx.update(discussionsLocal)
        .set({ messageCount: sql`${discussionsLocal.messageCount} + ${count}`, status: "needs_reenrichment" })
        .where(eq(discussionsLocal.id, discussionId))
        .run();
    }

    if (closedThroughAt) {
      tx.insert(channelCheckpoints)
        .values({ channelId, lastClosedBlockEndAt: closedThroughAt, updatedAt: now })
        .onConflictDoUpdate({
          target: channelCheckpoints.channelId,
          set: { lastClosedBlockEndAt: closedThroughAt, updatedAt: now },
        })
        .run();
    }

    return { processedMessageCount: allAssignments.length, newDiscussionCount, extendedDiscussionCount };
  });
}
