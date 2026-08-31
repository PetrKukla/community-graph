import { createInfiniteQuery, createQuery } from "@tanstack/svelte-query";
import { toStore } from "svelte/store";
import { apiFetch } from "./client";
import type { JobDetail, JobSummary, LlmCall, Paginated, Stats } from "../../types";

function qs(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const str = search.toString();
  return str ? `?${str}` : "";
}

export interface JobFilters {
  status?: string;
  type?: string;
  channel_id?: string;
}

/** Live job list. `filters` is a getter so the query re-runs when the UI filter changes. */
export function jobsQuery(filters: () => JobFilters) {
  return createQuery(
    toStore(() => ({
      queryKey: ["jobs", filters()] as const,
      queryFn: () => apiFetch<JobSummary[]>(`/api/v1/jobs${qs(filters())}`),
      refetchInterval: 15_000, // polling fallback if the WS is down
    })),
  );
}

export function jobQuery(id: () => string) {
  return createQuery(
    toStore(() => ({
      queryKey: ["job", id()] as const,
      queryFn: () => apiFetch<JobDetail>(`/api/v1/jobs/${id()}`),
      enabled: id().length > 0,
    })),
  );
}

export function statsQuery() {
  return createQuery({
    queryKey: ["stats"] as const,
    queryFn: () => apiFetch<Stats>("/api/v1/stats"),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

export interface AiCallFilters {
  status?: string;
  model?: string;
  job_id?: string;
  channel_id?: string;
}

/** Paginated llm_calls history for the AI view (keyset cursor). */
export function aiCallsQuery(filters: () => AiCallFilters) {
  return createInfiniteQuery(
    toStore(() => ({
      queryKey: ["ai", "calls", filters()] as const,
      queryFn: ({ pageParam }: { pageParam: string | null }) =>
        apiFetch<Paginated<LlmCall>>(
          `/api/v1/ai/calls${qs({ ...filters(), limit: "50", cursor: pageParam ?? undefined })}`,
        ),
      initialPageParam: null as string | null,
      getNextPageParam: (last: Paginated<LlmCall>) => last.next_cursor,
    })),
  );
}
