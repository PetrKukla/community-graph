import type { JobType } from "./../types";

export const JOB_TYPE_LABELS: Record<JobType, string> = {
  cluster: "clusterizace",
  enrich: "enrichment",
  graph_write: "zápis do grafu",
  name_sync: "synchronizace názvů",
  pipeline: "celá pipeline",
};

export function jobTypeLabel(type: string): string {
  return JOB_TYPE_LABELS[type as JobType] ?? type;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** Compact `in / out` token string, or "—" when neither is known. */
export function formatTokens(input: number | null, output: number | null): string {
  if (input == null && output == null) return "—";
  return `${input ?? "?"} / ${output ?? "?"}`;
}

/** Hover text for a token cell. Empty when there is nothing to show. */
export function tokensTitle(input: number | null, output: number | null): string {
  if (input == null && output == null) return "";
  return `${input ?? "?"} tokenů vstup · ${output ?? "?"} tokenů výstup`;
}
