import { sql } from 'drizzle-orm';
import { db } from '../client';
import { guilds, channels, users, messages, ingestionBatches } from '../schema';
import type { IngestBatchRequest } from '../../../core/domain/types';

const INSERT_CHUNK_SIZE = 500;

function countWords(content: string): number {
  const trimmed = content.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/u).length;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export interface IngestResult {
  batchId: string;
  messageCount: number;
  insertedCount: number;
  duplicateCount: number;
}

export function ingestBatch(
  batchId: string,
  req: IngestBatchRequest
): IngestResult {
  const now = new Date().toISOString();

  return db.transaction((tx) => {
    // Names are owned by POST /api/v1/dictionary. Ingest only ever writes the id skeleton
    // (so FKs and graph-write resolve) plus channel/user activity timestamps.
    tx.insert(guilds)
      .values({ id: req.guild.id, createdAt: now })
      .onConflictDoNothing()
      .run();

    tx.insert(channels)
      .values({
        id: req.channel.id,
        guildId: req.guild.id,
        type: req.channel.type ?? null,
        createdAt: now,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: channels.id,
        set: {
          updatedAt: now,
          // type still rides along the batch; only overwrite when the batch actually carries it
          ...(req.channel.type !== undefined ? { type: req.channel.type } : {})
        }
      })
      .run();

    const authorIds = new Set<string>();
    for (const m of req.messages) authorIds.add(m.author.id);
    for (const authorId of authorIds) {
      tx.insert(users)
        .values({
          id: authorId,
          firstSeenAt: now,
          lastSeenAt: now,
          messageCount: 0
        })
        .onConflictDoUpdate({
          target: users.id,
          // widen the seen-window; coalesce guards rows pre-seeded by dictionary (NULL seen columns)
          set: {
            firstSeenAt: sql`min(coalesce(${users.firstSeenAt}, ${now}), ${now})`,
            lastSeenAt: sql`max(coalesce(${users.lastSeenAt}, ${now}), ${now})`
          }
        })
        .run();
    }

    tx.insert(ingestionBatches)
      .values({
        id: batchId,
        channelId: req.channel.id,
        receivedAt: now,
        messageCount: req.messages.length,
        insertedCount: 0,
        duplicateCount: 0
      })
      .run();

    const insertedIds = new Set<string>();
    for (const batch of chunk(req.messages, INSERT_CHUNK_SIZE)) {
      const inserted = tx
        .insert(messages)
        .values(
          batch.map((m) => ({
            id: m.id,
            channelId: req.channel.id,
            guildId: req.guild.id,
            authorId: m.author.id,
            content: m.content,
            createdAt: m.created_at,
            replyToMessageId: m.reply_to_message_id ?? null,
            threadId: m.thread_id ?? null,
            mentions: m.mentions ?? null,
            attachmentsCount: m.attachments_count ?? 0,
            wordCount: countWords(m.content),
            batchId,
            ingestedAt: now,
            processed: 0,
            discussionId: null
          }))
        )
        .onConflictDoNothing()
        .returning({ id: messages.id })
        .all();
      for (const row of inserted) insertedIds.add(row.id);
    }
    const insertedCount = insertedIds.size;

    const authorCounts = new Map<string, number>();
    for (const m of req.messages) {
      if (!insertedIds.has(m.id)) continue;
      authorCounts.set(m.author.id, (authorCounts.get(m.author.id) ?? 0) + 1);
    }
    for (const [authorId, count] of authorCounts) {
      tx.update(users)
        .set({ messageCount: sql`${users.messageCount} + ${count}` })
        .where(sql`${users.id} = ${authorId}`)
        .run();
    }

    const duplicateCount = req.messages.length - insertedCount;

    tx.update(ingestionBatches)
      .set({ insertedCount, duplicateCount })
      .where(sql`${ingestionBatches.id} = ${batchId}`)
      .run();

    return {
      batchId,
      messageCount: req.messages.length,
      insertedCount,
      duplicateCount
    };
  });
}
