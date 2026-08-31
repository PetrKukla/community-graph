import { Hono } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { bus } from "../../core/events/bus";
import { ingestBatch } from "../../db/sqlite/repositories/ingestRepository";
import { methodNotAllowed } from "../middleware/methodNotAllowed";

// .strict() everywhere a name field used to live: a batch that still carries guild.name /
// channel.name / author.username gets a 400 pointing at POST /api/v1/dictionary (Část 4.1).
const ingestMessageSchema = z
  .object({
    id: z.string().min(1),
    author: z.object({ id: z.string().min(1) }).strict(),
    content: z.string(),
    created_at: z.string().min(1),
    reply_to_message_id: z.string().optional(),
    thread_id: z.string().optional(),
    mentions: z.array(z.string()).optional(),
    attachments_count: z.number().int().nonnegative().optional(),
  })
  .strict();

const ingestBatchSchema = z
  .object({
    guild: z.object({ id: z.string().min(1) }).strict(),
    channel: z.object({ id: z.string().min(1), type: z.string().optional() }).strict(),
    messages: z.array(ingestMessageSchema).min(1),
  })
  .strict();

export const ingestRoute = new Hono();

ingestRoute.post("/batches", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = ingestBatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_request", details: parsed.error.flatten() }, 400);
  }

  const batchId = randomUUID();
  const result = ingestBatch(batchId, parsed.data);

  bus.emit("ingest.batch", {
    batch_id: result.batchId,
    channel_id: parsed.data.channel.id,
    message_count: result.messageCount,
    inserted_count: result.insertedCount,
    duplicate_count: result.duplicateCount,
    at: new Date().toISOString(),
  });

  return c.json(
    {
      batch_id: result.batchId,
      message_count: result.messageCount,
      inserted_count: result.insertedCount,
      duplicate_count: result.duplicateCount,
    },
    202,
  );
});

ingestRoute.all("/batches", methodNotAllowed);
