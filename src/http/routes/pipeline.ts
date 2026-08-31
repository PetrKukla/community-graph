import { Hono } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { config } from "../../config/config";
import { bus } from "../../core/events/bus";
import { ingestBatch } from "../../db/sqlite/repositories/ingestRepository";
import { createJob } from "../../db/sqlite/repositories/jobRepository";
import { runPipelineJob } from "../../jobs/jobRunner";
import type { PipelineChannelOptions } from "../../jobs/pipelineStage";
import { ingestBatchSchema } from "./ingest";
import { methodNotAllowed } from "../middleware/methodNotAllowed";

const optionsSchema = z
  .object({
    max_messages: z.number().int().positive().optional(),
    max_discussions: z.number().int().positive().optional(),
    skip_graph_write: z.boolean().optional(),
  })
  .strict();

const withBatchSchema = ingestBatchSchema.extend({ options: optionsSchema.optional() });
const channelOnlySchema = z.object({ options: optionsSchema.optional() }).strict();

/** Resolve request options against [pipeline] config (skip_graph_write defaults to !include_graph_write). */
function toChannelOptions(opts: z.infer<typeof optionsSchema> | undefined): PipelineChannelOptions {
  return {
    maxMessages: opts?.max_messages,
    maxDiscussions: opts?.max_discussions,
    skipGraphWrite: opts?.skip_graph_write ?? !config.pipeline.include_graph_write,
  };
}

export const pipelineRoute = new Hono();

/**
 * Část 4.2 - one call runs ingest -> clusterize -> enrich -> graph-write. Ingest is synchronous
 * (fail-fast on a bad body, immediate inserted/duplicate counts); the rest is one "pipeline" job.
 */
pipelineRoute.post("/pipeline", async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = withBatchSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "invalid_request", details: parsed.error.flatten() }, 400);
  }

  const { options, ...batch } = parsed.data;
  const batchId = randomUUID();
  const ingest = ingestBatch(batchId, batch);

  bus.emit("ingest.batch", {
    batch_id: ingest.batchId,
    channel_id: batch.channel.id,
    message_count: ingest.messageCount,
    inserted_count: ingest.insertedCount,
    duplicate_count: ingest.duplicateCount,
    at: new Date().toISOString(),
  });

  const jobId = createJob("pipeline", batch.channel.id);
  runPipelineJob(jobId, batch.channel.id, ingest, toChannelOptions(options));

  return c.json(
    {
      batch_id: ingest.batchId,
      inserted_count: ingest.insertedCount,
      duplicate_count: ingest.duplicateCount,
      job_id: jobId,
      type: "pipeline",
      status: "queued",
    },
    202,
  );
});

pipelineRoute.all("/pipeline", methodNotAllowed);

/** Same job, no batch - runs the pipeline over the channel's already-ingested processed=0 messages. */
pipelineRoute.post("/channels/:id/pipeline", async (c) => {
  const channelId = c.req.param("id");
  const raw = await c.req.json().catch(() => ({}));
  const parsed = channelOnlySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return c.json({ error: "invalid_request", details: parsed.error.flatten() }, 400);
  }

  const jobId = createJob("pipeline", channelId);
  runPipelineJob(jobId, channelId, undefined, toChannelOptions(parsed.data.options));
  return c.json({ job_id: jobId, type: "pipeline", status: "queued" }, 202);
});

pipelineRoute.all("/channels/:id/pipeline", methodNotAllowed);
