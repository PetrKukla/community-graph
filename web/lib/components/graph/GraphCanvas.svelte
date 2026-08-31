<script lang="ts">
  import { onMount } from "svelte";
  import Graph from "graphology";
  import Sigma from "sigma";
  import { drawDiscNodeLabel } from "sigma/rendering";
  import type { NodeHoverDrawingFunction } from "sigma/rendering";
  import FA2Layout from "graphology-layout-forceatlas2/worker";
  import forceAtlas2 from "graphology-layout-forceatlas2";
  import type { GraphView, GraphViewNode } from "../../../types";
  import { fetchNeighbors } from "$lib/api/queries";
  import { nodeColor, nodeSize } from "$lib/graph/labels";
  import { theme } from "$lib/stores/theme.svelte";

  // sigma's built-in hover box is hard-coded white; this is the same geometry with a themed box
  // so the hover label stays readable on a dark canvas.
  function themedHover(dark: boolean): NodeHoverDrawingFunction {
    const box = dark ? "#18181b" : "#ffffff";
    return (context, data, settings): void => {
      const { labelSize: size, labelFont: font, labelWeight: weight } = settings;
      context.font = `${weight} ${size}px ${font}`;
      context.fillStyle = box;
      context.shadowOffsetX = 0;
      context.shadowOffsetY = 0;
      context.shadowBlur = 8;
      context.shadowColor = dark ? "#000" : "#0000004d";

      const PADDING = 2;
      if (typeof data.label === "string") {
        const textWidth = context.measureText(data.label).width;
        const boxWidth = Math.round(textWidth + 5);
        const boxHeight = Math.round(size + 2 * PADDING);
        const radius = Math.max(data.size, size / 2) + PADDING;
        const angle = Math.asin(boxHeight / 2 / radius);
        const xDelta = Math.sqrt(Math.abs(radius ** 2 - (boxHeight / 2) ** 2));
        context.beginPath();
        context.moveTo(data.x + xDelta, data.y + boxHeight / 2);
        context.lineTo(data.x + radius + boxWidth, data.y + boxHeight / 2);
        context.lineTo(data.x + radius + boxWidth, data.y - boxHeight / 2);
        context.lineTo(data.x + xDelta, data.y - boxHeight / 2);
        context.arc(data.x, data.y, radius, angle, -angle);
        context.closePath();
        context.fill();
      } else {
        context.beginPath();
        context.arc(data.x, data.y, data.size + PADDING, 0, Math.PI * 2);
        context.closePath();
        context.fill();
      }
      context.shadowBlur = 0;
      drawDiscNodeLabel(context, data, settings);
    };
  }

  const {
    view,
    hiddenLabels = new Set<string>(),
    onSelect,
  }: {
    view: GraphView | undefined;
    hiddenLabels?: Set<string>;
    onSelect: (node: GraphViewNode | null) => void;
  } = $props();

  let container: HTMLDivElement;
  let graph: Graph | undefined;
  let sigma: Sigma | undefined;
  let layout: FA2Layout | undefined;
  let selectedId = $state<string | null>(null);
  let lastView: GraphView | undefined;
  const nodeData = new Map<string, GraphViewNode>();

  function egoSet(id: string): Set<string> {
    const set = new Set<string>([id]);
    graph?.forEachNeighbor(id, (n) => set.add(n));
    return set;
  }

  function runLayout(ms = 2500): void {
    if (!graph || graph.order === 0) return;
    layout?.kill();
    layout = new FA2Layout(graph, { settings: forceAtlas2.inferSettings(graph) });
    layout.start();
    setTimeout(() => layout?.stop(), ms);
  }

  function addNode(n: GraphViewNode): void {
    if (!graph) return;
    nodeData.set(n.id, n);
    const attrs = {
      label: n.caption,
      size: nodeSize(n.degree),
      color: nodeColor(n.label),
      nodeLabel: n.label,
      hidden: hiddenLabels.has(n.label),
      x: Math.random() * 100,
      y: Math.random() * 100,
    };
    if (graph.hasNode(n.id)) graph.mergeNodeAttributes(n.id, attrs);
    else graph.addNode(n.id, attrs);
  }

  function rebuild(v: GraphView): void {
    if (!graph) return;
    graph.clear();
    nodeData.clear();
    for (const n of v.nodes) addNode(n);
    for (const e of v.edges) {
      if (graph.hasNode(e.source) && graph.hasNode(e.target) && !graph.hasEdge(e.id)) {
        graph.addEdgeWithKey(e.id, e.source, e.target, { label: e.type, size: 1, type: "line" });
      }
    }
    runLayout();
    sigma?.getCamera().animatedReset();
  }

  async function expand(id: string): Promise<void> {
    try {
      const nb = await fetchNeighbors(id);
      if (!graph) return;
      for (const n of nb.nodes) addNode(n);
      for (const e of nb.edges) {
        if (graph.hasNode(e.source) && graph.hasNode(e.target) && !graph.hasEdge(e.id)) {
          graph.addEdgeWithKey(e.id, e.source, e.target, { label: e.type, size: 1, type: "line" });
        }
      }
      runLayout(1800);
    } catch {
      /* Neo4j offline or transient - leave the graph as is */
    }
  }

  function centerCamera(id: string): void {
    const display = sigma?.getNodeDisplayData(id);
    if (display) sigma?.getCamera().animate({ x: display.x, y: display.y, ratio: 0.4 }, { duration: 500 });
  }

  /** Select a node and pan to it; pulls it (and its neighbours) in first if it isn't on screen. */
  export async function focusNode(node: GraphViewNode): Promise<void> {
    if (!sigma || !graph) return;
    if (!graph.hasNode(node.id)) {
      addNode(node);
      await expand(node.id);
      sigma.refresh();
    }
    if (!graph.hasNode(node.id)) return;
    selectedId = node.id;
    onSelect(nodeData.get(node.id) ?? node);
    centerCamera(node.id);
  }

  /** Clear the highlight (called by the NodeDetail close button and clicking empty canvas). */
  export function clearSelection(): void {
    selectedId = null;
    onSelect(null);
    sigma?.refresh();
  }

  onMount(() => {
    graph = new Graph({ multi: true });
    sigma = new Sigma(graph, container, {
      renderEdgeLabels: false,
      defaultEdgeColor: "rgba(130,130,130,0.25)",
      labelDensity: 0.6,
      labelRenderedSizeThreshold: 8,
      nodeReducer: (node, data) => {
        if (!selectedId) return data;
        const ego = egoSet(selectedId);
        return ego.has(node) ? data : { ...data, color: "rgba(150,150,150,0.15)", label: "" };
      },
      edgeReducer: (edge, data) => {
        if (!selectedId || !graph) return data;
        const ego = egoSet(selectedId);
        const [s, t] = graph.extremities(edge);
        return ego.has(s) && ego.has(t) ? data : { ...data, color: "rgba(150,150,150,0.06)" };
      },
    });

    sigma.on("clickNode", ({ node }) => {
      const data = nodeData.get(node);
      selectedId = node;
      onSelect(data ?? null);
      centerCamera(node);
      void expand(node);
    });
    sigma.on("clickStage", () => clearSelection());

    if (view) {
      lastView = view;
      rebuild(view);
    }

    return () => {
      layout?.kill();
      sigma?.kill();
      graph = undefined;
      sigma = undefined;
      layout = undefined;
    };
  });

  // rebuild whenever a genuinely new overview arrives
  $effect(() => {
    if (view && graph && view !== lastView) {
      lastView = view;
      rebuild(view);
    }
  });

  // re-apply label visibility filter
  $effect(() => {
    // read the prop unconditionally so the effect stays subscribed even when it
    // first runs before any nodes exist (graph data still loading on a fresh load)
    const hidden = hiddenLabels;
    if (!graph) return;
    graph.forEachNode((id, attrs) => {
      graph?.setNodeAttribute(id, "hidden", hidden.has(attrs.nodeLabel as string));
    });
    sigma?.refresh();
  });

  // reflect selection highlight
  $effect(() => {
    selectedId;
    sigma?.refresh();
  });

  // theme-aware labels: ink follows the canvas for always-on labels, and a matching
  // hover box keeps the hover label readable in dark mode too
  $effect(() => {
    const dark = theme.resolved === "dark";
    sigma?.setSetting("labelColor", { color: dark ? "#f4f4f5" : "#18181b" });
    sigma?.setSetting("defaultDrawNodeHover", themedHover(dark));
    sigma?.refresh();
  });
</script>

<!-- transparent: shows the themed card surface behind it (dark in dark mode) -->
<div bind:this={container} class="h-full w-full"></div>
