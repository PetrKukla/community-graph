import { Hono } from 'hono';
import {
  getLlmCall,
  listLlmCalls
} from '../../db/sqlite/repositories/llmCallRepository';
import { methodNotAllowed } from '../middleware/methodNotAllowed';

export const aiCallsRoute = new Hono();

// Paginated, newest-first listing of llm_calls for the AI view.
aiCallsRoute.get('/ai/calls', (c) => {
  const limitRaw = Number(c.req.query('limit'));
  const result = listLlmCalls({
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50,
    status: c.req.query('status'),
    model: c.req.query('model'),
    jobId: c.req.query('job_id'),
    channelId: c.req.query('channel_id'),
    cursor: c.req.query('cursor')
  });
  return c.json(result);
});

aiCallsRoute.all('/ai/calls', methodNotAllowed);

// One call with its full system/user prompt and raw response - the AI view's row detail.
aiCallsRoute.get('/ai/calls/:id', (c) => {
  const call = getLlmCall(c.req.param('id'));
  if (!call) return c.json({ error: 'not_found' }, 404);
  return c.json(call);
});

aiCallsRoute.all('/ai/calls/:id', methodNotAllowed);
