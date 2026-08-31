<script lang="ts">
  import Card from "$lib/components/ui/Card.svelte";
  import StatCard from "$lib/components/StatCard.svelte";
  import Funnel from "$lib/components/Funnel.svelte";
  import QueryBoundary from "$lib/components/QueryBoundary.svelte";
  import JobStatusBadge from "$lib/components/JobStatusBadge.svelte";
  import RelativeTime from "$lib/components/RelativeTime.svelte";
  import { statsQuery, jobsQuery } from "$lib/api/queries";
  import { link } from "$lib/router.svelte";
  import { liveTick } from "$lib/realtime/live.svelte";
  import { liveLlmCalls } from "$lib/realtime/live.svelte";
  import { jobTypeLabel, formatMs } from "$lib/labels";

  const stats = statsQuery();
  const jobs = jobsQuery(() => ({}));

  const totals = $derived(liveTick.totals ?? $stats.data?.totals ?? null);
  const funnel = $derived(liveTick.funnel ?? $stats.data?.funnel ?? null);
  const activeJobs = $derived(($jobs.data ?? []).filter((j) => j.status === "running" || j.status === "pending"));
</script>

<div class="flex flex-col gap-6">
  <section class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
    {#if totals}
      <StatCard label="Zprávy" value={totals.messages} />
      <StatCard label="Diskuze" value={totals.discussions} />
      <StatCard label="Uživatelé" value={totals.users} />
      <StatCard label="Kanály" value={totals.channels} />
      <StatCard label="Témata" value={totals.topics} />
      <StatCard label="Entity" value={totals.entities} />
    {:else}
      {#each Array.from({ length: 6 }) as _, i (i)}
        <div class="h-[86px] animate-pulse rounded-lg border border-border bg-muted"></div>
      {/each}
    {/if}
  </section>

  <div class="grid gap-6 lg:grid-cols-3">
    <Card title="Pipeline funnel" class="lg:col-span-2">
      <Funnel {funnel} />
      {#if $stats.data?.totals.last_ingested_at}
        <p class="mt-3 text-xs text-muted-foreground">
          Poslední ingest: <RelativeTime value={$stats.data.totals.last_ingested_at} />
        </p>
      {/if}
    </Card>

    <Card title="Aktivní jobs">
      <QueryBoundary
        isPending={$jobs.isPending}
        isError={$jobs.isError}
        error={$jobs.error}
        isEmpty={activeJobs.length === 0}
        emptyText="Žádný job neběží."
        onRetry={() => $jobs.refetch()}
      >
        <ul class="flex flex-col divide-y divide-border">
          {#each activeJobs as job (job.id)}
            <li class="flex items-center justify-between gap-2 py-2 text-sm">
              <a href={`/jobs/${job.id}`} use:link class="font-medium hover:underline">{jobTypeLabel(job.type)}</a>
              <div class="flex items-center gap-2 text-xs text-muted-foreground">
                <RelativeTime value={job.created_at} />
                <JobStatusBadge status={job.status} />
              </div>
            </li>
          {/each}
        </ul>
      </QueryBoundary>
    </Card>
  </div>

  <Card title="Poslední LLM volání">
    {#if liveLlmCalls.items.length === 0}
      <p class="text-sm text-muted-foreground">Zatím žádná volání v tomto sezení.</p>
    {:else}
      <ul class="flex flex-col divide-y divide-border">
        {#each liveLlmCalls.items.slice(0, 8) as call (call.id)}
          <li class="flex items-center justify-between gap-3 py-2 text-sm">
            <span class="flex items-center gap-2 truncate">
              <span
                class="size-1.5 shrink-0 rounded-full"
                class:bg-success={call.status === "ok"}
                class:bg-destructive={call.status === "error"}
              ></span>
              <span class="font-medium">{call.model}</span>
              <span class="truncate text-muted-foreground">{call.context ?? ""}</span>
            </span>
            <span class="shrink-0 tabular-nums text-muted-foreground">{formatMs(call.duration_ms)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </Card>
</div>
