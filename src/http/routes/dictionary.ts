import { Hono } from "hono";
import { z } from "zod";
import { config } from "../../config/config";
import { getGraphStore, isNeo4jConfigured } from "../../adapters/graph";
import { bus } from "../../core/events/bus";
import {
  loadDictionaryNames,
  syncDictionary,
  type DictionaryChangedIds,
  type DictionarySyncRequest,
} from "../../db/sqlite/repositories/dictionaryRepository";
import { createJob } from "../../db/sqlite/repositories/jobRepository";
import { runNameSyncJob } from "../../jobs/jobRunner";
import { methodNotAllowed } from "../middleware/methodNotAllowed";

// .nullable().optional(): an absent key stays `undefined` (leave column untouched), an explicit
// `null` clears the column. .strict() so a stray name field on the wrong section is a 400.
const nullableName = z.string().nullable().optional();

const bodySchema = z
  .object({
    guild: z.object({ id: z.string().min(1), name: nullableName }).strict().optional(),
    channels: z
      .array(z.object({ id: z.string().min(1), name: nullableName, type: nullableName }).strict())
      .optional(),
    users: z
      .array(z.object({ id: z.string().min(1), username: nullableName, display_name: nullableName }).strict())
      .optional(),
  })
  .strict();

export const dictionaryRoute = new Hono();

/**
 * Část 4.1 - incremental name upsert. Only the sections/fields present in the body are touched;
 * `null` clears a name, an absent key leaves it. SQLite is the single source of truth for names
 * and is written synchronously; Neo4j propagation is layered on in D3.
 */
dictionaryRoute.post("/dictionary", async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return c.json({ error: "invalid_request", details: parsed.error.flatten() }, 400);
  }

  const body = parsed.data;
  const idCount = (body.channels?.length ?? 0) + (body.users?.length ?? 0);
  const hasGuild = body.guild !== undefined;
  if (!hasGuild && idCount === 0) {
    return c.json({ error: "invalid_request", details: "aspoň jedna ze sekcí guild/channels/users musí být neprázdná" }, 400);
  }
  if (idCount > config.dictionary.max_ids_per_request) {
    return c.json(
      {
        error: "invalid_request",
        details: `channels + users (${idCount}) přesahuje [dictionary].max_ids_per_request (${config.dictionary.max_ids_per_request})`,
      },
      400,
    );
  }

  const result = syncDictionary(body as DictionarySyncRequest);

  const { guildId, channelIds, userIds } = result.changedIds;
  bus.emit("dictionary.synced", {
    guild_changed: guildId !== null,
    channel_ids: channelIds,
    user_ids: userIds,
    at: new Date().toISOString(),
  });

  return c.json({
    guild: result.guild,
    channels: result.channels,
    users: result.users,
    graph: await propagateNames(result.changedIds),
  });
});

interface GraphPropagation {
  configured: boolean;
  propagated: boolean;
  updated_nodes?: number;
  job_id?: string;
}

/**
 * Push the changed names into Neo4j. Small syncs run inline; larger ones spawn a name_sync job.
 * SQLite is already the source of truth, so a Neo4j failure only means propagated: false (200).
 */
async function propagateNames(changed: DictionaryChangedIds): Promise<GraphPropagation> {
  const changedCount = (changed.guildId ? 1 : 0) + changed.channelIds.length + changed.userIds.length;
  const configured = isNeo4jConfigured();
  if (!configured || changedCount === 0) return { configured, propagated: false };

  const names = loadDictionaryNames(changed);

  if (changedCount > config.dictionary.inline_graph_propagation_max) {
    const jobId = createJob("name_sync", null);
    runNameSyncJob(jobId, names);
    return { configured: true, propagated: false, job_id: jobId };
  }

  try {
    const store = getGraphStore();
    await store.bootstrap();
    const { updatedNodes } = await store.syncDictionaryNames(names);
    return { configured: true, propagated: true, updated_nodes: updatedNodes };
  } catch (err) {
    console.error(`[dictionary] Neo4j propagation failed: ${err instanceof Error ? err.message : String(err)}`);
    return { configured: true, propagated: false };
  }
}

dictionaryRoute.all("/dictionary", methodNotAllowed);
