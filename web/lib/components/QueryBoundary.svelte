<script lang="ts">
  import type { Snippet } from "svelte";
  import Button from "$lib/components/ui/Button.svelte";
  import Skeleton from "$lib/components/ui/Skeleton.svelte";

  const {
    isPending,
    isError,
    error,
    isEmpty = false,
    emptyText = "Zatím tu nic není.",
    onRetry,
    skeleton,
    children,
  }: {
    isPending: boolean;
    isError: boolean;
    error?: unknown;
    isEmpty?: boolean;
    emptyText?: string;
    onRetry?: () => void;
    skeleton?: Snippet;
    children: Snippet;
  } = $props();

  const message = $derived(error instanceof Error ? error.message : error ? String(error) : "Načtení selhalo.");
</script>

{#if isPending}
  {#if skeleton}
    {@render skeleton()}
  {:else}
    <div class="flex flex-col gap-2">
      <Skeleton class="h-8 w-full" />
      <Skeleton class="h-8 w-full" />
      <Skeleton class="h-8 w-2/3" />
    </div>
  {/if}
{:else if isError}
  <div class="flex flex-col items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm">
    <p class="text-destructive">{message}</p>
    {#if onRetry}<Button onclick={onRetry}>Zkusit znovu</Button>{/if}
  </div>
{:else if isEmpty}
  <p class="text-sm text-muted-foreground">{emptyText}</p>
{:else}
  {@render children()}
{/if}
