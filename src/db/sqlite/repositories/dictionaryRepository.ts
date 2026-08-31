import { inArray, isNotNull, or } from 'drizzle-orm';
import { db } from '../client';
import { guilds, channels, users } from '../schema';
import type { DictionaryNames } from '../../../core/ports/GraphStore';

/**
 * A field is only acted on when the key is present in the request object:
 *   - value (incl. "")  -> SET to that value
 *   - null              -> SET to NULL (explicit clear)
 *   - key absent        -> left untouched
 * `undefined` therefore means "not in the payload"; callers must not coerce missing keys to null.
 */
export interface DictionaryGuildInput {
  id: string;
  name?: string | null;
}

export interface DictionaryChannelInput {
  id: string;
  name?: string | null;
  type?: string | null;
}

export interface DictionaryUserInput {
  id: string;
  username?: string | null;
  display_name?: string | null;
}

export interface DictionarySyncRequest {
  guild?: DictionaryGuildInput;
  channels?: DictionaryChannelInput[];
  users?: DictionaryUserInput[];
}

export interface SectionCounts {
  received: number;
  created: number;
  updated: number;
  unchanged: number;
}

export interface DictionaryChangedIds {
  guildId: string | null;
  channelIds: string[];
  userIds: string[];
}

export interface DictionarySyncResult {
  guild: { updated: 0 | 1 };
  channels: SectionCounts;
  users: SectionCounts;
  /** IDs whose name columns actually changed - fed to the Neo4j propagation so no-op SETs are skipped. */
  changedIds: DictionaryChangedIds;
}

/** Does the incoming row differ from what is stored, considering only the keys it carries? */
function differs(
  incoming: object,
  existing: Record<string, unknown>,
  keys: string[]
): boolean {
  const row = incoming as Record<string, unknown>;
  for (const key of keys) {
    if (!(key in row)) continue;
    if ((row[key] ?? null) !== (existing[key] ?? null)) return true;
  }
  return false;
}

