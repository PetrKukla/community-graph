<script lang="ts">
  import Card from "$lib/components/ui/Card.svelte";
  import QueryBoundary from "$lib/components/QueryBoundary.svelte";
  import JobStatusBadge from "$lib/components/JobStatusBadge.svelte";
  import RelativeTime from "$lib/components/RelativeTime.svelte";
  import { jobsQuery } from "$lib/api/queries";
  import { link } from "$lib/router.svelte";
  import { jobTypeLabel } from "$lib/labels";
  import type { JobStatus, JobType } from "../types";

  let type = $state<JobType | "">("");
  let status = $state<JobStatus | "">("");

  const jobs = jobsQuery(() => ({
    type: type || undefined,
    status: status || undefined,
  }));

  const rows = $derived(
    [...($jobs.data ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at)),
  );

  const selectClass =
    "h-8 rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
</script>

<Card title="Jobs" description="Fronta i historie clusterizace, enrichmentu a zápisu do grafu.">
  {#snippet actions()}
    <select class={selectClass} bind:value={type} aria-label="Typ jobu">
      <option value="">Všechny typy</option>
      <option value="pipeline">celá pipeline</option>
      <option value="cluster">clusterizace</option>
      <option value="enrich">enrichment</option>
      <option value="graph_write">zápis do grafu</option>
      <option value="name_sync">synchronizace názvů</option>
    </select>
    <select class={selectClass} bind:value={status} aria-label="Stav jobu">
      <option value="">Všechny stavy</option>
      <option value="pending">čeká</option>
      <option value="running">běží</option>
      <option value="completed">hotovo</option>
      <option value="failed">chyba</option>
    </select>
  {/snippet}

  <QueryBoundary
    isPending={$jobs.isPending}
    isError={$jobs.isError}
    error={$jobs.error}
    isEmpty={rows.length === 0}
    emptyText="Žádné joby neodpovídají filtru."
    onRetry={() => $jobs.refetch()}
  >
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="text-left text-xs text-muted-foreground">
          <tr class="border-b border-border">
            <th class="py-2 pr-4 font-medium">Typ</th>
            <th class="py-2 pr-4 font-medium">Kanál</th>
            <th class="py-2 pr-4 font-medium">Stav</th>
            <th class="py-2 pr-4 font-medium">Vytvořeno</th>
            <th class="py-2 font-medium">Aktualizováno</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as job (job.id)}
            <tr class="border-b border-border/60 last:border-0 hover:bg-secondary/40">
              <td class="py-2 pr-4">
                <a href={`/jobs/${job.id}`} use:link class="font-medium hover:underline">{jobTypeLabel(job.type)}</a>
              </td>
              <td class="py-2 pr-4 text-muted-foreground">{job.channel_id ?? "—"}</td>
              <td class="py-2 pr-4"><JobStatusBadge status={job.status} /></td>
              <td class="py-2 pr-4 text-muted-foreground"><RelativeTime value={job.created_at} /></td>
              <td class="py-2 text-muted-foreground"><RelativeTime value={job.updated_at} /></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </QueryBoundary>
</Card>
