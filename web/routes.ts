import type { Component } from "svelte";
import Overview from "./views/Overview.svelte";
import Jobs from "./views/Jobs.svelte";
import JobDetail from "./views/JobDetail.svelte";
import Ai from "./views/Ai.svelte";
import Stats from "./views/Stats.svelte";
import Graph from "./views/Graph.svelte";
import NotFound from "./views/NotFound.svelte";

export const routes = {
  "/": Overview,
  "/jobs": Jobs,
  "/jobs/:id": JobDetail,
  "/ai": Ai,
  "/stats": Stats,
  "/graph": Graph,
  "*": NotFound,
} satisfies Record<string, Component>;
