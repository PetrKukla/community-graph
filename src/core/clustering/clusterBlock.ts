import { randomUUID } from "node:crypto";
import type { EmbeddingProvider } from "../ports/EmbeddingProvider";
import type { TimeBlock } from "./timeBlockSplitter";
import { clusterLongMessages } from "./streamingClusterer";
import type { ClusterBlockResult, FinalizedDiscussion, MessageAssignment } from "./types";

export interface ClusterBlockParams {
  block: TimeBlock;
  channelId: string;
  wordLimit: number;
  similarityThreshold: number;
  activeSubclusterIdleMinutes: number;
  embeddingProvider: EmbeddingProvider;
  /** resolves reply_to_message_id -> discussionId of an already-finalized discussion, or null if unresolved */
  resolveReplyTarget: (messageId: string) => string | null;
}

/** Thread blocks bypass time-gap segmentation and sub-clustering entirely - the whole thread is one discussion. */
export function assignThreadBlock(
  block: TimeBlock,
  channelId: string,
  threadId: string,
  existingDiscussionId: string | null,
): ClusterBlockResult {
  const discussionId = existingDiscussionId ?? randomUUID();
  const assignments: MessageAssignment[] = block.messages.map((m) => ({
    messageId: m.id,
    discussionId,
    isNewDiscussion: !existingDiscussionId,
  }));
  const discussion: FinalizedDiscussion = {
    id: discussionId,
    channelId,
    threadId,
    blockStartAt: block.startAt,
    blockEndAt: block.endAt,
    messageCount: block.messages.length,
    centroidEmbedding: null,
    isExtension: existingDiscussionId !== null,
  };
  return { assignments, discussions: [discussion] };
}

export async function clusterBlock(params: ClusterBlockParams): Promise<ClusterBlockResult> {
  const { block, channelId, wordLimit, similarityThreshold, activeSubclusterIdleMinutes, embeddingProvider, resolveReplyTarget } = params;

  const longMessages = block.messages.filter((m) => m.wordCount >= wordLimit);
  const { assignments: subAssignments, subClusterCount, centroids } = await clusterLongMessages(
    longMessages,
    embeddingProvider,
    similarityThreshold,
    activeSubclusterIdleMinutes,
  );

  const subClusterIndexByMessageId = new Map(subAssignments.map((a) => [a.messageId, a.subClusterIndex]));
  const memberCountByIndex = new Map<number, number>();
  const spanByIndex = new Map<number, { start: string; end: string }>();
  for (const msg of longMessages) {
    const idx = subClusterIndexByMessageId.get(msg.id)!;
    memberCountByIndex.set(idx, (memberCountByIndex.get(idx) ?? 0) + 1);
    const span = spanByIndex.get(idx);
    if (!span) spanByIndex.set(idx, { start: msg.createdAt, end: msg.createdAt });
    else span.end = msg.createdAt; // messages are processed in chronological order
  }

  // resolve reply targets only for long messages that ended up as singleton outliers (case 3a),
  // and record continuation metadata for sub-clusters that absorbed >=2 messages replying into the same target (case 3b)
  const finalDiscussionIdByIndex = new Map<number, string>();
  const continuationByIndex = new Map<number, { discussionId: string; reason: "explicit_reply" }>();

  for (const msg of longMessages) {
    if (!msg.replyToMessageId) continue;
    const target = resolveReplyTarget(msg.replyToMessageId);
    if (!target) continue;
    const idx = subClusterIndexByMessageId.get(msg.id)!;
    const memberCount = memberCountByIndex.get(idx)!;
    if (memberCount === 1) {
      finalDiscussionIdByIndex.set(idx, target); // case (a): lone reply, move straight into the target discussion
    } else if (!continuationByIndex.has(idx)) {
      continuationByIndex.set(idx, { discussionId: target, reason: "explicit_reply" }); // case (b)
    }
  }

  const discussions: FinalizedDiscussion[] = [];
  for (let idx = 0; idx < subClusterCount; idx++) {
    if (finalDiscussionIdByIndex.has(idx)) continue; // absorbed into an existing discussion, no new row
    const id = randomUUID();
    finalDiscussionIdByIndex.set(idx, id);
    const continuation = continuationByIndex.get(idx);
    const span = spanByIndex.get(idx)!;
    discussions.push({
      id,
      channelId,
      threadId: null,
      blockStartAt: span.start,
      blockEndAt: span.end,
      messageCount: memberCountByIndex.get(idx) ?? 0,
      centroidEmbedding: centroids[idx] ?? null,
      continuationOfDiscussionId: continuation?.discussionId,
      continuationReason: continuation?.reason,
      isExtension: false,
    });
  }

  // second pass, chronological: interleave short-message shortcut using "discussion of the previous message in this block"
  const assignments: MessageAssignment[] = [];
  const discussionById = new Map(discussions.map((d) => [d.id, d]));
  let lastDiscussionId: string | null = null;
  const newDiscussionMessageCount = new Map<string, number>();

  for (const msg of block.messages) {
    const isLong = msg.wordCount >= wordLimit;

    if (isLong) {
      const idx = subClusterIndexByMessageId.get(msg.id)!;
      const discussionId = finalDiscussionIdByIndex.get(idx)!;
      assignments.push({ messageId: msg.id, discussionId, isNewDiscussion: false });
      lastDiscussionId = discussionId;
      continue;
    }

    const replyTarget = msg.replyToMessageId ? resolveReplyTarget(msg.replyToMessageId) : null;
    if (replyTarget) {
      assignments.push({ messageId: msg.id, discussionId: replyTarget, isNewDiscussion: false });
      continue;
    }

    if (lastDiscussionId) {
      assignments.push({ messageId: msg.id, discussionId: lastDiscussionId, isNewDiscussion: false });
      newDiscussionMessageCount.set(lastDiscussionId, (newDiscussionMessageCount.get(lastDiscussionId) ?? 0) + 1);
      const owning = discussionById.get(lastDiscussionId);
      if (owning) owning.blockEndAt = msg.createdAt;
      continue;
    }

    // first message of the block and it's short with no reply target - it starts a new, standalone discussion
    const id = randomUUID();
    assignments.push({ messageId: msg.id, discussionId: id, isNewDiscussion: true });
    const standalone: FinalizedDiscussion = {
      id,
      channelId,
      threadId: null,
      blockStartAt: msg.createdAt,
      blockEndAt: msg.createdAt,
      messageCount: 1,
      centroidEmbedding: null,
      isExtension: false,
    };
    discussions.push(standalone);
    discussionById.set(id, standalone);
    lastDiscussionId = id;
  }

  // account for short messages that attached onto a discussion created purely from long-message clustering
  for (const discussion of discussions) {
    const extra = newDiscussionMessageCount.get(discussion.id);
    if (extra) discussion.messageCount += extra;
  }

  return { assignments, discussions };
}
