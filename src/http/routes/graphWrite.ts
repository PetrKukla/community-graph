import { Hono } from "hono";
import { z } from "zod";
import { createJob } from "../../db/sqlite/repositories/jobRepository";
import { runGraphWriteJob } from "../../jobs/jobRunner";
import { methodNotAllowed } from "../middleware/methodNotAllowed";

const bodySchema = z.object({ max_discussions: z.number().int().positive().optional() });

export const graphWriteRoute = new Hono();

graphWriteRoute.post("/channels/:id/graph-write", async (c) => {
  const channelId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: "invalid_request", details: parsed.error.flatten() }, 400);
  }

  const jobId = createJob("graph_write", channelId, { maxDiscussions: parsed.data.max_discussions });
  runGraphWriteJob(jobId, channelId, { maxDiscussions: parsed.data.max_discussions });
  return c.json({ job_id: jobId, type: "graph_write", status: "queued" }, 202);
});

graphWriteRoute.all("/channels/:id/graph-write", methodNotAllowed);
