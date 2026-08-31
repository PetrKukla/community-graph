<script lang="ts">
  import { onDestroy, type Snippet } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { cn } from "$lib/utils";

  type Side = "top" | "bottom" | "left" | "right";

  const {
    text,
    side = "top",
    delay = 150,
    class: className,
    tipClass,
    children,
  }: {
    /** Tooltip content. When empty the tooltip never opens. */
    text: string;
    side?: Side;
    /** ms to wait on hover/focus before showing */
    delay?: number;
    /** classes for the trigger wrapper */
    class?: string;
    /** classes for the floating bubble */
    tipClass?: string;
    children: Snippet;
  } = $props();

  const GAP = 6;

  let trigger = $state<HTMLElement>();
  let open = $state(false);
  let x = $state(0);
  let y = $state(0);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const translate: Record<Side, string> = {
    top: "translate(-50%, -100%)",
    bottom: "translate(-50%, 0)",
    left: "translate(-100%, -50%)",
    right: "translate(0, -50%)",
  };

  function place(): void {
    const el = trigger;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (side === "top") {
      x = cx;
      y = r.top - GAP;
    } else if (side === "bottom") {
      x = cx;
      y = r.bottom + GAP;
    } else if (side === "left") {
      x = r.left - GAP;
      y = cy;
    } else {
      x = r.right + GAP;
      y = cy;
    }
  }

  // the bubble is position:fixed and measured once on open, so any scroll or
  // resize while it is up invalidates the coords - just dismiss it. Listeners
  // live only while open, so idle tooltips (there can be dozens in a table) cost
  // nothing globally.
  function bindDismiss(): void {
    document.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
  }
  function unbindDismiss(): void {
    document.removeEventListener("scroll", hide, true);
    window.removeEventListener("resize", hide);
  }

  function show(): void {
    if (!text) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      place();
      open = true;
      bindDismiss();
    }, delay);
  }

  function hide(): void {
    clearTimeout(timer);
    if (open) unbindDismiss();
    open = false;
  }

  onDestroy(() => {
    clearTimeout(timer);
    unbindDismiss();
  });

  function tip(_node: Element, { duration = 120 } = {}) {
    return {
      duration,
      easing: cubicOut,
      css: (t: number) => `opacity: ${t}; transform: ${translate[side]} scale(${0.94 + 0.06 * t});`,
    };
  }
</script>

<!-- the wrapper only carries hover/focus detection; the meaning lives in its children and the bubble -->
<span
  bind:this={trigger}
  role="presentation"
  class={cn("relative inline-block max-w-full", className)}
  onpointerenter={show}
  onpointerleave={hide}
  onfocusin={show}
  onfocusout={hide}
>
  {@render children()}
</span>

{#if open && text}
  <span
    role="tooltip"
    transition:tip
    style="position: fixed; left: {x}px; top: {y}px; transform: {translate[side]};"
    class={cn(
      "pointer-events-none z-50 w-max max-w-xs rounded-md bg-card px-3 border border-border py-1.5 text-xs font-medium text-card-foreground",
      tipClass,
    )}
  >
    {text}
  </span>
{/if}
