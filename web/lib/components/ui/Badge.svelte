<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils";

  type Variant = "default" | "secondary" | "success" | "warning" | "destructive" | "outline";

  const { variant = "secondary", children, class: className }: { variant?: Variant; children: Snippet; class?: string } =
    $props();

  const styles: Record<Variant, string> = {
    default: "bg-primary text-primary-foreground",
    secondary: "bg-secondary text-secondary-foreground",
    success: "bg-success/15 text-success",
    warning: "bg-warning/15 text-warning",
    destructive: "bg-destructive/15 text-destructive",
    outline: "border border-border text-muted-foreground",
  };
</script>

<span
  class={cn(
    "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap",
    styles[variant],
    className,
  )}
>
  {@render children()}
</span>
