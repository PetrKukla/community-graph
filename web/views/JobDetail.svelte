<script lang="ts">
  import Card from "$lib/components/ui/Card.svelte";
  import Button from "$lib/components/ui/Button.svelte";
  import QueryBoundary from "$lib/components/QueryBoundary.svelte";
  import JobStatusBadge from "$lib/components/JobStatusBadge.svelte";
  import RelativeTime from "$lib/components/RelativeTime.svelte";
  import { jobQuery, aiCallsQuery } from "$lib/api/queries";
  import { link } from "$lib/router.svelte";
  import { jobTypeLabel, formatMs, formatTokens, tokensTitle } from "$lib/labels";

  const { params }: { params?: { id?: string } } = $props();

  const job = jobQuery(() => params?.id ?? "");
  const calls = aiCallsQuery(() => ({ job_id: params?.id ?? "" }));

  const callRows = $derived(($calls.data?.pages ?? []).flatMap((p) => p.items));
  const progress = $derived($job.data?.progress);
  const showProgress = $derived($job.data?.status === "running" && (progress?.total ?? 0) > 0);
</script>

<div class="flex flex-col gap-6">
  <a href="/jobs" use:link class="text-sm text-muted-foreground hover:underline">← Zpět na jobs</a>

  <QueryBoundary
    isPending={$job.isPending}
    isError={$job.isError}
    error={$job.error}
    onRetry={() => $job.refetch()}
  >
    {#if $job.data}
      {@const j = $job.data}
      <Card>
        {#snippet actions()}<JobStatusBadge status={j.status} />{/snippet}
        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-0.5">
            <h1 class="text-lg font-semibold tracking-tight">{jobTypeLabel(j.type)}</h1>
            <p class="font-mono text-xs text-muted-foreground">{j.id}</p>
          </div>

          <dl class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
            <div><dt class="text-xs text-muted-foreground">Kanál</dt><dd>{j.channel_id ?? "—"}</dd></div>
            <div><dt class="text-xs text-muted-foreground">Vytvořeno</dt><dd><RelativeTime value={j.created_at} /></dd></div>
            <div><dt class="text-xs text-muted-foreground">Spuštěno</dt><dd><RelativeTime value={j.started_at ?? null} /></dd></div>
            <div><dt class="text-xs text-muted-foreground">Dokončeno</dt><dd><RelativeTime value={j.finished_at ?? null} /></dd></div>
          </dl>

          {#if showProgress && progress}
            <div class="flex items-center gap-3">
              <div class="h-2 flex-1 overflow-hidden rounded bg-muted">
                <div
                  class="h-full rounded bg-primary transition-[width] duration-300"
                  style:width={`${Math.round((progress.current / progress.total) * 100)}%`}
                ></div>
              </div>
              <span class="text-xs tabular-nums text-muted-foreground">{progress.current}/{progress.total}</span>
            </div>
          {/if}

          {#if j.error}
            <div class="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {j.error}
            </div>
          {/if}
        </div>
      </Card>

      {#if j.result}
        <Card title="Výsledek">
          <pre class="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">{JSON.stringify(j.result, null, 2)}</pre>
        </Card>
      {/if}

      <Card title="Navázaná LLM volání" description="LLM volání označená tímto jobem.">
        <QueryBoundary
          isPending={$calls.isPending}
          isError={$calls.isError}
          error={$calls.error}
          isEmpty={callRows.length === 0}
          emptyText="Tento job zatím nevyvolal žádné LLM volání."
          onRetry={() => $calls.refetch()}
        >
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="text-left text-xs text-muted-foreground">
                <tr class="border-b border-border">
                  <th class="py-2 pr-4 font-medium">Model</th>
                  <th class="py-2 pr-4 font-medium">Kontext</th>
                  <th class="py-2 pr-4 font-medium">Doba</th>
                  <th class="py-2 pr-4 font-medium" title="vstup / výstup">Tokeny</th>
                  <th class="py-2 font-medium">Stav</th>
                </tr>
              </thead>
              <tbody>
                {#each callRows as call (call.id)}
                  <tr class="border-b border-border/60 last:border-0">
                    <td class="py-2 pr-4 font-medium">{call.model}</td>
                    <td class="py-2 pr-4 text-muted-foreground">{call.context ?? "—"}</td>
                    <td class="py-2 pr-4 tabular-nums">{formatMs(call.duration_ms)}</td>
                    <td
                      class="py-2 pr-4 tabular-nums text-muted-foreground"
                      title={tokensTitle(call.prompt_tokens, call.completion_tokens)}
                    >
                      {formatTokens(call.prompt_tokens, call.completion_tokens)}
                    </td>
                    <td class="py-2">
                      <span class:text-success={call.status === "ok"} class:text-destructive={call.status === "error"}>
                        {call.status === "ok" ? "ok" : "chyba"}
                      </span>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if $calls.hasNextPage}
            <div class="mt-3">
              <Button onclick={() => $calls.fetchNextPage()} disabled={$calls.isFetchingNextPage}>
                {$calls.isFetchingNextPage ? "Načítám…" : "Načíst další"}
              </Button>
            </div>
          {/if}
        </QueryBoundary>
      </Card>
    {/if}
  </QueryBoundary>
</div>
