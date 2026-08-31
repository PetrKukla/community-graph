import { Hono } from 'hono';
import { createJob } from '../../db/sqlite/repositories/jobRepository';
import { runClusterJob } from '../../jobs/jobRunner';
import { methodNotAllowed } from '../middleware/methodNotAllowed';

export const clusterizeRoute = new Hono();

clusterizeRoute.post('/channels/:id/clusterize', (c) => {
  const channelId = c.req.param('id');
  const jobId = createJob('cluster', channelId);
  runClusterJob(jobId, channelId);
  return c.json({ job_id: jobId, type: 'cluster', status: 'queued' }, 202);
});

clusterizeRoute.all('/channels/:id/clusterize', methodNotAllowed);
