import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

// point the SQLite client at a throwaway file before it is constructed on import
process.env.SQLITE_PATH = join(tmpdir(), `cg-dict-${randomUUID()}.sqlite`);

const { db, runMigrations } = await import('../../src/db/sqlite/client');
const { syncDictionary, loadDictionaryNames, loadAllDictionaryNames } =
  await import('../../src/db/sqlite/repositories/dictionaryRepository');
const { ingestBatch } =
  await import('../../src/db/sqlite/repositories/ingestRepository');
const { guilds, channels, users } = await import('../../src/db/sqlite/schema');

runMigrations();

describe('syncDictionary', () => {
  test('creates, updates and reports unchanged per section', () => {
    const first = syncDictionary({
      guild: { id: 'g1', name: 'Server' },
      channels: [{ id: 'c1', name: 'general', type: 'text' }],
      users: [
        { id: 'u1', username: 'alice', display_name: 'Alice' },
        { id: 'u2', username: 'bob' }
      ]
    });
    expect(first.guild.updated).toBe(1);
    expect(first.channels).toEqual({
      received: 1,
      created: 1,
      updated: 0,
      unchanged: 0
    });
    expect(first.users).toEqual({
      received: 2,
      created: 2,
      updated: 0,
      unchanged: 0
    });
    expect(first.changedIds).toEqual({
      guildId: 'g1',
      channelIds: ['c1'],
      userIds: ['u1', 'u2']
    });

    // identical payload -> everything unchanged, nothing in changedIds
    const second = syncDictionary({
      guild: { id: 'g1', name: 'Server' },
      channels: [{ id: 'c1', name: 'general', type: 'text' }],
      users: [
        { id: 'u1', username: 'alice', display_name: 'Alice' },
        { id: 'u2', username: 'bob' }
      ]
    });
    expect(second.guild.updated).toBe(0);
    expect(second.channels).toEqual({
      received: 1,
      created: 0,
      updated: 0,
      unchanged: 1
    });
    expect(second.users).toEqual({
      received: 2,
      created: 0,
      updated: 0,
      unchanged: 2
    });
    expect(second.changedIds).toEqual({
      guildId: null,
      channelIds: [],
      userIds: []
    });

    // a real rename shows as updated
    const third = syncDictionary({
      users: [{ id: 'u1', display_name: 'Alice B.' }]
    });
    expect(third.users).toEqual({
      received: 1,
      created: 0,
      updated: 1,
      unchanged: 0
    });
    expect(third.changedIds.userIds).toEqual(['u1']);
    expect(
      db.select().from(users).where(eq(users.id, 'u1')).get()?.displayName
    ).toBe('Alice B.');
  });

  test('null clears a name, an absent key leaves it untouched', () => {
    syncDictionary({
      users: [{ id: 'u3', username: 'carol', display_name: 'Carol' }]
    });

    // display_name: null clears; username absent -> stays "carol"
    const r = syncDictionary({ users: [{ id: 'u3', display_name: null }] });
    expect(r.users.updated).toBe(1);
    const row = db.select().from(users).where(eq(users.id, 'u3')).get();
    expect(row?.displayName).toBeNull();
    expect(row?.username).toBe('carol');
  });

  test('pre-seeded user row has null first/last seen', () => {
    syncDictionary({ users: [{ id: 'u4', username: 'dave' }] });
    const row = db.select().from(users).where(eq(users.id, 'u4')).get();
    expect(row?.firstSeenAt).toBeNull();
    expect(row?.lastSeenAt).toBeNull();
    expect(row?.messageCount).toBe(0);
  });

  test('loadDictionaryNames resolves current names for changed ids only', () => {
    syncDictionary({
      guild: { id: 'lg1', name: 'Loaded' },
      channels: [{ id: 'lc1', name: 'chan' }],
      users: [{ id: 'lu1', username: 'u', display_name: 'U' }]
    });

    const names = loadDictionaryNames({
      guildId: 'lg1',
      channelIds: ['lc1'],
      userIds: ['lu1']
    });
    expect(names.guilds).toEqual([{ id: 'lg1', name: 'Loaded' }]);
    expect(names.channels).toEqual([{ id: 'lc1', name: 'chan' }]);
    expect(names.users).toEqual([
      { id: 'lu1', username: 'u', displayName: 'U' }
    ]);

    // no changed ids -> empty shape
    expect(
      loadDictionaryNames({ guildId: null, channelIds: [], userIds: [] })
    ).toEqual({});
  });

  test('loadAllDictionaryNames returns every named row (for graph-resync)', () => {
    syncDictionary({
      guild: { id: 'ag1', name: 'All' },
      channels: [
        { id: 'ac1', name: 'named' },
        { id: 'ac2' } // no name -> excluded
      ],
      users: [
        { id: 'au1', username: 'named-user' },
        { id: 'au2' } // no names -> excluded
      ]
    });

    const all = loadAllDictionaryNames();
    expect(all.guilds).toEqual(
      expect.arrayContaining([{ id: 'ag1', name: 'All' }])
    );
    expect(all.channels?.map((c) => c.id)).toContain('ac1');
    expect(all.channels?.map((c) => c.id)).not.toContain('ac2');
    expect(all.users?.map((u) => u.id)).toContain('au1');
    expect(all.users?.map((u) => u.id)).not.toContain('au2');
  });

  test('ingest keeps names from the dictionary and only widens the seen-window', () => {
    syncDictionary({
      users: [{ id: 'iu1', username: 'ivan', display_name: 'Ivan' }]
    });

    ingestBatch('b1', {
      guild: { id: 'ig1' },
      channel: { id: 'ic1', type: 'text' },
      messages: [
        {
          id: 'im1',
          author: { id: 'iu1' },
          content: 'ahoj',
          created_at: '2026-08-24T10:00:00.000Z'
        },
        {
          id: 'im2',
          author: { id: 'iu1' },
          content: 'jak je',
          created_at: '2026-08-25T10:00:00.000Z'
        }
      ]
    });

    const u = db.select().from(users).where(eq(users.id, 'iu1')).get();
    expect(u?.username).toBe('ivan'); // ingest did not overwrite the dictionary name
    expect(u?.messageCount).toBe(2);
    // pre-seeded row had NULL seen columns; ingest back-fills them (coalesce guard)
    expect(u?.firstSeenAt).not.toBeNull();
    expect(u?.lastSeenAt).not.toBeNull();

    // skeleton rows for an unknown guild/channel come in name-less
    expect(
      db.select().from(guilds).where(eq(guilds.id, 'ig1')).get()?.name
    ).toBeNull();
    expect(
      db.select().from(channels).where(eq(channels.id, 'ic1')).get()?.name
    ).toBeNull();
  });

  test('a section-scoped sync does not touch other sections', () => {
    syncDictionary({
      guild: { id: 'g2', name: 'Another' },
      channels: [{ id: 'c9', name: 'x' }]
    });
    const before = db
      .select()
      .from(guilds)
      .where(eq(guilds.id, 'g2'))
      .get()?.namesSyncedAt;

    syncDictionary({ users: [{ id: 'u9', username: 'z' }] });
    const after = db
      .select()
      .from(guilds)
      .where(eq(guilds.id, 'g2'))
      .get()?.namesSyncedAt;
    expect(after).toBe(before);
    expect(
      db.select().from(channels).where(eq(channels.id, 'c9')).get()?.name
    ).toBe('x');
  });
});
