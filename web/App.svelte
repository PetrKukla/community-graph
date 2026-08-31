<script lang="ts">
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import type { Component } from "svelte";
  import AppShell from "$lib/components/AppShell.svelte";
  import TokenGate from "$lib/components/TokenGate.svelte";
  import { theme } from "$lib/stores/theme.svelte";
  import { authGate } from "$lib/stores/auth.svelte";
  import { startRealtime } from "$lib/realtime/socket.svelte";
  import { router, matchRoute } from "$lib/router.svelte";
  import Overview from "./views/Overview.svelte";
  import Jobs from "./views/Jobs.svelte";
  import JobDetail from "./views/JobDetail.svelte";
  import Ai from "./views/Ai.svelte";
  import Stats from "./views/Stats.svelte";
  import NotFound from "./views/NotFound.svelte";

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false },
    },
  });

  type RouteEntry = { path: string; component?: Component; lazy?: () => Promise<{ default: Component }> };

  const routeList: RouteEntry[] = [
    { path: "/", component: Overview },
    { path: "/jobs", component: Jobs },
    { path: "/jobs/:id", component: JobDetail },
    { path: "/ai", component: Ai },
    { path: "/stats", component: Stats },
    // graphology + sigma are heavy - their own chunk, loaded only here
    { path: "/graph", lazy: () => import("./views/Graph.svelte") },
  ];

  const matched = $derived.by(() => {
    for (const entry of routeList) {
      const params = matchRoute(entry.path, router.path);
      if (params) return { entry, params };
    }
    return null;
  });

  const lazyPromise = $derived(matched?.entry.lazy ? matched.entry.lazy() : null);

  $effect(() => theme.init());
  $effect(() => {
    authGate.version;
    return startRealtime(queryClient);
  });
</script>

<QueryClientProvider client={queryClient}>
  <AppShell>
    {#if !matched}
      <NotFound />
    {:else if lazyPromise}
      {#await lazyPromise then mod}
        {@const Lazy = mod.default}
        <Lazy params={matched.params} />
      {/await}
    {:else if matched.entry.component}
      {@const Eager = matched.entry.component}
      <Eager params={matched.params} />
    {/if}
  </AppShell>
  <TokenGate />
</QueryClientProvider>
