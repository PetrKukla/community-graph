import { z } from 'zod';
import type {
  IngestBatchRequest,
  IngestMessage
} from '../../core/domain/types';

/**
 * Syrový tvar zprávy, jak vypadá v exportu/dumpu z databáze Discord bota:
 *
 * ```json
 * {
 *   "id": "1462881571076833455",
 *   "channel_id": "1462881475979640842",
 *   "author_id": "569933947585298482",
 *   "content": "Myslim si, že RTX 3090 je dneska stále ještě dobrá grafika.",
 *   "created_at": "2026-01-19T18:49:05.57+00:00",
 *   "deleted_at": null
 * }
 * ```
 *
 * Neznámé sloupce navíc se ignorují.
 */
export const rawMessageSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    channel_id: z.union([z.string(), z.number()]).transform(String),
    author_id: z.union([z.string(), z.number()]).transform(String),
    content: z.string().nullable().optional(),
    created_at: z.string().min(1),
    deleted_at: z.string().nullable().optional()
  })
  .passthrough();

export type RawMessage = z.infer<typeof rawMessageSchema>;

export const rawMessageArraySchema = z.array(rawMessageSchema);

export type DirNaming = 'name' | 'id' | 'name-id';

export interface ConvertOptions {
  /**
   * ID guildy (serveru) pro kanály, které nejsou v `guildMap`. Syrový dump guildu neobsahuje,
   * takže bez `guildMap` je povinné. S `guildMap` je to fallback pro nenamapované kanály.
   */
  guildId?: string;
  /** Nepovinný název guildy — jde do `guild.name` i do názvu složky (pro guildu z `guildId`). */
  guildName?: string;
  /** Nepovinná mapa `channel_id` -> `guild_id`, když dump míchá víc serverů. */
  guildMap?: Record<string, string>;
  /**
   * Nepovinná mapa `channel_id` -> název kanálu (a případně typ). Název jde do `channel.name`
   * i do názvu složky.
   */
  channels?: Record<string, { name?: string; type?: string }>;
  /**
   * Jak pojmenovat složky `<guild>/<channel>` ve výstupní struktuře:
   * - `name` (výchozí) — použije `guildName` / `channels[id].name`, kde chybí, spadne na ID;
   *   pokud by dvě různá ID spadla do stejné složky, skončí to chybou,
   * - `id` — vždy ID,
   * - `name-id` — `<název>-<id>` (čitelné a bez rizika kolize).
   */
  dirNames?: DirNaming;
  /** Zahrnout i smazané zprávy (`deleted_at != null`). Výchozí: `false`. */
  includeDeleted?: boolean;
  /** Zahrnout i zprávy s prázdným obsahem (typicky jen příloha/embed). Výchozí: `false`. */
  includeEmpty?: boolean;
}

/** Jedna dávka = jeden server + jeden kanál + jeden UTC den. */
export interface BatchFile {
  guildId: string;
  channelId: string;
  /** `YYYY-MM-DD` v UTC. */
  day: string;
  /** Relativní cesta ve výstupní složce: `<guild>/<channel>/<day>.json` (viz `dirNames`). */
  relativePath: string;
  /** Přesně tvar, který bere `POST /api/v1/batches`. */
  batch: IngestBatchRequest;
}

export interface ConvertResult {
  files: BatchFile[];
  stats: {
    inputCount: number;
    outputCount: number;
    guildCount: number;
    channelCount: number;
    dayCount: number;
    fileCount: number;
    skippedDeleted: number;
    skippedEmpty: number;
    skippedDuplicate: number;
  };
}

/** `2026-01-19T18:49:05.57+00:00` -> `2026-01-19T18:49:05.570Z` (a odmítne nesmysl). */
function normalizeTimestamp(value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`neplatný created_at: ${JSON.stringify(value)}`);
  }
  return new Date(ms).toISOString();
}

