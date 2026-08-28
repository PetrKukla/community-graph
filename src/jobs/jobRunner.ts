import { LocalTransformersEmbeddingAdapter } from "../adapters/embedding/LocalTransformersEmbeddingAdapter";
import { getLLMProvider } from "../adapters/llm";
import { clusterChannel } from "./clusterStage";
import { enrichChannel, type EnrichChannelOptions } from "./enrichStage";
import { markJobRunning, markJobCompleted, markJobFailed } from "../db/sqlite/repositories/jobRepository";

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
  // rather than throwing synchronously in the request handler
  Promise.resolve()
    .then(() => enrichChannel(channelId, getLLMProvider(), embeddingProvider, options))
    .then((result) => markJobCompleted(jobId, { ...result }))
    .catch((err) => markJobFailed(jobId, err instanceof Error ? err.message : String(err)));
}
