<script lang="ts">
  import { createMutation } from "@tanstack/svelte-query";
  import {
    IconArrowRight,
    IconHistory,
    IconTrash,
    IconAntennaBars1,
    IconAntennaBars3,
    IconAntennaBars5,
  } from "@tabler/icons-svelte";
  import Card from "$lib/components/ui/Card.svelte";
  import Badge from "$lib/components/ui/Badge.svelte";
  import Button from "$lib/components/ui/Button.svelte";
  import Skeleton from "$lib/components/ui/Skeleton.svelte";
  import Tooltip from "$lib/components/ui/Tooltip.svelte";
  import RelativeTime from "$lib/components/RelativeTime.svelte";
  import DiscussionDrawer from "$lib/components/ask/DiscussionDrawer.svelte";
  import { askQuestion, resolveGraphNode, statsQuery } from "$lib/api/queries";
  import { ApiError } from "$lib/api/client";
  import { askHistory, type AskHistoryEntry } from "$lib/stores/askHistory.svelte";
  import { renderAnswer } from "$lib/ask/answer";
  import { navigate } from "$lib/router.svelte";
  import { cn } from "$lib/utils";
  import type { QueryAnswer, QueryConfidence, QueryFilters } from "../types";

  const stats = statsQuery();
  const channels = $derived($stats.data?.messages_per_channel ?? []);
  const discussionTypes = $derived($stats.data?.discussion_types ?? []);

  let question = $state("");
  let selectedChannels = $state<string[]>([]);
  let selectedTypes = $state<string[]>([]);
  let since = $state("");

  // the answer currently on screen - either a fresh mutation result or a re-viewed history entry
  let shown = $state<{ question: string; answer: QueryAnswer; filters?: QueryFilters } | null>(null);
  let drawerId = $state<string | null>(null);

  // confidence shows as a colored icon; the wording moves into the tooltip.
  // swap `icon` for any component (e.g. a Tabler icon) to restyle the indicator.
  const CONFIDENCE: Record<QueryConfidence, { label: string; color: string; icon: typeof IconAntennaBars5 }> = {
    high: { label: "Vysoká jistota", color: "text-success", icon: IconAntennaBars5 },
    medium: { label: "Střední jistota", color: "text-warning", icon: IconAntennaBars3 },
    low: { label: "Nízká jistota", color: "text-destructive", icon: IconAntennaBars1 },
  };

  function currentFilters(): QueryFilters {
    const f: QueryFilters = {};
    if (selectedChannels.length) f.channel_ids = [...selectedChannels];
    if (selectedTypes.length) f.discussion_types = [...selectedTypes];
    if (since) f.since = new Date(since).toISOString();
    return f;
  }

  const ask = createMutation({
    mutationFn: (vars: { question: string; filters: QueryFilters }) =>
      askQuestion({ question: vars.question, filters: Object.keys(vars.filters).length ? vars.filters : undefined }),
    onSuccess: (answer, vars) => {
      const filters = Object.keys(vars.filters).length ? vars.filters : undefined;
      shown = { question: vars.question, answer, filters };
      askHistory.add(vars.question, filters, answer);
    },
  });

  function submit(): void {
    const q = question.trim();
    if (q.length < 3 || $ask.isPending) return;
    $ask.mutate({ question: q, filters: currentFilters() });
  }

  function onTextareaKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function reView(entry: AskHistoryEntry): void {
    shown = { question: entry.question, answer: entry.answer, filters: entry.filters };
    question = entry.question;
    $ask.reset();
  }

  function reRun(entry: AskHistoryEntry): void {
    question = entry.question;
    $ask.mutate({ question: entry.question, filters: entry.filters ?? {} });
  }

  // elapsed-time counter while a request is in flight
  let elapsed = $state(0);
  $effect(() => {
    if (!$ask.isPending) {
      elapsed = 0;
      return;
    }
    const started = Date.now();
    const t = setInterval(() => (elapsed = Math.round((Date.now() - started) / 100) / 10), 100);
    return () => clearInterval(t);
  });

  const validationError = $derived($ask.error instanceof ApiError && $ask.error.status === 422);
  const graphDown = $derived($ask.error instanceof ApiError && $ask.error.status === 503);

  const emptyAnswer = $derived(shown != null && (shown.answer.confidence === "low" || shown.answer.citations.length === 0));

  // a [D#] marker inside the answer opens that citation's detail drawer (and nudges its card into view)
  function onAnswerClick(e: MouseEvent): void {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-cref]");
    if (!target || !shown) return;
    e.preventDefault();
    const ref = target.dataset.cref;
    document.getElementById(ref ?? "")?.scrollIntoView({ behavior: "smooth", block: "center" });
    const cite = shown.answer.citations.find((c) => c.ref === ref);
    if (cite) drawerId = cite.discussion_id;
  }

  async function openInGraph(discussionId: string): Promise<void> {
    try {
      await resolveGraphNode("Discussion", discussionId);
    } catch {
      /* resolve is best-effort; the graph view retries with the domain id */
    }
    navigate(`/graph?focus=${encodeURIComponent(discussionId)}`);
  }

  function toggle(list: string[], value: string): string[] {
    return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  }
