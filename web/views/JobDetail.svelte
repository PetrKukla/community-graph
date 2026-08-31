<script lang="ts">
  import PagePlaceholder from "$lib/components/PagePlaceholder.svelte";

  const { params }: { params?: { id?: string } } = $props();
</script>

<PagePlaceholder
  title={`Job ${params?.id ?? ""}`}
  note="Detail jobu s result JSON a navázanými LLM voláními přijde ve fázi W2."
/>
