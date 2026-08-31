<script lang="ts">
  const { value }: { value: string | number | null | undefined } = $props();

  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 10_000);
    return () => clearInterval(t);
  });

  const label = $derived.by(() => {
    if (value == null) return "—";
    const ms = typeof value === "number" ? value : Date.parse(value);
    if (Number.isNaN(ms)) return "—";
    const diff = Math.round((now - ms) / 1000);
    if (diff < 5) return "právě teď";
    if (diff < 60) return `před ${diff} s`;
    if (diff < 3600) return `před ${Math.floor(diff / 60)} min`;
    if (diff < 86_400) return `před ${Math.floor(diff / 3600)} h`;
    return new Date(ms).toLocaleDateString("cs-CZ", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  });

  const iso = $derived(value == null ? "" : new Date(typeof value === "number" ? value : Date.parse(value)).toISOString());
</script>

<time datetime={iso} title={iso}>{label}</time>
