<script lang="ts">
  import Card from "$lib/components/ui/Card.svelte";
  import QueryBoundary from "$lib/components/QueryBoundary.svelte";
  import BarList from "$lib/components/charts/BarList.svelte";
  import Sparkline from "$lib/components/charts/Sparkline.svelte";
  import { statsQuery } from "$lib/api/queries";
  import { formatMs } from "$lib/labels";

  const stats = statsQuery();
  const d = $derived($stats.data);

  const CHART_HUES = [
    "var(--chart-1)",
    "var(--chart-2)",
    "var(--chart-3)",
    "var(--chart-4)",
    "var(--chart-5)",
    "var(--chart-6)",
    "var(--chart-7)",
  ];

  const SENTIMENT_COLOR: Record<string, string> = {
    positive: "var(--success)",
    neutral: "var(--muted-foreground)",
    negative: "var(--destructive)",
    mixed: "var(--warning)",
  };

  const messagesPerChannel = $derived(
    (d?.messages_per_channel ?? []).map((c) => ({ label: c.name ?? c.channel_id, value: c.count })),
  );
  const histogram = $derived((d?.cluster_size_histogram ?? []).map((b) => ({ label: b.bucket, value: b.count })));
  const discussionTypes = $derived(
    (d?.discussion_types ?? []).map((t, i) => ({ label: t.type, value: t.count, color: CHART_HUES[i % CHART_HUES.length] })),
  );
  const sentiment = $derived(
    (d?.sentiment ?? []).map((s) => ({ label: s.label, value: s.count, color: SENTIMENT_COLOR[s.label] ?? "var(--primary)" })),
  );
  const topTopics = $derived((d?.top_topics ?? []).map((t) => ({ label: t.name, value: t.count })));
  const topEntities = $derived(
    (d?.top_entities ?? []).map((e) => ({ label: `${e.name} · ${e.type}`, value: e.count })),
  );
  const callsSeries = $derived(
    (d?.llm_timeseries ?? []).map((p) => ({ label: p.ts_bucket.replace("T", " "), value: p.calls })),
  );
  const latencySeries = $derived(
    (d?.llm_timeseries ?? []).map((p) => ({ label: p.ts_bucket.replace("T", " "), value: Math.round(p.avg_ms) })),
  );
</script>

<QueryBoundary
  isPending={$stats.isPending}
  isError={$stats.isError}
  error={$stats.error}
  onRetry={() => $stats.refetch()}
>
  <div class="grid gap-6 lg:grid-cols-2">
    <Card title="Zprávy podle kanálů">
      <BarList items={messagesPerChannel} />
    </Card>

    <Card title="Velikost clusterů" description="Počet diskuzí podle počtu zpráv">
      <BarList items={histogram} labelWidth="3.5rem" />
    </Card>

    <Card title="LLM volání / min" description="posledních 30 minut">
      <Sparkline points={callsSeries} />
    </Card>

    <Card title="LLM doba generace" description="průměr za minutu">
      <Sparkline points={latencySeries} unit=" ms" format={(n) => formatMs(n)} />
    </Card>

    <Card title="Typy diskuzí">
      <BarList items={discussionTypes} />
    </Card>

    <Card title="Sentiment">
      <BarList items={sentiment} />
    </Card>

    <Card title="Top témata">
      <BarList items={topTopics} />
    </Card>

    <Card title="Top entity">
      <BarList items={topEntities} labelWidth="12rem" />
    </Card>

    <Card title="Kanály" class="lg:col-span-2">
      {#if (d?.clusters_per_channel.length ?? 0) === 0}
        <p class="text-sm text-muted-foreground">Zatím žádné clustery.</p>
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="text-left text-xs text-muted-foreground">
              <tr class="border-b border-border">
                <th class="py-2 pr-4 font-medium">Kanál</th>
                <th class="py-2 pr-4 font-medium">Diskuze</th>
                <th class="py-2 pr-4 font-medium">Zprávy</th>
                <th class="py-2 font-medium">Ø zpráv / diskuze</th>
              </tr>
            </thead>
            <tbody>
              {#each d?.clusters_per_channel ?? [] as c (c.channel_id)}
                <tr class="border-b border-border/60 last:border-0">
                  <td class="py-2 pr-4 font-medium">{c.name ?? c.channel_id}</td>
                  <td class="py-2 pr-4 tabular-nums">{c.discussions.toLocaleString("cs-CZ")}</td>
                  <td class="py-2 pr-4 tabular-nums">{c.messages.toLocaleString("cs-CZ")}</td>
                  <td class="py-2 tabular-nums">{c.avg_messages_per_discussion.toLocaleString("cs-CZ")}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </Card>
  </div>
</QueryBoundary>
