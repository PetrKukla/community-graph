import type { DictionaryNames, GraphStore } from "../core/ports/GraphStore";

export interface NameSyncResult {
  updatedNodes: number;
}

/**
 * Pushes dictionary name changes onto existing Neo4j nodes (MATCH ... SET). Used by the
 * name_sync job - the large-sync path of POST /api/v1/dictionary and /dictionary/graph-resync.
 */
export async function nameSyncGraph(store: GraphStore, names: DictionaryNames): Promise<NameSyncResult> {
  await store.bootstrap();
  return store.syncDictionaryNames(names);
}
