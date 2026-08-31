<script lang="ts">
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import Router from "svelte-spa-router";
  import { routes } from "./routes";
  import AppShell from "$lib/components/AppShell.svelte";
  import { theme } from "$lib/stores/theme.svelte";

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false },
    },
  });

  $effect(() => theme.init());
</script>

<QueryClientProvider client={queryClient}>
  <AppShell>
    <Router {routes} />
  </AppShell>
</QueryClientProvider>
