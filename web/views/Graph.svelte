<script lang="ts">
  import GraphCanvas from "$lib/components/graph/GraphCanvas.svelte";
  import GraphControls from "$lib/components/graph/GraphControls.svelte";
  import NodeDetail from "$lib/components/graph/NodeDetail.svelte";
  import { graphOverviewQuery, statsQuery } from "$lib/api/queries";
  import { ApiError } from "$lib/api/client";
  import type { GraphViewNode } from "../types";

  let channelId = $state("");
  let hiddenLabels = $state(new Set<string>());
  let selected = $state<GraphViewNode | null>(null);
  let canvas = $state<
    { focusNode: (node: GraphViewNode) => void; clearSelection: () => void } | undefined
  >();

  const overview = graphOverviewQuery(() => ({ channel_id: channelId || undefined }));
  const stats = statsQuery();

  const channels = $derived(
    ($stats.data?.messages_per_channel ?? []).map((c) => ({ id: c.channel_id, name: c.name ?? c.channel_id })),
  );

  const neo4jMissing = $derived($overview.error instanceof ApiError && $overview.error.status === 503);

  function toggleLabel(label: string): void {
    const next = new Set(hiddenLabels);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    hiddenLabels = next;
  }
</script>

<div class="flex flex-col gap-3">
  <div class="flex items-center justify-between">
    <h1 class="text-lg font-semibold tracking-tight">Graf</h1>
    {#if $overview.data}
      <p class="text-xs text-muted-foreground">
        {$overview.data.nodes.length} uzlů · {$overview.data.edges.length} hran
      </p>
    {/if}
  </div>

  {#if neo4jMissing}
    <p class="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
      Grafový pohled potřebuje běžící Neo4j. Spusť <code>docker compose up -d neo4j</code>, nastav
      <code>NEO4J_PASSWORD</code> v <code>.env</code> a proveď krok <code>graph-write</code>.
    </p>
  {:else if $overview.isError}
    <p class="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
      Načtení grafu selhalo: {$overview.error instanceof Error ? $overview.error.message : "neznámá chyba"}
    </p>
  {:else}
    <div class="relative h-[calc(100vh-9rem)] overflow-hidden rounded-lg border border-border bg-card">
      <GraphControls
        {channels}
        {channelId}
        onChannelChange={(id) => (channelId = id)}
        {hiddenLabels}
        onToggleLabel={toggleLabel}
        onPick={(node) => {
          selected = node;
          canvas?.focusNode(node);
        }}
      />

      {#if $overview.isPending}
        <div class="absolute inset-0 grid place-items-center text-sm text-muted-foreground">Načítám graf…</div>
      {/if}

      <GraphCanvas
        bind:this={canvas}
        view={$overview.data}
        {hiddenLabels}
        onSelect={(node) => (selected = node)}
      />

      <NodeDetail
        node={selected}
        onClose={() => {
          selected = null;
          canvas?.clearSelection();
        }}
      />
    </div>
  {/if}
</div>
