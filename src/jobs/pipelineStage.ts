import type { IngestResult } from '../db/sqlite/repositories/ingestRepository';
import type { ClusterChannelResult } from './clusterStage';
import type { EnrichChannelResult } from './enrichStage';
import type { GraphWriteChannelResult } from './graphWriteStage';

export type PipelineStageName = 'cluster' | 'enrich' | 'graph_write';

export interface PipelineChannelOptions {
  maxMessages?: number;
  maxDiscussions?: number;
  skipGraphWrite?: boolean;
}

/** Combined result of one pipeline job. Stages that ran get a block; the rest stay undefined. */
export interface PipelineResult {
  ingest?: IngestResult;
  cluster?: ClusterChannelResult;
  enrich?: EnrichChannelResult;
  graphWrite?: GraphWriteChannelResult;
}

/** The three graph-side stages, already bound to their providers by the caller. */
export interface PipelineStages {
  cluster: (
    channelId: string,
    opts: { maxMessages?: number }
  ) => Promise<ClusterChannelResult>;
  enrich: (
    channelId: string,
    opts: { maxDiscussions?: number }
  ) => Promise<EnrichChannelResult>;
  graphWrite: (
    channelId: string,
    opts: { maxDiscussions?: number }
  ) => Promise<GraphWriteChannelResult>;
}

export interface PipelineHooks {
  /** Called after each stage finishes, with the result accumulated so far (for partial persistence + progress). */
  onStageComplete?: (stage: PipelineStageName, result: PipelineResult) => void;
}

/** Carries which stage failed so the job can put its name in `error` and keep the partial result. */
export class PipelineStageError extends Error {
  constructor(
    readonly stage: PipelineStageName,
    readonly reason: unknown
  ) {
    super(
      `${stage}: ${reason instanceof Error ? reason.message : String(reason)}`
    );
    this.name = 'PipelineStageError';
  }
}

/**
 * Runs clusterize -> enrich -> (graph-write) in sequence over one channel, reusing the existing
 * stage functions. On a stage failure it throws PipelineStageError; every stage that completed
 * before that has already been handed to `hooks.onStageComplete`, so the caller can persist it.
 */
export async function executePipeline(
  channelId: string,
  stages: PipelineStages,
  options: PipelineChannelOptions,
  seed: PipelineResult = {},
  hooks: PipelineHooks = {}
): Promise<PipelineResult> {
  const result: PipelineResult = { ...seed };

  async function step(
    stage: PipelineStageName,
    key: keyof PipelineResult,
    run: () => Promise<unknown>
  ): Promise<void> {
    try {
      Object.assign(result, { [key]: await run() });
    } catch (err) {
      throw new PipelineStageError(stage, err);
    }
    hooks.onStageComplete?.(stage, { ...result });
  }

  await step('cluster', 'cluster', () =>
    stages.cluster(channelId, { maxMessages: options.maxMessages })
  );
  await step('enrich', 'enrich', () =>
    stages.enrich(channelId, { maxDiscussions: options.maxDiscussions })
  );
  if (!options.skipGraphWrite) {
    await step('graph_write', 'graphWrite', () =>
      stages.graphWrite(channelId, { maxDiscussions: options.maxDiscussions })
    );
  }

  return result;
}
