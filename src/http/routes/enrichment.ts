import { Hono } from "hono";
import { getEnrichmentByDiscussionId } from "../../db/sqlite/repositories/enrichmentRepository";
import { methodNotAllowed } from "../middleware/methodNotAllowed";

export const enrichmentRoute = new Hono();

/**
 * What the AI generated for a cluster (discussion) id.
 * - split parent -> { split: true, segments: [...] } (one per child sub-discussion)
 * - directly enriched discussion (or a single child) -> its fields inline
 * - unknown id or not yet enriched -> 404
 */
enrichmentRoute.get("/discussions/:id/enrichment", (c) => {
  const view = getEnrichmentByDiscussionId(c.req.param("id"));
  if (!view) return c.json({ error: "not_found_or_not_enriched" }, 404);
  return c.json(view);
});

enrichmentRoute.all("/discussions/:id/enrichment", methodNotAllowed);
