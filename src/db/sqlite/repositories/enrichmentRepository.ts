import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  messages,
  users,
  discussionsLocal,
  discussionEnrichment
} from '../schema';
import type {
  EnrichableMessage,
  DiscussionEnrichment,
  EnrichmentSegment
} from '../../../core/enrichment/types';

export interface EnrichableDiscussionRow {
  id: string;
  channelId: string;
  threadId: string | null;
  status: string;
}

/** Discussions still awaiting (re-)enrichment for a channel, oldest block first. */
export function getEnrichableDiscussions(
  channelId: string
): EnrichableDiscussionRow[] {
  return db
    .select({
      id: discussionsLocal.id,
      channelId: discussionsLocal.channelId,
      threadId: discussionsLocal.threadId,
      status: discussionsLocal.status
    })
    .from(discussionsLocal)
    .where(
      and(
        eq(discussionsLocal.channelId, channelId),
        inArray(discussionsLocal.status, ['clustering', 'needs_reenrichment'])
      )
    )
    .orderBy(discussionsLocal.blockStartAt)
    .all();
}

export function getDiscussionMessages(
  discussionId: string
): EnrichableMessage[] {
  const rows = db
    .select({
      id: messages.id,
      authorId: messages.authorId,
      content: messages.content,
      createdAt: messages.createdAt,
      username: users.username,
      displayName: users.displayName
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorId))
    .where(eq(messages.discussionId, discussionId))
    .orderBy(messages.createdAt)
    .all();

  return rows.map((r) => ({
    id: r.id,
    authorId: r.authorId,
    authorLabel: r.displayName ?? r.username ?? r.authorId,
    content: r.content,
    createdAt: r.createdAt
  }));
}

/**
 * Undo a previous enrichment run for `discussionId` so it can be re-enriched from scratch:
 * re-point any child discussions' messages back to the parent, delete the child rows, and
 * drop every enrichment row (parent + children). Runs in one transaction.
 */
export function resetPriorEnrichment(discussionId: string): void {
  db.transaction((tx) => {
    const children = tx
      .select({ id: discussionsLocal.id })
      .from(discussionsLocal)
      .where(eq(discussionsLocal.parentDiscussionId, discussionId))
      .all();
    const childIds = children.map((c) => c.id);

    if (childIds.length > 0) {
      tx.update(messages)
        .set({ discussionId })
        .where(inArray(messages.discussionId, childIds))
        .run();
      tx.delete(discussionEnrichment)
        .where(inArray(discussionEnrichment.discussionId, childIds))
        .run();
      tx.delete(discussionsLocal)
        .where(inArray(discussionsLocal.id, childIds))
        .run();
    }

    tx.delete(discussionEnrichment)
      .where(eq(discussionEnrichment.discussionId, discussionId))
      .run();
  });
}

function enrichmentValues(
  discussionId: string,
  e: DiscussionEnrichment,
  embedding: Float32Array | null,
  raw: string,
  now: string
) {
  return {
    discussionId,
    title: e.title,
    summary: e.summary,
    topics: e.topics,
    entities: e.entities,
    keyPoints: e.keyPoints,
    sentiment: e.sentiment,
    sentimentScore: e.sentimentScore,
    language: e.language,
    discussionType: e.discussionType,
    resolved: e.resolved,
    embedding: embedding
      ? Buffer.from(
          embedding.buffer,
          embedding.byteOffset,
          embedding.byteLength
        )
      : null,
    rawLlmResponse: raw,
    enrichedAt: now
  };
}

/** LLM returned a single segment: enrich the discussion in place, keep all its messages. */
export function persistSingleEnrichment(
  discussionId: string,
  enrichment: DiscussionEnrichment,
  embedding: Float32Array | null,
  raw: string
): void {
  const now = new Date().toISOString();
  db.transaction((tx) => {
    const values = enrichmentValues(
      discussionId,
      enrichment,
      embedding,
      raw,
      now
    );
    tx.insert(discussionEnrichment)
      .values(values)
      .onConflictDoUpdate({
        target: discussionEnrichment.discussionId,
        set: values
      })
      .run();
    tx.update(discussionsLocal)
      .set({ status: 'enriched' })
      .where(eq(discussionsLocal.id, discussionId))
      .run();
  });
}

