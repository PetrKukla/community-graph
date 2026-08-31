import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

process.env.SQLITE_PATH = join(tmpdir(), `cg-recovery-${randomUUID()}.sqlite`);
process.env.API_KEY ??= "test-key";

const { db, runMigrations } = await import("../../src/db/sqlite/client");
const { jobs } = await import("../../src/db/sqlite/schema");
const { createJob, getJob } = await import("../../src/db/sqlite/repositories/jobRepository");
const { recoverInterruptedJobs } = await import("../../src/jobs/recovery");

runMigrations();

function forceStatus(id: string, status: "pending" | "running"): void {
  db.update(jobs).set({ status }).where(eq(jobs.id, id)).run();
}

async function waitTerminal(id: string, timeoutMs = 4000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const s = getJob(id)?.status ?? "";
    if (s === "completed" || s === "failed") return s;
    if (Date.now() - start > timeoutMs) return `TIMEOUT(${s})`;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("recoverInterruptedJobs", () => {
  test("re-dispatches a running cluster job (empty channel -> completes)", async () => {
    const id = createJob("cluster", "chan-empty");
    forceStatus(id, "running");

    recoverInterruptedJobs();

    expect(await waitTerminal(id)).toBe("completed");
  });

  test("persists params and reaches a terminal state for a stuck pipeline job", async () => {
    const id = createJob("pipeline", "chan-x", { options: { skipGraphWrite: true, maxDiscussions: 3 } });
    expect(getJob(id)?.params).toEqual({ options: { skipGraphWrite: true, maxDiscussions: 3 } });
    forceStatus(id, "running");

    recoverInterruptedJobs();

    // enrich has no LLM creds in the test env, so it fails - but it must not stay stuck
    expect(await waitTerminal(id)).toMatch(/completed|failed/);
  });

  test("fails a name_sync job that has no saved payload", () => {
    const id = createJob("name_sync", null); // no params
    forceStatus(id, "pending");

    recoverInterruptedJobs();

    const job = getJob(id);
    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("graph-resync");
  });

  test("leaves already-terminal jobs alone", () => {
    const done = createJob("cluster", "c");
    db.update(jobs).set({ status: "completed" }).where(eq(jobs.id, done)).run();

    recoverInterruptedJobs();

    expect(getJob(done)?.status).toBe("completed");
  });
});
