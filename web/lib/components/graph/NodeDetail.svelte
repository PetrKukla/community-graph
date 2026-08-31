<script lang="ts">
  import { fly } from "svelte/transition";
  import Badge from "$lib/components/ui/Badge.svelte";
  import { NODE_LABEL_CS } from "$lib/graph/labels";
  import type { GraphViewNode } from "../../../types";

  const { node, onClose }: { node: GraphViewNode | null; onClose: () => void } = $props();

  const entries = $derived(
    node ? Object.entries(node.props).filter(([k]) => k !== "embedding") : [],
  );

  function fmt(v: unknown): string {
    if (v == null) return "—";
    if (Array.isArray(v)) return v.join(", ");
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  }
</script>

{#if node}
  <aside
    class="absolute right-0 top-0 z-20 flex h-full w-80 flex-col border-l border-border bg-card shadow-lg"
    transition:fly={{ x: 320, duration: 180 }}
  >
    <header class="flex items-center justify-between border-b border-border px-4 py-3">
      <Badge>{NODE_LABEL_CS[node.label] ?? node.label}</Badge>
      <button
        type="button"
        class="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
        onclick={onClose}
        aria-label="Zavřít"
      >
        ✕
      </button>
    </header>
    <div class="flex flex-col gap-3 overflow-y-auto p-4">
      <div>
        <h3 class="text-sm font-semibold break-words">{node.caption}</h3>
        <p class="text-xs text-muted-foreground">stupeň {node.degree}</p>
      </div>
      <dl class="flex flex-col gap-2 text-sm">
        {#each entries as [key, value] (key)}
          <div>
            <dt class="text-xs text-muted-foreground">{key}</dt>
            <dd class="break-words">{fmt(value)}</dd>
          </div>
        {/each}
      </dl>
    </div>
  </aside>
{/if}
