import { Hono } from "hono";
import { getJob, listJobs } from "../../db/sqlite/repositories/jobRepository";
import { methodNotAllowed } from "../middleware/methodNotAllowed";

export const jobsRoute = new Hono();

jobsRoute.get("/jobs/:id", (c) => {
  const job = getJob(c.req.param("id"));
  if (!job) return c.json({ error: "not_found" }, 404);
  return c.json({
    id: job.id,
    type: job.type,
    status: job.status,
    progress: { current: job.progressCurrent, total: job.progressTotal },
    result: job.result ?? undefined,
    error: job.error ?? undefined,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    started_at: job.startedAt ?? undefined,
    finished_at: job.finishedAt ?? undefined,
  });
});

jobsRoute.all("/jobs/:id", methodNotAllowed);

jobsRoute.get("/jobs", (c) => {
  const status = c.req.query("status");
  const channelId = c.req.query("channel_id");
  const type = c.req.query("type");
  const jobs = listJobs({ status, channelId, type });
  return c.json(
    jobs.map((job) => ({
      id: job.id,
      type: job.type,
      status: job.status,
      channel_id: job.channelId,
      created_at: job.createdAt,
      updated_at: job.updatedAt,
    })),
  );
});

jobsRoute.all("/jobs", methodNotAllowed);