export interface PersistedSegment {
  discussionId: string;
  messageCount: number;
}

/**
 * LLM split the discussion into >1 segments: create a child discussion per segment, re-point its
 * messages, write a child enrichment row, and mark the parent as `split`.
 */
export function persistSplitEnrichment(
  parent: EnrichableDiscussionRow,
  segments: EnrichmentSegment[],
  raw: string
): PersistedSegment[] {
  const now = new Date().toISOString();
  return db.transaction((tx) => {
    const persisted: PersistedSegment[] = [];
    for (const seg of segments) {
      const childId = randomUUID();
      tx.insert(discussionsLocal)
        .values({
          id: childId,
          channelId: parent.channelId,
          threadId: parent.threadId,
          blockStartAt: seg.blockStartAt,
          blockEndAt: seg.blockEndAt,
          status: 'enriched',
          messageCount: seg.messageIds.length,
          parentDiscussionId: parent.id
        })
        .run();
      if (seg.messageIds.length > 0) {
        tx.update(messages)
          .set({ discussionId: childId })
          .where(inArray(messages.id, seg.messageIds))
          .run();
      }
      tx.insert(discussionEnrichment)
        .values(
          enrichmentValues(childId, seg.enrichment, seg.embedding, raw, now)
        )
        .run();
      persisted.push({
        discussionId: childId,
        messageCount: seg.messageIds.length
      });
    }

    tx.update(discussionsLocal)
      .set({ status: 'split', messageCount: sql`0` })
      .where(eq(discussionsLocal.id, parent.id))
      .run();

    return persisted;
  });
}

export interface EnrichmentView {
  discussion_id: string;
  status: string;
  parent_discussion_id: string | null;
  split: boolean;
  message_ids: string[];
  enrichment: Record<string, unknown> | null;
  segments?: EnrichmentView[];
}

function loadMessageIds(discussionId: string): string[] {
  return db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.discussionId, discussionId))
    .orderBy(messages.createdAt)
    .all()
    .map((r) => r.id);
}

export function loadEnrichmentRow(
  discussionId: string
): Record<string, unknown> | null {
  const row = db
    .select()
    .from(discussionEnrichment)
    .where(eq(discussionEnrichment.discussionId, discussionId))
    .get();
  if (!row) return null;
  return {
    title: row.title,
    summary: row.summary,
    topics: row.topics,
    entities: row.entities,
    key_points: row.keyPoints,
    sentiment: row.sentiment,
    sentiment_score: row.sentimentScore,
    language: row.language,
    discussion_type: row.discussionType,
    resolved: row.resolved,
    enriched_at: row.enrichedAt
  };
}

/**
 * Reads whatever the enrichment step produced for a discussion id:
 * - a split parent -> `split: true` plus one entry per child segment
 * - a directly-enriched discussion (or a single child) -> its enrichment inline
 * - not yet enriched -> null
 */
export function getEnrichmentByDiscussionId(
  discussionId: string
): EnrichmentView | null {
  const discussion = db
    .select({
      id: discussionsLocal.id,
      status: discussionsLocal.status,
      parentDiscussionId: discussionsLocal.parentDiscussionId
    })
    .from(discussionsLocal)
    .where(eq(discussionsLocal.id, discussionId))
    .get();
  if (!discussion) return null;

  if (discussion.status === 'split') {
    const children = db
      .select({ id: discussionsLocal.id })
      .from(discussionsLocal)
      .where(eq(discussionsLocal.parentDiscussionId, discussionId))
      .orderBy(discussionsLocal.blockStartAt)
      .all();
    return {
      discussion_id: discussionId,
      status: discussion.status,
      parent_discussion_id: null,
      split: true,
      message_ids: [],
      enrichment: null,
      segments: children.map((c) => ({
        discussion_id: c.id,
        status: 'enriched',
        parent_discussion_id: discussionId,
        split: false,
        message_ids: loadMessageIds(c.id),
        enrichment: loadEnrichmentRow(c.id)
      }))
    };
  }

  const enrichment = loadEnrichmentRow(discussionId);
  if (!enrichment) return null;
  return {
    discussion_id: discussionId,
    status: discussion.status,
    parent_discussion_id: discussion.parentDiscussionId,
    split: false,
    message_ids: loadMessageIds(discussionId),
    enrichment
  };
}
