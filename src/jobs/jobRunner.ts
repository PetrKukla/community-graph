import { LocalTransformersEmbeddingAdapter } from "../adapters/embedding/LocalTransformersEmbeddingAdapter";
import { getLLMProvider } from "../adapters/llm";
import { llmCallContext } from "../adapters/llm/callContext";
import { getGraphStore } from "../adapters/graph";
import { clusterChannel } from "./clusterStage";
import { enrichChannel, type EnrichChannelOptions } from "./enrichStage";
import { graphWriteChannel, type GraphWriteChannelOptions } from "./graphWriteStage";
import { nameSyncGraph } from "./nameSyncStage";
import { markJobRunning, markJobCompleted, markJobFailed } from "../db/sqlite/repositories/jobRepository";
import type { DictionaryNames } from "../core/ports/GraphStore";

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

/** Part 4.1 - large dictionary sync / graph-resync: push names onto existing Neo4j nodes. */
export function runNameSyncJob(jobId: string, names: DictionaryNames): void {
  markJobRunning(jobId);
  Promise.resolve()
    .then(() => nameSyncGraph(getGraphStore(), names))
    .then((result) => markJobCompleted(jobId, { ...result }))
    .catch((err) => markJobFailed(jobId, err instanceof Error ? err.message : String(err)));
}
