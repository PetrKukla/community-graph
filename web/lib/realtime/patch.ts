import type { QueryClient } from "@tanstack/svelte-query";
import type { BusEnvelope, JobDetail, Stats } from "../../types";
import { liveLlmCalls, liveTick } from "./live.svelte";

let statsInvalidateQueuedAt = 0;

/** Coalesce the stream of llm.call / ingest.batch events into at most one /stats refetch per second. */
function throttledStatsInvalidate(qc: QueryClient): void {
  const now = Date.now();
  if (now - statsInvalidateQueuedAt < 1000) return;
  statsInvalidateQueuedAt = now;
  setTimeout(() => qc.invalidateQueries({ queryKey: ["stats"] }), 1000);
}

/**
 * Turn one realtime event into a targeted cache change. Each branch is thin: patch the one key
 * that changed, or mark a list stale so TanStack Query refetches it - never merge state by hand.
 */
export function applyEvent(qc: QueryClient, { event, data }: BusEnvelope): void {
  switch (event) {
    case "job.created": {
      qc.invalidateQueries({ queryKey: ["jobs"] });
      break;
    }
    case "job.updated": {
      qc.setQueryData<JobDetail>(["job", data.id], (prev) =>
        prev
          ? {
              ...prev,
              status: data.status,
              progress: data.progress,
              result: data.result ?? prev.result,
              error: data.error ?? prev.error,
              updated_at: data.updated_at,
            }
          : prev,
      );
      qc.invalidateQueries({ queryKey: ["jobs"] });
      break;
    }
    case "llm.call": {
      liveLlmCalls.push(data);
      qc.invalidateQueries({ queryKey: ["ai", "calls"] });
      throttledStatsInvalidate(qc);
      break;
    }
    case "ingest.batch": {
      throttledStatsInvalidate(qc);
      break;
    }
    case "stats.tick": {
      liveTick.funnel = data.funnel;
      liveTick.totals = data.totals;
      qc.setQueryData<Stats>(["stats"], (prev) =>
        prev ? { ...prev, funnel: data.funnel, totals: data.totals } : prev,
      );
      break;
    }
  }
}
