<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils";

  type Variant = "default" | "outline" | "ghost";
  type Size = "sm" | "md";

  const {
    variant = "outline",
    size = "sm",
    href,
    type = "button",
    disabled = false,
    onclick,
    children,
    class: className,
  }: {
    variant?: Variant;
    size?: Size;
    href?: string;
    type?: "button" | "submit";
    disabled?: boolean;
    onclick?: (e: MouseEvent) => void;
    children: Snippet;
    class?: string;
  } = $props();

  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  const variants: Record<Variant, string> = {
    default: "bg-primary text-primary-foreground hover:bg-primary/90",
    outline: "border border-border bg-background hover:bg-secondary",
    ghost: "hover:bg-secondary hover:text-foreground text-muted-foreground",
  };
  const sizes: Record<Size, string> = { sm: "h-8 px-3", md: "h-9 px-4" };
</script>

{#if href}
  <a {href} class={cn(base, variants[variant], sizes[size], className)}>{@render children()}</a>
{:else}
  <button {type} {disabled} {onclick} class={cn(base, variants[variant], sizes[size], className)}>
    {@render children()}
  </button>
{/if}
