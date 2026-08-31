<script lang="ts">
  import { searchGraph } from "$lib/api/queries";
  import { NODE_LABELS, NODE_LABEL_CS, nodeColor } from "$lib/graph/labels";
  import type { GraphViewNode } from "../../../types";

  const {
    channels,
    channelId,
    onChannelChange,
    hiddenLabels,
    onToggleLabel,
    onPick,
  }: {
    channels: { id: string; name: string }[];
    channelId: string;
    onChannelChange: (id: string) => void;
    hiddenLabels: Set<string>;
    onToggleLabel: (label: string) => void;
    onPick: (node: GraphViewNode) => void;
  } = $props();

  let query = $state("");
  let results = $state<GraphViewNode[]>([]);
  let open = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function onInput(): void {
    clearTimeout(timer);
    const q = query.trim();
    if (q.length < 2) {
      results = [];
      open = false;
      return;
    }
    timer = setTimeout(async () => {
      try {
        results = (await searchGraph(q)).nodes;
        open = results.length > 0;
      } catch {
        results = [];
        open = false;
      }
    }, 250);
  }

  function pick(node: GraphViewNode): void {
    onPick(node);
    open = false;
    query = node.caption;
  }

  const selectClass =
    "h-8 rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
</script>

<div class="absolute left-3 top-3 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/90 p-2 backdrop-blur">
  <select
    class={selectClass}
    value={channelId}
    onchange={(e) => onChannelChange((e.currentTarget as HTMLSelectElement).value)}
    aria-label="Kanál"
  >
    <option value="">Všechny kanály</option>
    {#each channels as ch (ch.id)}
      <option value={ch.id}>{ch.name}</option>
    {/each}
  </select>

  <div class="flex items-center gap-1">
    {#each NODE_LABELS as label (label)}
      <button
        type="button"
        class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs transition-opacity"
        class:opacity-40={hiddenLabels.has(label)}
        onclick={() => onToggleLabel(label)}
      >
        <span class="size-2 rounded-full" style:background-color={nodeColor(label)}></span>
        {NODE_LABEL_CS[label]}
      </button>
    {/each}
  </div>

  <div class="relative">
    <input
      class={`${selectClass} w-52`}
      placeholder="Hledat uzel…"
      bind:value={query}
      oninput={onInput}
      onfocus={() => (open = results.length > 0)}
    />
    {#if open}
      <ul class="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-border bg-popover shadow-md">
        {#each results as node (node.id)}
          <li>
            <button
              type="button"
              class="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-secondary"
              onclick={() => pick(node)}
            >
              <span class="size-2 shrink-0 rounded-full" style:background-color={nodeColor(node.label)}></span>
              <span class="truncate">{node.caption}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