export function syncDictionary(
  req: DictionarySyncRequest
): DictionarySyncResult {
  const now = new Date().toISOString();

  return db.transaction((tx) => {
    const result: DictionarySyncResult = {
      guild: { updated: 0 },
      channels: { received: 0, created: 0, updated: 0, unchanged: 0 },
      users: { received: 0, created: 0, updated: 0, unchanged: 0 },
      changedIds: { guildId: null, channelIds: [], userIds: [] }
    };

    // --- guild ---------------------------------------------------------------
    if (req.guild) {
      const existing = tx
        .select()
        .from(guilds)
        .where(inArray(guilds.id, [req.guild.id]))
        .get();
      const set: Record<string, unknown> = { namesSyncedAt: now };
      if ('name' in req.guild) set.name = req.guild.name ?? null;

      if (!existing) {
        tx.insert(guilds)
          .values({
            id: req.guild.id,
            name: req.guild.name ?? null,
            createdAt: now,
            namesSyncedAt: now
          })
          .run();
        result.guild.updated = 1;
        result.changedIds.guildId = req.guild.id;
      } else if (differs(req.guild, existing, ['name'])) {
        tx.update(guilds)
          .set(set)
          .where(inArray(guilds.id, [req.guild.id]))
          .run();
        result.guild.updated = 1;
        result.changedIds.guildId = req.guild.id;
      }
    }

    // --- channels ----------------------------------------------------------
    if (req.channels && req.channels.length > 0) {
      result.channels.received = req.channels.length;
      const ids = req.channels.map((c) => c.id);
      const existingRows = tx
        .select()
        .from(channels)
        .where(inArray(channels.id, ids))
        .all();
      const existingById = new Map(existingRows.map((r) => [r.id, r]));

      for (const ch of req.channels) {
        const existing = existingById.get(ch.id);
        const nameChanged = 'name' in ch || 'type' in ch;

        if (!existing) {
          tx.insert(channels)
            .values({
              id: ch.id,
              guildId: null,
              name: ch.name ?? null,
              type: ch.type ?? null,
              createdAt: now,
              updatedAt: now,
              namesSyncedAt: now
            })
            .run();
          result.channels.created++;
          if (nameChanged) result.changedIds.channelIds.push(ch.id);
        } else if (differs(ch, existing, ['name', 'type'])) {
          const set: Record<string, unknown> = { namesSyncedAt: now };
          if ('name' in ch) set.name = ch.name ?? null;
          if ('type' in ch) set.type = ch.type ?? null;
          tx.update(channels)
            .set(set)
            .where(inArray(channels.id, [ch.id]))
            .run();
          result.channels.updated++;
          if ('name' in ch) result.changedIds.channelIds.push(ch.id);
        } else {
          result.channels.unchanged++;
        }
      }
    }

    // --- users -----------------------------------------------------------
    if (req.users && req.users.length > 0) {
      result.users.received = req.users.length;
      const ids = req.users.map((u) => u.id);
      const existingRows = tx
        .select()
        .from(users)
        .where(inArray(users.id, ids))
        .all();
      const existingById = new Map(existingRows.map((r) => [r.id, r]));

      for (const u of req.users) {
        const existing = existingById.get(u.id);
        // schema column is display_name; normalise the request key for the diff
        const normalised = {
          ...('username' in u ? { username: u.username } : {}),
          ...('display_name' in u ? { displayName: u.display_name } : {})
        };

        if (!existing) {
          tx.insert(users)
            .values({
              id: u.id,
              username: u.username ?? null,
              displayName: u.display_name ?? null,
              firstSeenAt: null,
              lastSeenAt: null,
              messageCount: 0,
              namesSyncedAt: now
            })
            .run();
          result.users.created++;
          if ('username' in u || 'display_name' in u)
            result.changedIds.userIds.push(u.id);
        } else if (differs(normalised, existing, ['username', 'displayName'])) {
          const set: Record<string, unknown> = { namesSyncedAt: now };
          if ('username' in u) set.username = u.username ?? null;
          if ('display_name' in u) set.displayName = u.display_name ?? null;
          tx.update(users)
            .set(set)
            .where(inArray(users.id, [u.id]))
            .run();
          result.users.updated++;
          result.changedIds.userIds.push(u.id);
        } else {
          result.users.unchanged++;
        }
      }
    }

    return result;
  });
}

/** Current SQLite names for a set of changed IDs, shaped for GraphStore.syncDictionaryNames. */
export function loadDictionaryNames(
  changed: DictionaryChangedIds
): DictionaryNames {
  const out: DictionaryNames = {};

  if (changed.guildId) {
    const g = db
      .select({ name: guilds.name })
      .from(guilds)
      .where(inArray(guilds.id, [changed.guildId]))
      .get();
    out.guilds = [{ id: changed.guildId, name: g?.name ?? null }];
  }
  if (changed.channelIds.length > 0) {
    out.channels = db
      .select({ id: channels.id, name: channels.name })
      .from(channels)
      .where(inArray(channels.id, changed.channelIds))
      .all();
  }
  if (changed.userIds.length > 0) {
    out.users = db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName
      })
      .from(users)
      .where(inArray(users.id, changed.userIds))
      .all();
  }
  return out;
}

/** Every row in SQLite that has at least one name - the input for /dictionary/graph-resync (D4). */
export function loadAllDictionaryNames(): DictionaryNames {
  return {
    guilds: db
      .select({ id: guilds.id, name: guilds.name })
      .from(guilds)
      .where(isNotNull(guilds.name))
      .all(),
    channels: db
      .select({ id: channels.id, name: channels.name })
      .from(channels)
      .where(isNotNull(channels.name))
      .all(),
    users: db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName
      })
      .from(users)
      .where(or(isNotNull(users.username), isNotNull(users.displayName)))
      .all()
  };
}
