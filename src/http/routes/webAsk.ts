import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../../db/sqlite/client';
import { discussionsLocal, messages, users } from '../../db/sqlite/schema';
import { loadEnrichmentRow } from '../../db/sqlite/repositories/enrichmentRepository';
import { getGraphStore, isNeo4jConfigured } from '../../adapters/graph';
import { methodNotAllowed } from '../middleware/methodNotAllowed';

/**
 * Small read endpoints for the web query view (Část 4.3). Mounted only when [web] enabled.
 */
export const webAskRoute = new Hono();

/** Bundle for the citation drawer: the local discussion row + enrichment + its raw messages. */
webAskRoute.get('/discussions/:id', (c) => {
  const id = c.req.param('id');
  const row = db
    .select()
    .from(discussionsLocal)
    .where(eq(discussionsLocal.id, id))
    .get();
  if (!row) return c.json({ error: 'not_found' }, 404);

  const msgs = db
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
    .where(eq(messages.discussionId, id))
    .orderBy(messages.createdAt)
    .all();

  return c.json({
    id: row.id,
    channel_id: row.channelId,
    status: row.status,
    thread_id: row.threadId,
    parent_discussion_id: row.parentDiscussionId,
    message_count: row.messageCount,
    block_start_at: row.blockStartAt,
    block_end_at: row.blockEndAt,
    continuation_of_discussion_id: row.continuationOfDiscussionId,
    continuation_reason: row.continuationReason,
    enrichment: loadEnrichmentRow(id),
    messages: msgs.map((m) => ({
      id: m.id,
      author_id: m.authorId,
      author_label: m.displayName ?? m.username ?? m.authorId,
      content: m.content,
      created_at: m.createdAt
    }))
  });
});
webAskRoute.all('/discussions/:id', methodNotAllowed);

/** Domain id -> Neo4j elementId, so a citation can deep-link to /graph?focus=<discussion_id>. */
webAskRoute.get('/graph/node/by-domain-id', async (c) => {
  if (!isNeo4jConfigured())
    return c.json({ error: 'neo4j_not_configured' }, 503);
  const label = c.req.query('label') ?? '';
  const id = c.req.query('id') ?? '';
  if (!label || !id)
    return c.json(
      { error: 'invalid_request', details: 'label and id are required' },
      400
    );

  try {
    const elementId = await getGraphStore().nodeIdByDomainId(label, id);
    if (!elementId) return c.json({ error: 'not_found' }, 404);
    return c.json({ element_id: elementId });
  } catch (err) {
    return c.json(
      {
        error: 'graph_query_failed',
        message: err instanceof Error ? err.message : String(err)
      },
      502
    );
  }
});
webAskRoute.all('/graph/node/by-domain-id', methodNotAllowed);
