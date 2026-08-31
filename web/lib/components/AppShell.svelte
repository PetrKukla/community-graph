<script lang="ts">
  import type { Snippet } from "svelte";
  import { location } from "svelte-spa-router";
  import { IconMoon, IconSun, IconPointFilled } from "@tabler/icons-svelte";
  import { theme } from "$lib/stores/theme.svelte";
  import { connection } from "$lib/realtime/socket.svelte";
  import { cn } from "$lib/utils";

  const { children }: { children?: Snippet } = $props();

  const nav = [
    { href: "/", label: "Přehled" },
    { href: "/jobs", label: "Jobs" },
    { href: "/ai", label: "LLM volání" },
    { href: "/stats", label: "Statistiky" },
    { href: "/graph", label: "Graf" },
  ];

  function isActive(href: string): boolean {
    const path = $location || "/";
    return href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
  }

  const connectionLabel: Record<typeof connection.status, string> = {
    connecting: "připojování",
    open: "živě",
    closed: "odpojeno",
  };
</script>

<div class="min-h-screen bg-background text-foreground">
  <header class="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
    <div class="mx-auto flex h-14 max-w-[1400px] items-center gap-4 px-4 sm:gap-6 sm:px-6">
      <a href="#/" class="shrink-0 text-sm font-semibold tracking-tight">community-graph</a>

      <nav class="flex items-center gap-1 overflow-x-auto">
        {#each nav as item (item.href)}
          <a
            href={`#${item.href}`}
            class={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors",
              isActive(item.href)
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
            )}
          >
            {item.label}
          </a>
        {/each}
      </nav>

      <div class="ml-auto flex shrink-0 items-center gap-3">
        <span
          class={cn(
            "flex items-center gap-1 text-xs",
            connection.status === "open"
              ? "text-success"
              : connection.status === "closed"
                ? "text-destructive"
                : "text-muted-foreground",
          )}
          title="Stav realtime spojení"
        >
          <IconPointFilled size={14} />
          {connectionLabel[connection.status]}
        </span>

        <button
          type="button"
          class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          onclick={() => theme.toggle()}
          aria-label="Přepnout světlý/tmavý režim"
        >
          {#if theme.resolved === "dark"}
            <IconSun size={18} />
          {:else}
            <IconMoon size={18} />
          {/if}
        </button>
      </div>
    </div>
  </header>

  <main class="mx-auto max-w-[1400px] px-6 py-6">
    {@render children?.()}
  </main>
</div>
