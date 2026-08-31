<script lang="ts">
  import Card from "$lib/components/ui/Card.svelte";
  import Button from "$lib/components/ui/Button.svelte";
  import StatCard from "$lib/components/StatCard.svelte";
  import QueryBoundary from "$lib/components/QueryBoundary.svelte";
  import RelativeTime from "$lib/components/RelativeTime.svelte";
  import { statsQuery, aiCallsQuery } from "$lib/api/queries";
  import { liveLlmCalls } from "$lib/realtime/live.svelte";
  import { formatMs, formatTokens, tokensTitle } from "$lib/labels";

  const stats = statsQuery();

  let status = $state<"" | "ok" | "error">("");
  let model = $state("");
  const calls = aiCallsQuery(() => ({ status: status || undefined, model: model || undefined }));
  const rows = $derived(($calls.data?.pages ?? []).flatMap((p) => p.items));

  const llm = $derived($stats.data?.llm);
  const series = $derived($stats.data?.llm_timeseries ?? []);
  const callsPerMin = $derived(series.length > 0 ? (series.at(-1)?.calls ?? 0) : 0);

  const models = $derived([...new Set((llm?.by_model ?? []).map((m) => m.model))]);
  const selectClass =
    "h-8 rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
</script>

<div class="flex flex-col gap-6">
  <section class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
    <StatCard label="Volání celkem" value={llm?.total_calls ?? 0} />
    <StatCard label="Chybovost" value={`${Math.round((llm?.error_rate ?? 0) * 100)} %`} />
    <StatCard label="Průměr" value={formatMs(llm?.avg_ms ?? 0)} />
    <StatCard label="p50" value={formatMs(llm?.p50_ms ?? 0)} />
    <StatCard label="p95" value={formatMs(llm?.p95_ms ?? 0)} />
    <StatCard label="Volání / min" value={callsPerMin} hint="poslední minuta" />
  </section>

  <Card title="Podle modelu">
    <QueryBoundary
      isPending={$stats.isPending}
      isError={$stats.isError}
      error={$stats.error}
      isEmpty={(llm?.by_model.length ?? 0) === 0}
      emptyText="Zatím žádná LLM volání."
      onRetry={() => $stats.refetch()}
    >
      <table class="w-full text-sm">
        <thead class="text-left text-xs text-muted-foreground">
          <tr class="border-b border-border">
            <th class="py-2 pr-4 font-medium">Model</th>
            <th class="py-2 pr-4 font-medium">Volání</th>
            <th class="py-2 pr-4 font-medium">Průměr</th>
            <th class="py-2 font-medium">p95</th>
          </tr>
        </thead>
        <tbody>
          {#each llm?.by_model ?? [] as m (m.model)}
            <tr class="border-b border-border/60 last:border-0">
              <td class="py-2 pr-4 font-medium">{m.model}</td>
              <td class="py-2 pr-4 tabular-nums">{m.calls.toLocaleString("cs-CZ")}</td>
              <td class="py-2 pr-4 tabular-nums">{formatMs(m.avg_ms)}</td>
              <td class="py-2 tabular-nums">{formatMs(m.p95_ms)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </QueryBoundary>
  </Card>

  <Card title="Stream volání" description={`${liveLlmCalls.items.length} v tomto sezení`}>
    {#snippet actions()}
      <select class={selectClass} bind:value={status} aria-label="Stav volání">
        <option value="">Vše</option>
        <option value="ok">ok</option>
        <option value="error">chyba</option>
      </select>
      <select class={selectClass} bind:value={model} aria-label="Model">
        <option value="">Všechny modely</option>
        {#each models as m (m)}<option value={m}>{m}</option>{/each}
      </select>
    {/snippet}

    <QueryBoundary
      isPending={$calls.isPending}
      isError={$calls.isError}
      error={$calls.error}
      isEmpty={rows.length === 0}
      emptyText="Žádná volání neodpovídají filtru."
      onRetry={() => $calls.refetch()}
    >
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-left text-xs text-muted-foreground">
            <tr class="border-b border-border">
              <th class="py-2 pr-4 font-medium">Kdy</th>
              <th class="py-2 pr-4 font-medium">Model</th>
              <th class="py-2 pr-4 font-medium">Kontext</th>
              <th class="py-2 pr-4 font-medium">Doba</th>
              <th class="py-2 pr-4 font-medium" title="vstup / výstup">Tokeny</th>
              <th class="py-2 font-medium">Stav</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as call (call.id)}
              <tr class="border-b border-border/60 last:border-0">
                <td class="py-2 pr-4 whitespace-nowrap text-muted-foreground"><RelativeTime value={call.started_at} /></td>
                <td class="py-2 pr-4 font-medium">{call.model}</td>
                <td class="py-2 pr-4 max-w-[22rem] truncate text-muted-foreground" title={call.context ?? ""}>
                  {call.context ?? "—"}
                </td>
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
</div>
