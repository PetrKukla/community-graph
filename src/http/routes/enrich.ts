import { Hono } from "hono";
import { z } from "zod";
import { createJob } from "../../db/sqlite/repositories/jobRepository";
import { runEnrichJob } from "../../jobs/jobRunner";
import { methodNotAllowed } from "../middleware/methodNotAllowed";

const bodySchema = z.object({ max_discussions: z.number().int().positive().optional() });

export const enrichRoute = new Hono();

enrichRoute.post("/channels/:id/enrich", async (c) => {
  const channelId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: "invalid_request", details: parsed.error.flatten() }, 400);
  }

  const jobId = createJob("enrich", channelId);
  runEnrichJob(jobId, channelId, { maxDiscussions: parsed.data.max_discussions });
  return c.json({ job_id: jobId, type: "enrich", status: "queued" }, 202);
});

enrichRoute.all("/channels/:id/enrich", methodNotAllowed);
