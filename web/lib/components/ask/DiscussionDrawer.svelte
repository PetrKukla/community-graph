<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { toStore } from "svelte/store";
  import { IconX, IconExternalLink } from "@tabler/icons-svelte";
  import Badge from "$lib/components/ui/Badge.svelte";
  import Button from "$lib/components/ui/Button.svelte";
  import QueryBoundary from "$lib/components/QueryBoundary.svelte";
  import RelativeTime from "$lib/components/RelativeTime.svelte";
  import { fetchDiscussionBundle } from "$lib/api/queries";

  const {
    discussionId,
    onClose,
    onOpenInGraph,
  }: {
    discussionId: string | null;
    onClose: () => void;
    onOpenInGraph: (discussionId: string) => void;
  } = $props();

  const bundle = createQuery(
    toStore(() => ({
      queryKey: ["discussion", discussionId] as const,
      queryFn: () => fetchDiscussionBundle(discussionId as string),
      enabled: Boolean(discussionId),
    })),
  );

  let showMessages = $state(false);
  $effect(() => {
    discussionId;
    showMessages = false;
  });

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") onClose();
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if discussionId}
  <div class="fixed inset-0 z-50 flex justify-end">
    <button type="button" class="absolute inset-0 bg-black/40" aria-label="Zavřít" onclick={onClose}></button>

    <aside class="relative flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-border bg-card shadow-xl">
      <header class="sticky top-0 flex items-start justify-between gap-3 border-b border-border bg-card px-4 py-3">
        <div class="min-w-0">
          <h2 class="truncate text-sm font-semibold tracking-tight">
            {$bundle.data?.enrichment?.title ?? "Detail diskuze"}
          </h2>
          <p class="text-xs text-muted-foreground">
            {#if $bundle.data}
              {$bundle.data.message_count} zpráv · <RelativeTime value={$bundle.data.block_start_at} />
            {/if}
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <Button variant="ghost" onclick={() => onOpenInGraph(discussionId)}>
            <IconExternalLink size={15} /> Graf
          </Button>
          <button
            type="button"
            class="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label="Zavřít"
            onclick={onClose}
          >
            <IconX size={16} />
          </button>
        </div>
      </header>

      <div class="flex flex-col gap-4 px-4 py-4">
        <QueryBoundary
          isPending={$bundle.isPending}
          isError={$bundle.isError}
          error={$bundle.error}
          onRetry={() => $bundle.refetch()}
        >
          {@const d = $bundle.data}
          {#if d}
            {#if d.enrichment}
              {#if d.enrichment.summary}
                <p class="text-sm leading-relaxed">{d.enrichment.summary}</p>
              {/if}

              <div class="flex flex-wrap gap-1.5">
                {#if d.enrichment.discussion_type}<Badge variant="outline">{d.enrichment.discussion_type}</Badge>{/if}
                {#if d.enrichment.sentiment}<Badge variant="secondary">{d.enrichment.sentiment}</Badge>{/if}
                {#if d.enrichment.resolved != null}
                  <Badge variant={d.enrichment.resolved ? "success" : "warning"}>
                    {d.enrichment.resolved ? "vyřešeno" : "nevyřešeno"}
                  </Badge>
                {/if}
              </div>

              {#if d.enrichment.key_points?.length}
                <div>
                  <h3 class="mb-1 text-xs font-medium text-muted-foreground">Klíčové body</h3>
                  <ul class="list-disc pl-5 text-sm">
                    {#each d.enrichment.key_points as point (point)}<li>{point}</li>{/each}
                  </ul>
                </div>
              {/if}

              {#if d.enrichment.topics?.length}
                <div class="flex flex-wrap gap-1.5">
                  {#each d.enrichment.topics as topic (topic)}<Badge variant="outline">{topic}</Badge>{/each}
                </div>
              {/if}
            {:else}
              <p class="text-sm text-muted-foreground">Diskuze zatím nemá enrichment.</p>
            {/if}

            <div>
              <button
                type="button"
                class="text-xs font-medium text-muted-foreground hover:text-foreground"
                onclick={() => (showMessages = !showMessages)}
              >
                {showMessages ? "Skrýt" : "Zobrazit"} zprávy ({d.messages.length})
              </button>
              {#if showMessages}
                <ol class="mt-2 flex flex-col gap-2 border-l border-border pl-3">
                  {#each d.messages as m (m.id)}
                    <li class="text-sm">
                      <span class="font-medium">{m.author_label}</span>
                      <span class="ml-1 text-xs text-muted-foreground"><RelativeTime value={m.created_at} /></span>
                      <p class="whitespace-pre-wrap text-foreground/90">{m.content}</p>
                    </li>
                  {/each}
                </ol>
              {/if}
            </div>
          {/if}
        </QueryBoundary>
      </div>
    </aside>
  </div>
{/if}
