import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  channels,
  guilds,
  messages,
  users,
  discussionsLocal,
  discussionEnrichment
} from '../schema';
import type { DiscussionWriteInput } from '../../../core/graphBuilder/discussionWriter';

export interface WritableDiscussionRow {
  id: string;
  channelId: string;
  blockStartAt: string;
  blockEndAt: string;
  continuationOfDiscussionId: string | null;
  continuationReason: string | null;
}

/** Discussions ready for graph write: enriched and not yet written. Split parents are excluded (status 'split'). */
export function getWritableDiscussions(
  channelId: string
): WritableDiscussionRow[] {
  return db
    .select({
      id: discussionsLocal.id,
      channelId: discussionsLocal.channelId,
      blockStartAt: discussionsLocal.blockStartAt,
      blockEndAt: discussionsLocal.blockEndAt,
      continuationOfDiscussionId: discussionsLocal.continuationOfDiscussionId,
      continuationReason: discussionsLocal.continuationReason
    })
    .from(discussionsLocal)
    .where(
      and(
        eq(discussionsLocal.channelId, channelId),
        eq(discussionsLocal.status, 'enriched')
      )
    )
    .orderBy(discussionsLocal.blockStartAt)
    .all();
}

function toFloat32(buf: Buffer | null): Float32Array | null {
  if (
    !buf ||
    buf.byteLength === 0 ||
    buf.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0
  )
    return null;
  return new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
}

/** Assembles everything the graph payload builder needs for one discussion, or null if it has no enrichment row. */
export function loadDiscussionWriteInput(
  row: WritableDiscussionRow
): DiscussionWriteInput | null {
  const enrichment = db
    .select()
    .from(discussionEnrichment)
    .where(eq(discussionEnrichment.discussionId, row.id))
    .get();
  if (!enrichment) return null;

  const channelRow = db
    .select({ id: channels.id, name: channels.name, guildId: channels.guildId })
    .from(channels)
    .where(eq(channels.id, row.channelId))
    .get() ?? { id: row.channelId, name: null, guildId: null };

  const guildName = channelRow.guildId
    ? (db
        .select({ name: guilds.name })
        .from(guilds)
        .where(eq(guilds.id, channelRow.guildId))
        .get()?.name ?? null)
    : null;
  const channel = { ...channelRow, guildName };

  const participantAgg = db
    .select({
      authorId: messages.authorId,
      messageCount: sql<number>`count(*)`,
      firstMessageAt: sql<string>`min(${messages.createdAt})`,
      lastMessageAt: sql<string>`max(${messages.createdAt})`
    })
    .from(messages)
    .where(eq(messages.discussionId, row.id))
    .groupBy(messages.authorId)
    .all();

  const authorIds = participantAgg.map((p) => p.authorId);
  const userRows =
    authorIds.length > 0
      ? db.select().from(users).where(inArray(users.id, authorIds)).all()
      : [];
  const userById = new Map(userRows.map((u) => [u.id, u]));

  const participants = participantAgg.map((p) => {
    const u = userById.get(p.authorId);
    return {
      id: p.authorId,
      username: u?.username ?? null,
      displayName: u?.displayName ?? null,
      firstSeenAt: u?.firstSeenAt ?? null,
      lastSeenAt: u?.lastSeenAt ?? null,
      userMessageCount: u?.messageCount ?? p.messageCount,
      messageCount: p.messageCount,
      firstMessageAt: p.firstMessageAt,
      lastMessageAt: p.lastMessageAt
    };
  });

  return {
    discussion: {
      id: row.id,
      channelId: row.channelId,
      blockStartAt: row.blockStartAt,
      blockEndAt: row.blockEndAt,
      continuationOfDiscussionId: row.continuationOfDiscussionId,
      continuationReason: row.continuationReason
    },
    enrichment: {
      title: enrichment.title,
      summary: enrichment.summary,
      topics: enrichment.topics,
      entities: enrichment.entities,
      sentiment: enrichment.sentiment,
      sentimentScore: enrichment.sentimentScore,
      language: enrichment.language,
      discussionType: enrichment.discussionType,
      resolved: enrichment.resolved,
      embedding: toFloat32(enrichment.embedding)
    },
    channel,
    participants
  };
}

/** Marks a discussion as written into the graph and its messages fully processed. */
export function markDiscussionWritten(discussionId: string): void {
  db.transaction((tx) => {
    tx.update(discussionsLocal)
      .set({ status: 'written' })
      .where(eq(discussionsLocal.id, discussionId))
      .run();
    tx.update(messages)
      .set({ processed: 3 })
      .where(eq(messages.discussionId, discussionId))
      .run();
  });
}
