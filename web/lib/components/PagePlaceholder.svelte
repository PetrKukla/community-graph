<script lang="ts">
  const { title, note }: { title: string; note: string } = $props();
</script>

<section class="flex flex-col gap-2">
  <h1 class="text-lg font-semibold tracking-tight">{title}</h1>
  <p class="text-sm text-muted-foreground">{note}</p>
</section>
