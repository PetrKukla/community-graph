import { eq, inArray } from 'drizzle-orm';
import { db } from '../client';
import { discussionEnrichment, messages, users } from '../schema';
import type {
  EnrichmentBits,
  SqliteContextSource
} from '../../../core/query/contextBuilder';
import type { RawMessage } from '../../../core/query/types';

/**
 * The enrichment detail the graph does not carry on the Discussion node (key_points, typed
 * entities), keyed by discussion id. Neo4j `Discussion.id` == SQLite `discussion_enrichment.discussion_id`
 * (for split discussions it is the child's id, which is what graph-write persisted).
 */
export function getEnrichmentBits(ids: string[]): Map<string, EnrichmentBits> {
  const out = new Map<string, EnrichmentBits>();
  if (ids.length === 0) return out;
  const rows = db
    .select({
      discussionId: discussionEnrichment.discussionId,
      summary: discussionEnrichment.summary,
      topics: discussionEnrichment.topics,
      entities: discussionEnrichment.entities,
      keyPoints: discussionEnrichment.keyPoints
    })
    .from(discussionEnrichment)
    .where(inArray(discussionEnrichment.discussionId, ids))
    .all();

  for (const r of rows) {
    out.set(r.discussionId, {
      keyPoints: r.keyPoints ?? [],
      summary: r.summary ?? null,
      topics: r.topics ?? [],
      entities: r.entities ?? []
    });
  }
  return out;
}

/** Chronological raw messages of one discussion, oldest first, capped at `limit`. */
export function getDiscussionMessagesForQuery(
  discussionId: string,
  limit: number
): RawMessage[] {
  if (limit <= 0) return [];
  const rows = db
    .select({
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
    .limit(limit)
    .all();

  return rows.map((r) => ({
    authorLabel: r.displayName ?? r.username ?? r.authorId,
    content: r.content,
    createdAt: r.createdAt
  }));
}

/** Real SQLite implementation of the context source port, wired into the query route. */
export const sqliteContextSource: SqliteContextSource = {
  getEnrichmentBits,
  getDiscussionMessagesForQuery
};
