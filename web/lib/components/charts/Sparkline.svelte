<script lang="ts">
  type Point = { label: string; value: number };

  const {
    points,
    format = (n: number) => n.toLocaleString("cs-CZ"),
    height = 96,
    unit = "",
  }: {
    points: Point[];
    format?: (n: number) => string;
    height?: number;
    unit?: string;
  } = $props();

  const W = 600;
  const PAD = 6;

  const geom = $derived.by(() => {
    if (points.length === 0) return null;
    const max = Math.max(...points.map((p) => p.value), 1);
    const stepX = points.length > 1 ? (W - PAD * 2) / (points.length - 1) : 0;
    const y = (v: number) => height - PAD - (v / max) * (height - PAD * 2);
    const coords = points.map((p, i) => ({ x: PAD + i * stepX, y: y(p.value), ...p }));
    const line = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
    const area = `${PAD},${height - PAD} ${line} ${(PAD + (points.length - 1) * stepX).toFixed(1)},${height - PAD}`;
    return { coords, line, area, max };
  });

  let hover = $state<number | null>(null);

  function onMove(e: MouseEvent) {
    if (!geom) return;
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * W;
    let nearest = 0;
    let best = Infinity;
    geom.coords.forEach((c, i) => {
      const d = Math.abs(c.x - relX);
      if (d < best) {
        best = d;
        nearest = i;
      }
    });
    hover = nearest;
  }

  const active = $derived(hover != null && geom ? geom.coords[hover] : null);
</script>

{#if !geom}
  <p class="text-sm text-muted-foreground">Zatím žádná data.</p>
{:else}
  <div class="relative">
    <svg
      viewBox={`0 0 ${W} ${height}`}
      class="w-full"
      style:height={`${height}px`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Časová řada"
      onmousemove={onMove}
      onmouseleave={() => (hover = null)}
    >
      <polyline points={geom.area} fill="var(--primary)" fill-opacity="0.12" stroke="none" />
      <polyline
        points={geom.line}
        fill="none"
        stroke="var(--primary)"
        stroke-width="2"
        vector-effect="non-scaling-stroke"
        stroke-linejoin="round"
      />
      {#if active}
        <line x1={active.x} x2={active.x} y1={PAD} y2={height - PAD} stroke="var(--border)" stroke-width="1" vector-effect="non-scaling-stroke" />
        <circle cx={active.x} cy={active.y} r="3.5" fill="var(--primary)" stroke="var(--card)" stroke-width="2" />
      {/if}
    </svg>

    {#if active}
      <div class="pointer-events-none absolute top-0 rounded-md border border-border bg-popover px-2 py-1 text-xs shadow-sm"
           style:left={`clamp(0px, ${(active.x / W) * 100}% - 40px, calc(100% - 80px))`}>
        <div class="font-medium tabular-nums">{format(active.value)}{unit}</div>
        <div class="text-muted-foreground">{active.label}</div>
      </div>
    {/if}
  </div>
{/if}
