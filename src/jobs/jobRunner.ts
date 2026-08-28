import { LocalTransformersEmbeddingAdapter } from "../adapters/embedding/LocalTransformersEmbeddingAdapter";
import { clusterChannel } from "./clusterStage";
import { markJobRunning, markJobCompleted, markJobFailed } from "../db/sqlite/repositories/jobRepository";

const embeddingProvider = new LocalTransformersEmbeddingAdapter();

export function runClusterJob(jobId: string, channelId: string): void {
  markJobRunning(jobId);
  clusterChannel(channelId, embeddingProvider)
    .then((result) => markJobCompleted(jobId, { ...result }))
    .catch((err) => markJobFailed(jobId, err instanceof Error ? err.message : String(err)));
}
