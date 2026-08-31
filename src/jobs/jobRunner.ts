import { LocalTransformersEmbeddingAdapter } from "../adapters/embedding/LocalTransformersEmbeddingAdapter";
import { getLLMProvider } from "../adapters/llm";
import { llmCallContext } from "../adapters/llm/callContext";
import { getGraphStore } from "../adapters/graph";
import { clusterChannel } from "./clusterStage";
import { enrichChannel, type EnrichChannelOptions } from "./enrichStage";
import { graphWriteChannel, type GraphWriteChannelOptions } from "./graphWriteStage";
import { nameSyncGraph } from "./nameSyncStage";
import { executePipeline, type PipelineChannelOptions, type PipelineResult } from "./pipelineStage";
import {
  markJobRunning,
  markJobCompleted,
  markJobFailed,
  saveJobResult,
  updateJobProgress,
} from "../db/sqlite/repositories/jobRepository";
import type { DictionaryNames } from "../core/ports/GraphStore";
import type { IngestResult } from "../db/sqlite/repositories/ingestRepository";

const embeddingProvider = new LocalTransformersEmbeddingAdapter();

export function runClusterJob(jobId: string, channelId: string): void {
  markJobRunning(jobId);
  clusterChannel(channelId, embeddingProvider)
    .then((result) => markJobCompleted(jobId, { ...result }))
    .catch((err) => markJobFailed(jobId, err instanceof Error ? err.message : String(err)));
}

export function runEnrichJob(jobId: string, channelId: string, options: EnrichChannelOptions = {}): void {
  markJobRunning(jobId);
  // resolve the provider lazily inside the chain so a missing-credentials error fails the job
  // rather than throwing synchronously in the request handler; run inside the LLM call context
  // so every llm_calls row this job produces is tagged with the job and channel.
  llmCallContext
    .run({ jobId, channelId }, () => enrichChannel(channelId, getLLMProvider(), embeddingProvider, options))
    .then((result) => markJobCompleted(jobId, { ...result }))
    .catch((err) => markJobFailed(jobId, err instanceof Error ? err.message : String(err)));
}

export function runGraphWriteJob(jobId: string, channelId: string, options: GraphWriteChannelOptions = {}): void {
  markJobRunning(jobId);
  Promise.resolve()
    .then(async () => {
      const store = getGraphStore();
      await store.bootstrap();
      return graphWriteChannel(channelId, store, options);
    })
    .then((result) => markJobCompleted(jobId, { ...result }))
    .catch((err) => markJobFailed(jobId, err instanceof Error ? err.message : String(err)));
}

/**
 * Part 4.2 - one job that runs cluster -> enrich -> (graph-write) over a channel. Ingest has
 * already happened synchronously in the request; its counts are seeded into the result.
 */
export function runPipelineJob(
  jobId: string,
  channelId: string,
  ingestResult: IngestResult | undefined,
  options: PipelineChannelOptions = {},
): void {
  markJobRunning(jobId);
  const total = options.skipGraphWrite ? 2 : 3;
  updateJobProgress(jobId, 0, total);

  const stages = {
    cluster: (id: string, o: { maxMessages?: number }) => clusterChannel(id, embeddingProvider, o),
    enrich: (id: string, o: { maxDiscussions?: number }) =>
      llmCallContext.run({ jobId, channelId: id }, () => enrichChannel(id, getLLMProvider(), embeddingProvider, o)),
    graphWrite: async (id: string, o: { maxDiscussions?: number }) => {
      const store = getGraphStore();
      await store.bootstrap();
      return graphWriteChannel(id, store, o);
    },
  };

  const seed: PipelineResult = ingestResult ? { ingest: ingestResult } : {};
  let done = 0;

  executePipeline(channelId, stages, options, seed, {
    onStageComplete: (_stage, result) => {
      done += 1;
      saveJobResult(jobId, result as Record<string, unknown>);
      updateJobProgress(jobId, done, total);
    },
  })
    .then((result) => markJobCompleted(jobId, result as Record<string, unknown>))
    .catch((err) => markJobFailed(jobId, err instanceof Error ? err.message : String(err)));
}

/** Part 4.1 - large dictionary sync / graph-resync: push names onto existing Neo4j nodes. */
export function runNameSyncJob(jobId: string, names: DictionaryNames): void {
  markJobRunning(jobId);
  Promise.resolve()
    .then(() => nameSyncGraph(getGraphStore(), names))
    .then((result) => markJobCompleted(jobId, { ...result }))
    .catch((err) => markJobFailed(jobId, err instanceof Error ? err.message : String(err)));
}
