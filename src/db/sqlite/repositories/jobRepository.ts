import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { bus } from "../../../core/events/bus";
import { db } from "../client";
import { jobs } from "../schema";

export type JobType = "cluster" | "enrich" | "graph_write" | "name_sync";
export type JobStatus = "pending" | "running" | "completed" | "failed";

export function createJob(type: JobType, channelId: string | null): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(jobs)
    .values({ id, type, status: "pending", channelId, createdAt: now, updatedAt: now })
    .run();
  bus.emit("job.created", { id, type, channel_id: channelId, created_at: now });
  return id;
}

/** Re-read the job and broadcast its current state on the bus. */
function emitJobUpdated(id: string): void {
  const job = getJob(id);
  if (!job) return;
  bus.emit("job.updated", {
    id: job.id,
    status: job.status,
    progress: { current: job.progressCurrent, total: job.progressTotal },
    result: job.result ?? undefined,
    error: job.error ?? undefined,
    updated_at: job.updatedAt,
  });
}

export function markJobRunning(id: string) {
  const now = new Date().toISOString();
  db.update(jobs).set({ status: "running", startedAt: now, updatedAt: now }).where(eq(jobs.id, id)).run();
  emitJobUpdated(id);
}

export function markJobCompleted(id: string, result: Record<string, unknown>) {
  const now = new Date().toISOString();
  db.update(jobs).set({ status: "completed", result, finishedAt: now, updatedAt: now }).where(eq(jobs.id, id)).run();
  emitJobUpdated(id);
}

export function markJobFailed(id: string, error: string) {
  const now = new Date().toISOString();
  db.update(jobs).set({ status: "failed", error, finishedAt: now, updatedAt: now }).where(eq(jobs.id, id)).run();
  emitJobUpdated(id);
}

export function getJob(id: string) {
  return db.select().from(jobs).where(eq(jobs.id, id)).get();
}

export function listJobs(filter: { status?: string; channelId?: string; type?: string }) {
  const conditions = [];
  if (filter.status) conditions.push(eq(jobs.status, filter.status));
  if (filter.channelId) conditions.push(eq(jobs.channelId, filter.channelId));
  if (filter.type) conditions.push(eq(jobs.type, filter.type));
  return db
    .select()
    .from(jobs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .all();
}
