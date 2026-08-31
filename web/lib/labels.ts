import type { JobType } from "./../types";

export const JOB_TYPE_LABELS: Record<JobType, string> = {
  cluster: "clusterizace",
  enrich: "enrichment",
  graph_write: "zápis do grafu",
};

export function jobTypeLabel(type: string): string {
  return JOB_TYPE_LABELS[type as JobType] ?? type;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}
