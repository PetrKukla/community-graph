import { Hono } from "hono";
import { listLlmCalls } from "../../db/sqlite/repositories/llmCallRepository";
import { methodNotAllowed } from "../middleware/methodNotAllowed";

export const aiCallsRoute = new Hono();

// Paginated, newest-first listing of llm_calls for the AI view.
aiCallsRoute.get("/ai/calls", (c) => {
  const limitRaw = Number(c.req.query("limit"));
  const result = listLlmCalls({
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50,
    status: c.req.query("status"),
    model: c.req.query("model"),
    jobId: c.req.query("job_id"),
    channelId: c.req.query("channel_id"),
    cursor: c.req.query("cursor"),
  });
  return c.json(result);
});

aiCallsRoute.all("/ai/calls", methodNotAllowed);
