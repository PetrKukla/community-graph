import { createInfiniteQuery, createQuery } from '@tanstack/svelte-query';
import { toStore } from 'svelte/store';
import { apiFetch } from './client';
import type {
  DiscussionBundle,
  GraphView,
  GraphViewNode,
  JobDetail,
  JobSummary,
  LlmCall,
  Paginated,
  QueryAnswer,
  QueryFilters,
  Stats
} from '../../types';

function qs(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(
    params as Record<string, unknown>
  )) {
    if (value !== undefined && value !== null && value !== '')
      search.set(key, String(value));
  }
  const str = search.toString();
  return str ? `?${str}` : '';
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
      queryKey: ['jobs', filters()] as const,
      queryFn: () => apiFetch<JobSummary[]>(`/api/v1/jobs${qs(filters())}`),
      refetchInterval: 15_000 // polling fallback if the WS is down
    }))
  );
}

export function jobQuery(id: () => string) {
  return createQuery(
    toStore(() => ({
      queryKey: ['job', id()] as const,
      queryFn: () => apiFetch<JobDetail>(`/api/v1/jobs/${id()}`),
      enabled: id().length > 0
    }))
  );
}

export function statsQuery() {
  return createQuery({
    queryKey: ['stats'] as const,
    queryFn: () => apiFetch<Stats>('/api/v1/stats'),
    staleTime: 15_000,
    refetchInterval: 30_000
  });
}

export interface AiCallFilters {
  status?: string;
  model?: string;
  job_id?: string;
  channel_id?: string;
}

export interface GraphOverviewFilters {
  channel_id?: string;
  limit?: number;
}

export function graphOverviewQuery(filters: () => GraphOverviewFilters) {
  return createQuery(
    toStore(() => ({
      queryKey: ['graph', 'overview', filters()] as const,
      queryFn: () =>
        apiFetch<GraphView>(`/api/v1/graph/overview${qs(filters())}`),
      staleTime: 60_000,
      retry: false // a 503 (Neo4j not configured) shouldn't be retried
    }))
  );
}

export function fetchNeighbors(id: string, limit = 40): Promise<GraphView> {
  return apiFetch<GraphView>(
    `/api/v1/graph/node/${encodeURIComponent(id)}/neighbors?limit=${limit}`
  );
}

export function searchGraph(q: string): Promise<{ nodes: GraphViewNode[] }> {
  return apiFetch<{ nodes: GraphViewNode[] }>(
    `/api/v1/graph/search${qs({ q })}`
  );
}

// --- Část 4.3: dotazování na webu -------------------------------------------

export interface AskPayload {
  question: string;
  filters?: QueryFilters;
}

/** POST /api/v1/query - it's an action, not a cacheable read, so the caller wraps it in a mutation. */
export function askQuestion(payload: AskPayload): Promise<QueryAnswer> {
  return apiFetch<QueryAnswer>('/api/v1/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

export function fetchDiscussionBundle(id: string): Promise<DiscussionBundle> {
  return apiFetch<DiscussionBundle>(
    `/api/v1/discussions/${encodeURIComponent(id)}`
  );
}

/** Domain id -> Neo4j elementId for the "otevřít v grafu" deep-link. */
export function resolveGraphNode(
  label: string,
  id: string
): Promise<{ element_id: string }> {
  return apiFetch<{ element_id: string }>(
    `/api/v1/graph/node/by-domain-id${qs({ label, id })}`
  );
}

/** Paginated llm_calls history for the AI view (keyset cursor). */
export function aiCallsQuery(filters: () => AiCallFilters) {
  return createInfiniteQuery(
    toStore(() => ({
      queryKey: ['ai', 'calls', filters()] as const,
      queryFn: ({ pageParam }: { pageParam: string | null }) =>
        apiFetch<Paginated<LlmCall>>(
          `/api/v1/ai/calls${qs({ ...filters(), limit: '50', cursor: pageParam ?? undefined })}`
        ),
      initialPageParam: null as string | null,
      getNextPageParam: (last: Paginated<LlmCall>) => last.next_cursor
    }))
  );
}
