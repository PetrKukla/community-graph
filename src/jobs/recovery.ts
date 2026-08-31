import {
  getInterruptedJobs,
  markJobFailed
} from '../db/sqlite/repositories/jobRepository';
import type { DictionaryNames } from '../core/ports/GraphStore';
import type { PipelineChannelOptions } from './pipelineStage';
import {
  runClusterJob,
  runEnrichJob,
  runGraphWriteJob,
  runNameSyncJob,
  runPipelineJob
} from './jobRunner';

/**
 * The in-process job runner loses its work when the app stops - a `pending` / `running` row is
 * then orphaned forever. On boot we re-dispatch each one through its normal runner. Every stage
 * is idempotent (it only touches rows still at the earlier `processed` / `status`), so a plain
 * re-run resumes where the crash left off; the `params` column carries what the request had
 * that the row alone doesn't (stage options, the name_sync payload).
 */
export function recoverInterruptedJobs(): void {
  const stuck = getInterruptedJobs();
  if (stuck.length === 0) return;

  let requeued = 0;
  let dropped = 0;

  for (const job of stuck) {
    const params = job.params ?? {};
    try {
      switch (job.type) {
        case 'cluster':
          requireChannel(job.channelId);
          runClusterJob(job.id, job.channelId);
          requeued++;
          break;
        case 'enrich':
          requireChannel(job.channelId);
          runEnrichJob(job.id, job.channelId, {
            maxDiscussions: numberOrUndefined(params.maxDiscussions)
          });
          requeued++;
          break;
        case 'graph_write':
          requireChannel(job.channelId);
          runGraphWriteJob(job.id, job.channelId, {
            maxDiscussions: numberOrUndefined(params.maxDiscussions)
          });
          requeued++;
          break;
        case 'pipeline':
          requireChannel(job.channelId);
          runPipelineJob(
            job.id,
            job.channelId,
            undefined,
            (params.options as PipelineChannelOptions | undefined) ?? {}
          );
          requeued++;
          break;
        case 'name_sync':
          if (params.names) {
            runNameSyncJob(job.id, params.names as DictionaryNames);
            requeued++;
          } else {
            markJobFailed(
              job.id,
              'přerušeno restartem aplikace; spusť POST /api/v1/dictionary/graph-resync'
            );
            dropped++;
          }
          break;
        default:
          markJobFailed(
            job.id,
            `přerušeno restartem aplikace (neznámý typ '${job.type}')`
          );
          dropped++;
      }
    } catch (err) {
      markJobFailed(
        job.id,
        `obnova po restartu selhala: ${err instanceof Error ? err.message : String(err)}`
      );
      dropped++;
    }
  }

  console.log(
    `[jobs] po restartu: ${requeued} jobů znovu spuštěno, ${dropped} označeno jako failed`
  );
}

function requireChannel(channelId: string | null): asserts channelId is string {
  if (!channelId) throw new Error('job bez channel_id');
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}