/** Nepustí do názvu složky oddělovače cest, `..` ani whitespace. */
function safeSegment(value: string): string {
  const cleaned = value
    .replace(/[/\\]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .trim();
  return cleaned === '' ? '_' : cleaned;
}

/** Název složky pro jeden server/kanál podle zvoleného režimu `dirNames`. */
function dirSegment(
  id: string,
  name: string | undefined,
  mode: DirNaming
): string {
  const cleanName = name?.trim();
  if (mode === 'id' || !cleanName) return safeSegment(id);
  if (mode === 'name-id') return `${safeSegment(cleanName)}-${safeSegment(id)}`;
  return safeSegment(cleanName);
}

/** Ohlídá, že dvě různá ID neskončí ve stejné složce (jinak by se dávky slily). */
function assertNoSegmentCollision(
  segById: Map<string, string>,
  kind: 'server' | 'kanál',
  parent?: string
): void {
  const idsBySeg = new Map<string, string[]>();
  for (const [id, seg] of segById) {
    const list = idsBySeg.get(seg) ?? [];
    list.push(id);
    idsBySeg.set(seg, list);
  }
  for (const [seg, ids] of idsBySeg) {
    if (ids.length > 1) {
      const where = parent ? ` (server ${parent})` : '';
      throw new Error(
        `složka "${seg}"${where} by patřila víc ${kind === 'server' ? 'serverům' : 'kanálům'}: ` +
          `${ids.join(', ')} — dej jim různé názvy, nebo použij --dir-names id | name-id`
      );
    }
  }
}

const KEY_SEP = ' ';

/**
 * Převede pole syrových zpráv na dávky rozdělené **po serverech → po kanálech → po dnech**.
 *
 * - server se určí z `guildMap[channel_id]`, jinak z `guildId`,
 * - den je UTC datum z `created_at` (`YYYY-MM-DD`),
 * - v rámci každé dávky se zprávy seřadí chronologicky a duplicitní `id` (v rámci
 *   server+kanál) se zahodí,
 * - defaultně se vynechají smazané a prázdné zprávy,
 * - `created_at` se znormalizuje na ISO 8601 v UTC (`...Z`),
 * - názvy složek řídí `dirNames` (výchozí `name`).
 */
export function rawMessagesToBatches(
  input: unknown,
  options: ConvertOptions
): ConvertResult {
  const fallbackGuildId = options.guildId?.trim() || undefined;
  const guildMap = options.guildMap ?? {};
  const dirNames: DirNaming = options.dirNames ?? 'name';

  const messages = rawMessageArraySchema.parse(input);

  const stats: ConvertResult['stats'] = {
    inputCount: messages.length,
    outputCount: 0,
    guildCount: 0,
    channelCount: 0,
    dayCount: 0,
    fileCount: 0,
    skippedDeleted: 0,
    skippedEmpty: 0,
    skippedDuplicate: 0
  };

  const groups = new Map<
    string,
    {
      guildId: string;
      channelId: string;
      day: string;
      messages: IngestMessage[];
    }
  >();
  const seen = new Set<string>(); // `${guildId}${SEP}${channelId}${SEP}${id}`
  const unmappedChannels = new Set<string>();

  for (const raw of messages) {
    if (raw.deleted_at != null && !options.includeDeleted) {
      stats.skippedDeleted++;
      continue;
    }

    const content = (raw.content ?? '').trim();
    if (content === '' && !options.includeEmpty) {
      stats.skippedEmpty++;
      continue;
    }

    const guildId = (guildMap[raw.channel_id] ?? fallbackGuildId)?.trim();
    if (!guildId) {
      unmappedChannels.add(raw.channel_id);
      continue;
    }

    const seenKey = guildId + KEY_SEP + raw.channel_id + KEY_SEP + raw.id;
    if (seen.has(seenKey)) {
      stats.skippedDuplicate++;
      continue;
    }
    seen.add(seenKey);

    const createdAt = normalizeTimestamp(raw.created_at);
    const day = createdAt.slice(0, 10);
    const groupKey = guildId + KEY_SEP + raw.channel_id + KEY_SEP + day;

    let group = groups.get(groupKey);
    if (!group) {
      group = { guildId, channelId: raw.channel_id, day, messages: [] };
      groups.set(groupKey, group);
    }

    group.messages.push({
      id: raw.id,
      author: { id: raw.author_id },
      content: raw.content ?? '',
      created_at: createdAt
    });
  }

  if (unmappedChannels.size > 0) {
    throw new Error(
      `chybí guild pro kanál(y): ${[...unmappedChannels].join(', ')} — dodej --guild ` +
        `nebo je přidej do --guild-map`
    );
  }

  // Názvy složek + kontrola kolizí (server úroveň i kanál úroveň v rámci serveru).
  const guildName = (guildId: string): string | undefined =>
    guildId === fallbackGuildId ? options.guildName : undefined;

  const guildSeg = new Map<string, string>();
  const channelSegByGuild = new Map<string, Map<string, string>>();
  for (const group of groups.values()) {
    if (!guildSeg.has(group.guildId)) {
      guildSeg.set(
        group.guildId,
        dirSegment(group.guildId, guildName(group.guildId), dirNames)
      );
    }
    let channels = channelSegByGuild.get(group.guildId);
    if (!channels) {
      channels = new Map<string, string>();
      channelSegByGuild.set(group.guildId, channels);
    }
    if (!channels.has(group.channelId)) {
      channels.set(
        group.channelId,
        dirSegment(
          group.channelId,
          options.channels?.[group.channelId]?.name,
          dirNames
        )
      );
    }
  }
  assertNoSegmentCollision(guildSeg, 'server');
  for (const [gid, channels] of channelSegByGuild) {
    assertNoSegmentCollision(channels, 'kanál', guildSeg.get(gid));
  }

  const guildIds = new Set<string>();
  const channelKeys = new Set<string>();
  const dayKeys = new Set<string>();

  const files: BatchFile[] = [];
  for (const group of groups.values()) {
    group.messages.sort((a, b) =>
      a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0
    );

    const meta = options.channels?.[group.channelId];
    const channel: IngestBatchRequest['channel'] = { id: group.channelId };
    if (meta?.type) channel.type = meta.type;

    // names travel out-of-band via POST /api/v1/dictionary now; batches are id-only
    const guild: IngestBatchRequest['guild'] = { id: group.guildId };

    const relativePath = `${guildSeg.get(group.guildId)!}/${channelSegByGuild
      .get(group.guildId)!
      .get(group.channelId)!}/${group.day}.json`;

    files.push({
      guildId: group.guildId,
      channelId: group.channelId,
      day: group.day,
      relativePath,
      batch: { guild, channel, messages: group.messages }
    });

    stats.outputCount += group.messages.length;
    guildIds.add(group.guildId);
    channelKeys.add(group.guildId + KEY_SEP + group.channelId);
    dayKeys.add(
      group.guildId + KEY_SEP + group.channelId + KEY_SEP + group.day
    );
  }

  files.sort((a, b) =>
    a.relativePath < b.relativePath
      ? -1
      : a.relativePath > b.relativePath
        ? 1
        : 0
  );

  stats.guildCount = guildIds.size;
  stats.channelCount = channelKeys.size;
  stats.dayCount = dayKeys.size;
  stats.fileCount = files.length;

  return { files, stats };
}
