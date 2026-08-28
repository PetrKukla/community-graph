import type { DiscussionGraphPayload, GraphEntity, GraphPair } from "./types";

/** Raw, SQLite-shaped input for one discussion. Produced by graphWriteRepository. */
export interface DiscussionWriteInput {
  discussion: {
    id: string;
    channelId: string;
    blockStartAt: string;
    blockEndAt: string;
    continuationOfDiscussionId: string | null;
    continuationReason: string | null;
  };
  enrichment: {
    title: string | null;
    summary: string | null;
    topics: string[] | null;
    entities: { name: string; type: string }[] | null;
    sentiment: string | null;
    sentimentScore: number | null;
    language: string | null;
    discussionType: string | null;
    resolved: boolean | null;
    embedding: Float32Array | null;
  };
  channel: { id: string; name: string | null; guildId: string | null };
  participants: {
    id: string;
    username: string | null;
    displayName: string | null;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
    userMessageCount: number;
    messageCount: number;
    firstMessageAt: string;
    lastMessageAt: string;
  }[];
}

/** Beyond this many topics/entities we skip the O(n^2) cooccurrence edges for that discussion. */
const MAX_COOCCURRENCE_TERMS = 12;

function normaliseLabel(raw: string): string {
  return raw.replace(/\s+/gu, " ").trim();
}

/** Trim/collapse, drop empties, de-dupe case-insensitively keeping the first casing seen. */
function canonicalTopics(raw: string[] | null): string[] {
  const seen = new Map<string, string>();
  for (const item of raw ?? []) {
    const label = normaliseLabel(item);
    if (!label) continue;
    const key = label.toLowerCase();
    if (!seen.has(key)) seen.set(key, label);
  }
  return [...seen.values()];
}

function canonicalEntities(raw: { name: string; type: string }[] | null): GraphEntity[] {
  const seen = new Map<string, GraphEntity>();
  for (const item of raw ?? []) {
    const name = normaliseLabel(item.name);
    if (!name) continue;
    const type = normaliseLabel(item.type).toLowerCase() || "other";
    const key = `${type}:${name.toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, { key, name, type });
  }
  return [...seen.values()];
}

/** All unordered pairs of a sorted list, emitted as a < b so no reverse-direction duplicate edge is made. */
function pairsOf(sortedKeys: string[]): GraphPair[] {
  if (sortedKeys.length > MAX_COOCCURRENCE_TERMS) return [];
  const pairs: GraphPair[] = [];
  for (let i = 0; i < sortedKeys.length; i++) {
    for (let j = i + 1; j < sortedKeys.length; j++) {
      pairs.push({ a: sortedKeys[i]!, b: sortedKeys[j]! });
    }
  }
  return pairs;
}

/**
 * Turns the SQLite view of an enriched discussion into a fully-normalised graph payload:
 * canonical topic/entity labels, de-duped, alphabetical cooccurrence pairs, and the discussion
 * embedding only when its dimension matches the configured vector index.
 */
export function buildDiscussionGraphPayload(input: DiscussionWriteInput, embeddingDimension: number): DiscussionGraphPayload {
  const { discussion, enrichment, channel, participants } = input;

  const topics = canonicalTopics(enrichment.topics);
  const entities = canonicalEntities(enrichment.entities);
  const messageCount = participants.reduce((sum, p) => sum + p.messageCount, 0);

  const embedding =
    enrichment.embedding && enrichment.embedding.length === embeddingDimension
      ? Array.from(enrichment.embedding)
      : null;

  const sortedTopics = [...topics].sort((a, b) => a.localeCompare(b));
  const sortedEntityKeys = entities.map((e) => e.key).sort((a, b) => a.localeCompare(b));

  return {
    discussion: {
      id: discussion.id,
      channelId: discussion.channelId,
      startedAt: discussion.blockStartAt,
      endedAt: discussion.blockEndAt,
      messageCount,
      participantCount: participants.length,
      title: enrichment.title,
      summary: enrichment.summary,
      topics,
      sentiment: enrichment.sentiment,
      sentimentScore: enrichment.sentimentScore,
      language: enrichment.language,
      discussionType: enrichment.discussionType,
      resolved: enrichment.resolved,
      embedding,
    },
    channel,
    participants,
    topics,
    entities,
    topicPairs: pairsOf(sortedTopics),
    entityPairs: pairsOf(sortedEntityKeys),
    continuation: discussion.continuationOfDiscussionId
      ? {
          targetDiscussionId: discussion.continuationOfDiscussionId,
          reason: discussion.continuationReason ?? "explicit_reply",
          similarityScore: null,
        }
      : null,
  };
}
