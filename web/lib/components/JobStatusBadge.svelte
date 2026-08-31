<script lang="ts">
  import Badge from "$lib/components/ui/Badge.svelte";
  import type { JobStatus } from "../../types";

  const { status }: { status: JobStatus } = $props();

  const map: Record<JobStatus, { variant: "default" | "secondary" | "success" | "destructive" | "outline"; label: string }> = {
    pending: { variant: "outline", label: "čeká" },
    running: { variant: "default", label: "běží" },
    completed: { variant: "success", label: "hotovo" },
    failed: { variant: "destructive", label: "chyba" },
  };
  const entry = $derived(map[status] ?? { variant: "secondary" as const, label: status });
</script>

<Badge variant={entry.variant}>{entry.label}</Badge>
