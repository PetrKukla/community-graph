import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/sqlite/client";
import { discussionsLocal, messages } from "../../db/sqlite/schema";
import { deleteChannelMessages } from "../../db/sqlite/repositories/discussionRepository";
import { loadEnrichmentRow } from "../../db/sqlite/repositories/enrichmentRepository";
import { methodNotAllowed } from "../middleware/methodNotAllowed";

export const discussionsRoute = new Hono();

discussionsRoute.get("/channels/:id/discussions", (c) => {
  const channelId = c.req.param("id");
  const status = c.req.query("status");

  const conditions = [eq(discussionsLocal.channelId, channelId)];
  if (status) conditions.push(eq(discussionsLocal.status, status));

  const rows = db
    .select()
    .from(discussionsLocal)
    .where(and(...conditions))
    .orderBy(discussionsLocal.blockStartAt)
    .all();

  const result = rows.map((row) => {
    const msgs = db
      .select({ id: messages.id, authorId: messages.authorId, content: messages.content, createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.discussionId, row.id))
      .orderBy(messages.createdAt)
      .all();
    return {
      id: row.id,
      status: row.status,
      thread_id: row.threadId,
      parent_discussion_id: row.parentDiscussionId,
      message_count: row.messageCount,
      block_start_at: row.blockStartAt,
      block_end_at: row.blockEndAt,
      continuation_of_discussion_id: row.continuationOfDiscussionId,
      continuation_reason: row.continuationReason,
      enrichment: loadEnrichmentRow(row.id),
      messages: msgs.map((m) => ({ id: m.id, author_id: m.authorId, content: m.content, created_at: m.createdAt })),
    };
  });

  return c.json(result);
});

discussionsRoute.all("/channels/:id/discussions", methodNotAllowed);

/** Debug-only: wipes a channel's messages (and its staged discussions/checkpoint) so it can be re-ingested from scratch. */
discussionsRoute.delete("/channels/:id/messages", (c) => {
  const channelId = c.req.param("id");
  const result = deleteChannelMessages(channelId);
  return c.json({
    channel_id: channelId,
    deleted_message_count: result.deletedMessageCount,
    deleted_discussion_count: result.deletedDiscussionCount,
  });
});

discussionsRoute.all("/channels/:id/messages", methodNotAllowed);
