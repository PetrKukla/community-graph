<script lang="ts">
  import type { PipelineFunnel } from "../../types";

  const { funnel }: { funnel: PipelineFunnel | null | undefined } = $props();

  const stages = $derived.by(() => {
    if (!funnel) return [];
    const max = Math.max(funnel.raw, 1);
    return [
      { key: "raw", label: "syrové", count: funnel.raw },
      { key: "clustered", label: "clusterované", count: funnel.clustered },
      { key: "enriched", label: "obohacené", count: funnel.enriched },
      { key: "graph_written", label: "v grafu", count: funnel.graph_written },
    ].map((s) => ({ ...s, pct: Math.round((s.count / max) * 100) }));
  });
</script>

<div class="flex flex-col gap-2">
  {#each stages as stage (stage.key)}
    <div class="flex items-center gap-3">
      <span class="w-28 shrink-0 text-xs text-muted-foreground">{stage.label}</span>
      <div class="h-5 flex-1 overflow-hidden rounded bg-muted">
        <div class="h-full rounded bg-primary/80 transition-[width] duration-500" style:width={`${stage.pct}%`}></div>
      </div>
      <span class="w-16 shrink-0 text-right text-sm tabular-nums">{stage.count.toLocaleString("cs-CZ")}</span>
    </div>
  {:else}
    <p class="text-sm text-muted-foreground">Zatím žádná data.</p>
  {/each}
</div>
