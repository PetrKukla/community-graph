<script lang="ts">
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import Router from "svelte-spa-router";
  import { routes } from "./routes";
  import AppShell from "$lib/components/AppShell.svelte";
  import TokenGate from "$lib/components/TokenGate.svelte";
  import { theme } from "$lib/stores/theme.svelte";
  import { authGate } from "$lib/stores/auth.svelte";
  import { startRealtime } from "$lib/realtime/socket.svelte";

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false },
    },
  });

  $effect(() => theme.init());

  // re-run (tear down + reconnect the socket) whenever the API key changes
  $effect(() => {
    authGate.version;
    return startRealtime(queryClient);
  });
</script>

<QueryClientProvider client={queryClient}>
  <AppShell>
    <Router {routes} />
  </AppShell>
  <TokenGate />
</QueryClientProvider>
