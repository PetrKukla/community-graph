import { wrap } from "svelte-spa-router/wrap";
import Overview from "./views/Overview.svelte";
import Jobs from "./views/Jobs.svelte";
import JobDetail from "./views/JobDetail.svelte";
import Ai from "./views/Ai.svelte";
import Stats from "./views/Stats.svelte";
import NotFound from "./views/NotFound.svelte";

export const routes = {
  "/": Overview,
  "/jobs": Jobs,
  "/jobs/:id": JobDetail,
  "/ai": Ai,
  "/stats": Stats,
  // graphology + sigma are heavy - split them into their own chunk, loaded on /graph
  "/graph": wrap({ asyncComponent: () => import("./views/Graph.svelte") }),
  "*": NotFound,
};
