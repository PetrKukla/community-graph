<script lang="ts">
  type Item = { label: string; value: number; color?: string };

  const {
    items,
    format = (n: number) => n.toLocaleString("cs-CZ"),
    color = "var(--primary)",
    labelWidth = "9rem",
  }: {
    items: Item[];
    format?: (n: number) => string;
    color?: string;
    labelWidth?: string;
  } = $props();

  const max = $derived(Math.max(1, ...items.map((i) => i.value)));
</script>

{#if items.length === 0}
  <p class="text-sm text-muted-foreground">Zatím žádná data.</p>
{:else}
  <div class="flex flex-col gap-1.5">
    {#each items as item, i (i)}
      <div class="flex items-center gap-3">
        <span
          class="shrink-0 truncate text-xs text-muted-foreground"
          style:width={labelWidth}
          title={item.label}
        >
          {item.label}
        </span>
        <div class="h-5 flex-1 overflow-hidden rounded bg-muted">
          <div
            class="h-full rounded transition-[width] duration-500"
            style:width={`${Math.max(2, (item.value / max) * 100)}%`}
            style:background-color={item.color ?? color}
          ></div>
        </div>
        <span class="w-16 shrink-0 text-right text-sm tabular-nums">{format(item.value)}</span>
      </div>
    {/each}
  </div>
{/if}
