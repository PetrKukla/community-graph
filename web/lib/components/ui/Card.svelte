<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils";

  const {
    title,
    description,
    actions,
    children,
    class: className,
  }: {
    title?: string;
    description?: string;
    actions?: Snippet;
    children: Snippet;
    class?: string;
  } = $props();
</script>

<section class={cn("rounded-lg border border-border bg-card text-card-foreground shadow-sm", className)}>
  {#if title || actions}
    <header class="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
      <div class="flex flex-col gap-0.5">
        {#if title}<h2 class="text-sm font-semibold tracking-tight">{title}</h2>{/if}
        {#if description}<p class="text-xs text-muted-foreground">{description}</p>{/if}
      </div>
      {#if actions}<div class="flex items-center gap-2">{@render actions()}</div>{/if}
    </header>
  {/if}
  <div class="p-4">
    {@render children()}
  </div>
</section>
