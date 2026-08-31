<script lang="ts">
  import { fade, scale } from "svelte/transition";
  import { useQueryClient } from "@tanstack/svelte-query";
  import Button from "$lib/components/ui/Button.svelte";
  import { authGate } from "$lib/stores/auth.svelte";
  import { apiKey, setApiKey } from "$lib/config";

  const queryClient = useQueryClient();

  let value = $state(apiKey());
  let input = $state<HTMLInputElement>();

  $effect(() => {
    if (authGate.needed) {
      value = apiKey();
      queueMicrotask(() => input?.focus());
    }
  });

  function save(e: Event): void {
    e.preventDefault();
    const key = value.trim();
    if (!key) return;
    setApiKey(key);
    authGate.resolved();
    queryClient.invalidateQueries();
  }

  function dismiss(): void {
    // only allow closing if we already have some key to work with
    if (apiKey()) authGate.needed = false;
  }
</script>

{#if authGate.needed}
  <div
    class="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm"
    transition:fade={{ duration: 120 }}
    onclick={(e) => e.target === e.currentTarget && dismiss()}
    onkeydown={(e) => e.key === "Escape" && dismiss()}
    role="presentation"
  >
    <form
      class="w-full max-w-sm rounded-lg border border-border bg-card p-5 shadow-xl"
      transition:scale={{ duration: 140, start: 0.96 }}
      onsubmit={save}
    >
      <h2 class="text-sm font-semibold tracking-tight">Přístupový klíč</h2>
      <p class="mt-1 text-xs text-muted-foreground">
        Zadej <code>API_KEY</code> pro autorizaci API.
      </p>

      <input
        bind:this={input}
        bind:value
        type="password"
        autocomplete="off"
        placeholder="API_KEY"
        class="mt-3 h-9 w-full rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />

      {#if import.meta.env.DEV}
        <p class="mt-3 text-xs text-muted-foreground">
          TIP: Ve vývoji jde klíč nastavit i přes <code>VITE_API_KEY</code> v kořenovém <code>.env</code>.
        </p>
      {/if}

      <div class="mt-4 flex items-center justify-end gap-2">
        {#if apiKey()}
          <Button variant="ghost" onclick={dismiss}>Zrušit</Button>
        {/if}
        <Button variant="default" type="submit">Uložit</Button>
      </div>
    </form>
  </div>
{/if}