</script>

<div class="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
  <!-- left: input + filters + history -->
  <div class="flex flex-col gap-4">
    <Card title="Zeptat se" description="Otázka nad znalostní databází komunity.">
      <div class="flex flex-col gap-3">
        <textarea
          bind:value={question}
          onkeydown={onTextareaKeydown}
          rows="3"
          placeholder="Např. Jaký mají lidé názor na Smarty?"
          class="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        ></textarea>

        <details class="text-sm">
          <summary class="cursor-pointer text-xs font-medium text-muted-foreground">Filtry</summary>
          <div class="mt-2 flex flex-col gap-3">
            {#if channels.length}
              <div>
                <p class="mb-1 text-xs text-muted-foreground">Kanály</p>
                <div class="flex flex-wrap gap-1.5">
                  {#each channels as ch (ch.channel_id)}
                    <button
                      type="button"
                      class="rounded-md border px-2 py-0.5 text-xs transition-colors"
                      class:border-primary={selectedChannels.includes(ch.channel_id)}
                      class:bg-secondary={selectedChannels.includes(ch.channel_id)}
                      class:border-border={!selectedChannels.includes(ch.channel_id)}
                      onclick={() => (selectedChannels = toggle(selectedChannels, ch.channel_id))}
                    >
                      {ch.name ?? ch.channel_id}
                    </button>
                  {/each}
                </div>
              </div>
            {/if}

            {#if discussionTypes.length}
              <div>
                <p class="mb-1 text-xs text-muted-foreground">Typ diskuze</p>
                <div class="flex flex-wrap gap-1.5">
                  {#each discussionTypes as t (t.type)}
                    <button
                      type="button"
                      class="rounded-md border px-2 py-0.5 text-xs transition-colors"
                      class:border-primary={selectedTypes.includes(t.type)}
                      class:bg-secondary={selectedTypes.includes(t.type)}
                      class:border-border={!selectedTypes.includes(t.type)}
                      onclick={() => (selectedTypes = toggle(selectedTypes, t.type))}
                    >
                      {t.type}
                    </button>
                  {/each}
                </div>
              </div>
            {/if}

            <label class="flex flex-col gap-1 text-xs text-muted-foreground">
              Od data
              <input
                type="date"
                bind:value={since}
                class="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
          </div>
        </details>

        <Button variant="default" onclick={submit} disabled={$ask.isPending || question.trim().length < 3}>
          {$ask.isPending ? `Hledám… ${elapsed.toFixed(1)} s` : "Zeptat se"}
          {#if !$ask.isPending}<IconArrowRight size={15} />{/if}
        </Button>
      </div>
    </Card>

    {#if askHistory.items.length}
      <Card title="Historie">
        {#snippet actions()}
          <button
            type="button"
            class="text-xs text-muted-foreground hover:text-foreground"
            onclick={() => askHistory.clear()}
          >
            <IconTrash size={14} />
          </button>
        {/snippet}
        <ul class="flex flex-col gap-1">
          {#each askHistory.items as entry (entry.id)}
            <li class="group flex items-center gap-1">
              <button
                type="button"
                class="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary/60"
                onclick={() => reView(entry)}
              >
                <span class="line-clamp-2">{entry.question}</span>
                <span class="text-xs text-muted-foreground"><RelativeTime value={entry.at} /></span>
              </button>
              <Tooltip text='Opakovat' side='right'>
                <button
                        type="button"
                        class="mt-1 shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
                        aria-label="Zeptat se znovu"
                        onclick={() => reRun(entry)}
                >
                  <IconHistory size={14} />
                </button>
              </Tooltip>

            </li>
          {/each}
        </ul>
      </Card>
    {/if}
  </div>

  <!-- right: answer + citations -->
  <div class="flex flex-col gap-4">
    {#if $ask.isPending}
      <Card title="Odpověď">
        <div class="flex flex-col gap-2">
          <Skeleton class="h-4 w-full" />
          <Skeleton class="h-4 w-11/12" />
          <Skeleton class="h-4 w-3/4" />
          <p class="mt-2 text-xs text-muted-foreground">Sestavuji odpověď z grafu… {elapsed.toFixed(1)} s</p>
        </div>
      </Card>
    {:else if validationError}
      <Card title="Odpověď">
        <p class="text-sm text-destructive">Otázka je příliš krátká nebo nesrozumitelná. Zkus ji přeformulovat.</p>
      </Card>
    {:else if graphDown}
      <Card title="Odpověď">
        <p class="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          Graf není dostupný (Neo4j neběží nebo není nakonfigurované). Zkus to znovu později.
        </p>
      </Card>
    {:else if $ask.isError}
      <Card title="Odpověď">
        <p class="text-sm text-destructive">
          Dotaz selhal: {$ask.error instanceof Error ? $ask.error.message : "neznámá chyba"}
        </p>
      </Card>
    {:else if shown}
      {@const a = shown.answer}
      {@const conf = CONFIDENCE[a.confidence]}
      <Card>
        <div class="mb-2 flex items-center justify-between gap-3">
          <p class="text-xs text-muted-foreground">{shown.question}</p>
          <Tooltip text={conf.label} side="left" class="shrink-0">
            <span class={cn("flex items-center", conf.color)} aria-label={conf.label}>
              <conf.icon size={18} />
            </span>
          </Tooltip>
        </div>

        {#if emptyAnswer}
          <p class="rounded-md border border-border bg-secondary/40 p-3 text-sm">
            K tomuhle jsem v historii komunity nenašel dost podkladů, abych mohl spolehlivě odpovědět.
          </p>
        {:else}
          <!-- eslint-disable-next-line svelte/no-at-html-tags -- renderAnswer escapes first, whitelist transforms only -->
          <div
            class="cg-answer text-sm leading-relaxed [&_p]:mb-2 [&_sup]:text-primary"
            onclick={onAnswerClick}
            role="presentation"
          >
            {@html renderAnswer(a.answer)}
          </div>
        {/if}
      </Card>

      {#if a.citations.length}
        <Card title={`Citace (${a.citations.length})`}>
          <ul class="flex flex-col gap-2">
            {#each a.citations as cit (cit.ref)}
              <li id={cit.ref} class="scroll-mt-20">
                <button
                  type="button"
                  class="w-full rounded-md border border-border p-3 text-left transition-colors hover:bg-secondary/50"
                  class:opacity-60={!cit.used}
                  onclick={() => (drawerId = cit.discussion_id)}
                >
                  <div class="flex items-center gap-2">
                    <span class="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-semibold text-primary">{cit.ref}</span>
                    <span class="min-w-0 flex-1 truncate text-sm font-medium">{cit.title ?? "Diskuze bez názvu"}</span>
                  </div>
                  <div class="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    {#if cit.channel}<span>#{cit.channel}</span>{/if}
                    {#if cit.discussion_type}<Badge variant="outline">{cit.discussion_type}</Badge>{/if}
                    {#if cit.sentiment}<span>{cit.sentiment}</span>{/if}
                    {#if cit.started_at}<RelativeTime value={cit.started_at} />{/if}
                    <span class="ml-auto tabular-nums">skóre {cit.score.toFixed(2)}</span>
                  </div>
                </button>
              </li>
            {/each}
          </ul>
        </Card>
      {/if}
    {:else}
      <Card title="Odpověď">
        <p class="text-sm text-muted-foreground">
          Polož otázku vlevo. Odpověď se sestaví z relevantních diskuzí v grafu a doplní se citacemi na zdroje.
        </p>
      </Card>
    {/if}
  </div>
</div>

<DiscussionDrawer discussionId={drawerId} onClose={() => (drawerId = null)} onOpenInGraph={openInGraph} />
