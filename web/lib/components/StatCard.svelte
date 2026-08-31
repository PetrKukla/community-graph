<script lang="ts">
  const { label, value, hint }: { label: string; value: string | number; hint?: string } = $props();

  const display = $derived(typeof value === "number" ? value.toLocaleString("cs-CZ") : value);
</script>

<div class="flex flex-col gap-1 rounded-lg border border-border bg-card p-4">
  <span class="text-xs text-muted-foreground">{label}</span>
  <span class="text-2xl font-semibold tracking-tight tabular-nums">{display}</span>
  {#if hint}<span class="text-xs text-muted-foreground">{hint}</span>{/if}
</div>
