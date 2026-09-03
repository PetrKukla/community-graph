<script lang="ts">
  import Tooltip from "$lib/components/ui/Tooltip.svelte";
  import RelativeTime from "$lib/components/RelativeTime.svelte";
  import { aiCallQuery } from "$lib/api/queries";
  import { formatMs, formatTokens, tokensTitle } from "$lib/labels";
  import type { LlmCall } from "../../types";

  const { call }: { call: LlmCall } = $props();

  let expanded = $state(false);
  const detail = aiCallQuery(
    () => call.id,
    () => expanded,
  );

  function toggle() {
    expanded = !expanded;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  }

  const preClass = "overflow-x-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs";
</script>

<tr
  class="cursor-pointer border-b border-border/60 last:border-0 hover:bg-muted/40"
  role="button"
  tabindex="0"
  aria-expanded={expanded}
  onclick={toggle}
  onkeydown={onKey}
>
  <td class="py-2 pr-4 whitespace-nowrap text-muted-foreground">
    <span class="mr-1.5 inline-block w-2 text-[10px]">{expanded ? "▾" : "▸"}</span>
    <RelativeTime value={call.started_at} />
  </td>
  <td class="py-2 pr-4 font-medium">{call.model}</td>
  <td class="py-2 pr-4 text-muted-foreground">
    <Tooltip
      text={call.context ?? ""}
      class="max-w-[22rem] truncate align-middle"
      tipClass="max-w-md whitespace-pre-wrap"
    >
      {call.context ?? "—"}
    </Tooltip>
  </td>
  <td class="py-2 pr-4 tabular-nums">{formatMs(call.duration_ms)}</td>
  <td class="py-2 pr-4 tabular-nums text-muted-foreground">
    <Tooltip text={tokensTitle(call.prompt_tokens, call.completion_tokens)}>
      {formatTokens(call.prompt_tokens, call.completion_tokens)}
    </Tooltip>
  </td>
  <td class="py-2">
    <span class:text-success={call.status === "ok"} class:text-destructive={call.status === "error"}>
      {call.status === "ok" ? "ok" : "chyba"}
    </span>
  </td>
</tr>

{#if expanded}
  <tr class="border-b border-border/60 last:border-0">
    <td colspan="6" class="bg-muted/20 px-3 py-3">
      {#if $detail.isPending}
        <p class="text-xs text-muted-foreground">Načítám…</p>
      {:else if $detail.isError}
        <p class="text-xs text-destructive">
          Detail se nepodařilo načíst: {$detail.error?.message ?? "neznámá chyba"}
        </p>
      {:else if $detail.data}
        {@const d = $detail.data}
        <div class="flex flex-col gap-3">
          <div class="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
            <span>{d.provider} / {d.model}</span>
            {#if d.job_id}<span>job {d.job_id}</span>{/if}
            {#if d.channel_id}<span>kanál {d.channel_id}</span>{/if}
            <span>{formatMs(d.duration_ms)}</span>
          </div>

          <div class="flex flex-col gap-1">
            <span class="text-xs font-medium text-muted-foreground">System prompt</span>
            <pre class={preClass}>{d.system_prompt ?? "—"}</pre>
          </div>

          <div class="flex flex-col gap-1">
            <span class="text-xs font-medium text-muted-foreground">User prompt</span>
            <pre class={preClass}>{d.user_prompt ?? "—"}</pre>
          </div>

          {#if d.status === "error"}
            <div class="flex flex-col gap-1">
              <span class="text-xs font-medium text-destructive">Chyba</span>
              <pre class="overflow-x-auto whitespace-pre-wrap rounded-md bg-destructive/10 p-3 font-mono text-xs text-destructive">{d.error ?? "—"}</pre>
            </div>
          {:else}
            <div class="flex flex-col gap-1">
              <span class="text-xs font-medium text-muted-foreground">Odpověď</span>
              <pre class={preClass}>{d.response ?? "—"}</pre>
            </div>
          {/if}
        </div>
      {/if}
    </td>
  </tr>
{/if}
