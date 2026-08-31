import neo4j, { type Driver, type Node, type Record as Neo4jRecord, type Relationship } from "neo4j-driver";
import { config } from "../../config/config";
import type {
  GraphOverviewOptions,
  GraphStore,
  GraphView,
  GraphViewEdge,
  GraphViewNode,
} from "../../core/ports/GraphStore";
import type { DiscussionGraphPayload } from "../../core/graphBuilder/types";
import type {
  DiscussionCore,
  DiscussionMatch,
  ExpansionMatch,
  ExpansionVia,
  LabelVocab,
  RetrievalFilters,
} from "../../core/query/types";
import { getNeo4jDriver } from "./driver";

const KNOWN_LABELS = ["Discussion", "Topic", "Entity", "User", "Channel", "Guild"];

function primaryLabel(labels: readonly string[]): string {
  return labels.find((l) => KNOWN_LABELS.includes(l)) ?? labels[0] ?? "Node";
}

function nodeCaption(label: string, props: Record<string, unknown>): string {
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = props[k];
      if (typeof v === "string" && v.trim()) return v;
    }
    return undefined;
  };
  switch (label) {
    case "Topic":
    case "Entity":
      return pick("name") ?? "(bez názvu)";
    case "Discussion":
      return pick("title", "summary") ?? "(diskuze bez názvu)";
    case "Channel":
      return pick("name") ?? "(kanál)";
    case "Guild":
      return pick("name") ?? "(server)";
    case "User":
      return pick("display_name", "username") ?? "(uživatel)";
    default:
      return pick("name", "title", "id") ?? label;
  }
}

function toViewNode(node: Node, degree: number): GraphViewNode {
  const label = primaryLabel(node.labels);
  const props = node.properties as Record<string, unknown>;
  return { id: node.elementId, label, caption: nodeCaption(label, props), props, degree };
}

function toViewEdge(rel: Relationship): GraphViewEdge {
  return {
    id: rel.elementId,
    source: rel.startNodeElementId,
    target: rel.endNodeElementId,
    type: rel.type,
    props: rel.properties as Record<string, unknown>,
  };
}

const CONSTRAINTS = [
  "CREATE CONSTRAINT user_id IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE",
  "CREATE CONSTRAINT channel_id IF NOT EXISTS FOR (c:Channel) REQUIRE c.id IS UNIQUE",
  "CREATE CONSTRAINT discussion_id IF NOT EXISTS FOR (d:Discussion) REQUIRE d.id IS UNIQUE",
  "CREATE CONSTRAINT topic_name IF NOT EXISTS FOR (t:Topic) REQUIRE t.name IS UNIQUE",
  "CREATE CONSTRAINT entity_key IF NOT EXISTS FOR (e:Entity) REQUIRE e.key IS UNIQUE",
  "CREATE CONSTRAINT guild_id IF NOT EXISTS FOR (g:Guild) REQUIRE g.id IS UNIQUE",
];

const MERGE_DISCUSSION_AND_CHANNEL = `
MERGE (c:Channel {id: $channel.id})
  ON CREATE SET c.name = $channel.name, c.guild_id = $channel.guildId
  ON MATCH SET c.name = coalesce($channel.name, c.name), c.guild_id = coalesce($channel.guildId, c.guild_id)
WITH c
FOREACH (_ IN CASE WHEN $channel.guildId IS NULL THEN [] ELSE [1] END |
  MERGE (g:Guild {id: $channel.guildId})
    ON CREATE SET g.name = $channel.guildName
    ON MATCH SET g.name = coalesce($channel.guildName, g.name)
  MERGE (c)-[:IN_GUILD]->(g)
)
WITH c
MERGE (d:Discussion {id: $d.id})
SET d.channel_id = $d.channelId,
    d.started_at = $d.startedAt,
    d.ended_at = $d.endedAt,
    d.message_count = $d.messageCount,
    d.participant_count = $d.participantCount,
    d.title = $d.title,
    d.summary = $d.summary,
    d.topics = $d.topics,
    d.sentiment = $d.sentiment,
    d.sentiment_score = $d.sentimentScore,
    d.language = $d.language,
    d.discussion_type = $d.discussionType,
    d.resolved = $d.resolved
MERGE (d)-[:OCCURRED_IN]->(c)
`;

const SET_DISCUSSION_EMBEDDING = `
MATCH (d:Discussion {id: $id})
CALL db.create.setNodeVectorProperty(d, 'embedding', $embedding)
`;

const MERGE_PARTICIPANTS = `
MATCH (d:Discussion {id: $id})
UNWIND $participants AS p
  MERGE (u:User {id: p.id})
    ON CREATE SET u.username = p.username, u.display_name = p.displayName,
                  u.first_seen_at = p.firstSeenAt, u.last_seen_at = p.lastSeenAt,
                  u.message_count = p.userMessageCount
    ON MATCH SET u.username = coalesce(p.username, u.username),
                 u.display_name = coalesce(p.displayName, u.display_name),
                 u.first_seen_at = coalesce(p.firstSeenAt, u.first_seen_at),
                 u.last_seen_at = coalesce(p.lastSeenAt, u.last_seen_at),
                 u.message_count = p.userMessageCount
  MERGE (u)-[r:PARTICIPATED_IN]->(d)
    SET r.message_count = p.messageCount,
        r.first_message_at = p.firstMessageAt,
        r.last_message_at = p.lastMessageAt
`;

const MERGE_TOPICS = `
MATCH (d:Discussion {id: $id})
UNWIND $topics AS name
  MERGE (t:Topic {name: name})
    ON CREATE SET t.created_at = $now, t.discussion_count = 1
    ON MATCH SET t.discussion_count = t.discussion_count + 1
  MERGE (d)-[:DISCUSSES]->(t)
`;

const MERGE_ENTITIES = `
MATCH (d:Discussion {id: $id})
UNWIND $entities AS ent
  MERGE (e:Entity {key: ent.key})
    ON CREATE SET e.name = ent.name, e.type = ent.type, e.created_at = $now, e.mention_count = 1
    ON MATCH SET e.mention_count = e.mention_count + 1
  MERGE (d)-[m:MENTIONS]->(e)
    ON CREATE SET m.count = 1
    ON MATCH SET m.count = m.count + 1
`;

const MERGE_TOPIC_COOCCURRENCE = `
UNWIND $pairs AS pair
  MERGE (a:Topic {name: pair.a})
  MERGE (b:Topic {name: pair.b})
  MERGE (a)-[r:COOCCURS_WITH]->(b)
    ON CREATE SET r.count = 1, r.last_seen_at = $now
    ON MATCH SET r.count = r.count + 1, r.last_seen_at = $now
`;

const MERGE_ENTITY_COOCCURRENCE = `
UNWIND $pairs AS pair
  MERGE (a:Entity {key: pair.a})
  MERGE (b:Entity {key: pair.b})
  MERGE (a)-[r:COOCCURS_WITH]->(b)
    ON CREATE SET r.count = 1, r.last_seen_at = $now
    ON MATCH SET r.count = r.count + 1, r.last_seen_at = $now
`;

const MERGE_INTERESTED_IN = `
UNWIND $participants AS p
  UNWIND $topics AS name
    MATCH (u:User {id: p.id})
    MATCH (t:Topic {name: name})
    MERGE (u)-[r:INTERESTED_IN]->(t)
      ON CREATE SET r.weight = p.messageCount, r.discussion_count = 1, r.last_interaction_at = $lastAt
      ON MATCH SET r.weight = r.weight + p.messageCount,
                   r.discussion_count = r.discussion_count + 1,
                   r.last_interaction_at = $lastAt
`;

const MERGE_CONTINUATION_OF = `
MATCH (d:Discussion {id: $id})
MERGE (target:Discussion {id: $targetId})
MERGE (d)-[r:CONTINUATION_OF]->(target)
  ON CREATE SET r.reason = $reason, r.similarity_score = $similarityScore, r.created_at = $now
  ON MATCH SET r.reason = $reason, r.similarity_score = coalesce($similarityScore, r.similarity_score)
`;

const DISCUSSION_RETURN = `
  d.id AS id, d.title AS title, d.summary AS summary, d.channel_id AS channelId,
  d.discussion_type AS discussionType, d.sentiment AS sentiment, d.resolved AS resolved,
  d.started_at AS startedAt
`;

const VECTOR_SEARCH = `
CALL db.index.vector.queryNodes('discussion_embedding_idx', $fetchK, $vector) YIELD node AS d, score
WHERE ($channelIds IS NULL OR d.channel_id IN $channelIds)
  AND ($types IS NULL OR d.discussion_type IN $types)
  AND ($since IS NULL OR d.started_at >= $since)
RETURN ${DISCUSSION_RETURN}, score
ORDER BY score DESC
LIMIT $k
`;

const ANCHOR_SEARCH = `
CALL db.index.fulltext.queryNodes('graph_labels_fts', $lucene) YIELD node, score
WITH node, score WHERE node:Topic OR node:Entity
WITH node, score ORDER BY score DESC LIMIT $anchorNodeLimit
MATCH (node)<-[:DISCUSSES|MENTIONS]-(d:Discussion)
WHERE ($channelIds IS NULL OR d.channel_id IN $channelIds)
  AND ($types IS NULL OR d.discussion_type IN $types)
  AND ($since IS NULL OR d.started_at >= $since)
WITH DISTINCT d
RETURN ${DISCUSSION_RETURN}, d.embedding AS embedding
LIMIT $limit
`;

const EXPAND = `
UNWIND $seedIds AS sid
MATCH (seed:Discussion {id: sid})
CALL {
  WITH seed
  MATCH (seed)-[:CONTINUATION_OF]-(n:Discussion) RETURN n, 'continuation' AS via
  UNION
  WITH seed
  MATCH (seed)-[:DISCUSSES]->(:Topic)<-[:DISCUSSES]-(n:Discussion) RETURN n, 'shared_topic' AS via
  UNION
  WITH seed
  MATCH (seed)-[:MENTIONS]->(:Entity)<-[:MENTIONS]-(n:Discussion) RETURN n, 'shared_entity' AS via
  UNION
  WITH seed
  MATCH (seed)-[:DISCUSSES]->(:Topic)-[:COOCCURS_WITH]-(:Topic)<-[:DISCUSSES]-(n:Discussion) RETURN n, 'cooccurring_topic' AS via
}
WITH sid AS seedId, n AS d, via
WHERE d.id <> seedId
RETURN DISTINCT seedId, via, ${DISCUSSION_RETURN}, d.embedding AS embedding
LIMIT $totalLimit
`;

const DISCUSSION_CORES = `
UNWIND $ids AS wantedId
MATCH (d:Discussion {id: wantedId})
OPTIONAL MATCH (d)-[:OCCURRED_IN]->(c:Channel)
OPTIONAL MATCH (d)<-[pi:PARTICIPATED_IN]-(u:User)
WITH d, c, collect(DISTINCT { name: coalesce(u.display_name, u.username, u.id), messageCount: pi.message_count }) AS participants
OPTIONAL MATCH (d)-[:MENTIONS]->(e:Entity)
WITH d, c, participants, collect(DISTINCT e.name) AS entities
RETURN d.id AS id, d.title AS title, d.summary AS summary, coalesce(d.topics, []) AS topics,
       d.sentiment AS sentiment, d.discussion_type AS discussionType, d.resolved AS resolved,
       d.started_at AS startedAt, d.message_count AS messageCount, d.participant_count AS participantCount,
       c.id AS channelId, c.name AS channelName, participants, entities
`;

const VOCAB_TOPICS = `MATCH (t:Topic) RETURN t.name AS name ORDER BY coalesce(t.discussion_count, 0) DESC LIMIT $limit`;
const VOCAB_ENTITIES = `MATCH (e:Entity) RETURN e.name AS name ORDER BY coalesce(e.mention_count, 0) DESC LIMIT $limit`;

/** Turn plain label strings into a safe Lucene OR query of quoted phrases. */
function toLucene(terms: string[]): string {
  return terms
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => `"${t.replace(/[\\"]/g, "\\$&")}"`)
    .join(" OR ");
}

function filterParams(f: RetrievalFilters) {
  return {
    channelIds: f.channelIds && f.channelIds.length > 0 ? f.channelIds : null,
    types: f.discussionTypes && f.discussionTypes.length > 0 ? f.discussionTypes : null,
    since: f.since ?? null,
  };
}

function rowToMatch(rec: Neo4jRecord): DiscussionMatch {
  const emb = rec.has("embedding") ? (rec.get("embedding") as number[] | null) : undefined;
  return {
    id: rec.get("id") as string,
    title: (rec.get("title") as string | null) ?? null,
    summary: (rec.get("summary") as string | null) ?? null,
    channelId: (rec.get("channelId") as string | null) ?? null,
    discussionType: (rec.get("discussionType") as string | null) ?? null,
    sentiment: (rec.get("sentiment") as string | null) ?? null,
    resolved: (rec.get("resolved") as boolean | null) ?? null,
    startedAt: (rec.get("startedAt") as string | null) ?? null,
    score: rec.has("score") ? Number(rec.get("score")) : 0,
    ...(emb !== undefined ? { embedding: emb } : {}),
  };
}

export class Neo4jGraphStore implements GraphStore {
  readonly #driver: Driver;
  #bootstrapped = false;

  constructor(driver: Driver = getNeo4jDriver()) {
    this.#driver = driver;
  }

  async verifyConnectivity(): Promise<void> {
    await this.#driver.verifyConnectivity();
  }

  async bootstrap(): Promise<void> {
    if (this.#bootstrapped) return;
    const session = this.#driver.session();
    try {
      for (const stmt of CONSTRAINTS) await session.run(stmt);
      await session.run(
        `CREATE VECTOR INDEX discussion_embedding_idx IF NOT EXISTS
         FOR (d:Discussion) ON d.embedding
         OPTIONS { indexConfig: {
           \`vector.dimensions\`: ${config.embedding.dimensions},
           \`vector.similarity_function\`: 'cosine'
         } }`,
      );
      // Fulltext over label text - lexical anchoring for the query pipeline (Část 3).
      await session.run(
        `CREATE FULLTEXT INDEX graph_labels_fts IF NOT EXISTS
         FOR (n:Topic|Entity|Discussion|Guild) ON EACH [n.name, n.title]`,
      );
      this.#bootstrapped = true;
    } finally {
      await session.close();
    }
  }

  async writeDiscussion(payload: DiscussionGraphPayload): Promise<void> {
    const now = new Date().toISOString();
    const { discussion: d, channel, participants, topics, entities, topicPairs, entityPairs, continuation } = payload;
    const { embedding, ...dScalars } = d; // keep the big vector out of the node-property query
    const session = this.#driver.session();
    try {
      await session.executeWrite(async (tx) => {
        await tx.run(MERGE_DISCUSSION_AND_CHANNEL, { d: dScalars, channel });
        if (embedding) await tx.run(SET_DISCUSSION_EMBEDDING, { id: d.id, embedding });
        if (participants.length > 0) await tx.run(MERGE_PARTICIPANTS, { id: d.id, participants });
        if (topics.length > 0) await tx.run(MERGE_TOPICS, { id: d.id, topics, now });
        if (entities.length > 0) await tx.run(MERGE_ENTITIES, { id: d.id, entities, now });
        if (topicPairs.length > 0) await tx.run(MERGE_TOPIC_COOCCURRENCE, { pairs: topicPairs, now });
        if (entityPairs.length > 0) await tx.run(MERGE_ENTITY_COOCCURRENCE, { pairs: entityPairs, now });
        if (participants.length > 0 && topics.length > 0) {
          await tx.run(MERGE_INTERESTED_IN, { participants, topics, lastAt: d.endedAt });
        }
        if (continuation) {
          await tx.run(MERGE_CONTINUATION_OF, {
            id: d.id,
            targetId: continuation.targetDiscussionId,
            reason: continuation.reason,
            similarityScore: continuation.similarityScore,
            now,
          });
        }
      });
    } finally {
      await session.close();
    }
  }

  /** Real total degree for a set of nodes, keyed by elementId. */
  async #degrees(ids: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (ids.length === 0) return out;
    const session = this.#driver.session({ defaultAccessMode: "READ" });
    try {
      const res = await session.run(
        "MATCH (n) WHERE elementId(n) IN $ids RETURN elementId(n) AS id, count{ (n)--() } AS degree",
        { ids },
      );
      for (const rec of res.records) out.set(rec.get("id") as string, Number(rec.get("degree")));
    } finally {
      await session.close();
    }
    return out;
  }

  async #assembleView(nodes: Map<string, Node>, edges: Map<string, Relationship>): Promise<GraphView> {
    const degrees = await this.#degrees([...nodes.keys()]);
    return {
      nodes: [...nodes.values()].map((n) => toViewNode(n, degrees.get(n.elementId) ?? 0)),
      edges: [...edges.values()].map(toViewEdge),
    };
  }

  async graphOverview(options: GraphOverviewOptions): Promise<GraphView> {
    const limit = Math.max(20, options.limit);
    const discussionLimit = Math.max(10, Math.ceil(limit / 6));
    const relLimit = limit * 4;
    const session = this.#driver.session({ defaultAccessMode: "READ" });
    try {
      const res = await session.run(
        `MATCH (d:Discussion)
         WHERE $channelId IS NULL OR d.channel_id = $channelId
         WITH d ORDER BY d.started_at DESC LIMIT $discussionLimit
         MATCH (d)-[r]-(n)
         WITH d, r, n LIMIT $relLimit
         RETURN d, r, n`,
        // Cypher LIMIT rejects float params, and the driver serialises plain numbers as floats
        { channelId: options.channelId ?? null, discussionLimit: neo4j.int(discussionLimit), relLimit: neo4j.int(relLimit) },
      );

      const nodes = new Map<string, Node>();
      const edges = new Map<string, Relationship>();
      for (const rec of res.records) {
        const d = rec.get("d") as Node;
        const n = rec.get("n") as Node;
        const r = rec.get("r") as Relationship;
        nodes.set(d.elementId, d);
        if (nodes.size <= limit) nodes.set(n.elementId, n);
        if (nodes.has(r.startNodeElementId) && nodes.has(r.endNodeElementId)) edges.set(r.elementId, r);
      }
      return this.#assembleView(nodes, edges);
    } finally {
      await session.close();
    }
  }

  async nodeNeighbors(id: string, limit: number): Promise<GraphView> {
    const session = this.#driver.session({ defaultAccessMode: "READ" });
    try {
      const res = await session.run(
        `MATCH (n) WHERE elementId(n) = $id
         MATCH (n)-[r]-(m)
         RETURN n, r, m LIMIT $limit`,
        { id, limit: neo4j.int(Math.max(1, Math.min(limit, 200))) },
      );
      const nodes = new Map<string, Node>();
      const edges = new Map<string, Relationship>();
      for (const rec of res.records) {
        const n = rec.get("n") as Node;
        const m = rec.get("m") as Node;
        const r = rec.get("r") as Relationship;
        nodes.set(n.elementId, n);
        nodes.set(m.elementId, m);
        edges.set(r.elementId, r);
      }
      return this.#assembleView(nodes, edges);
    } finally {
      await session.close();
    }
  }

  async searchNodes(query: string, limit: number): Promise<GraphViewNode[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const session = this.#driver.session({ defaultAccessMode: "READ" });
    try {
      const res = await session.run(
        `MATCH (n)
         WHERE (n:Topic AND toLower(n.name) CONTAINS $q)
            OR (n:Entity AND toLower(n.name) CONTAINS $q)
            OR (n:Discussion AND n.title IS NOT NULL AND toLower(n.title) CONTAINS $q)
            OR (n:User AND n.username IS NOT NULL AND toLower(n.username) CONTAINS $q)
            OR (n:Guild AND n.name IS NOT NULL AND toLower(n.name) CONTAINS $q)
         RETURN n LIMIT $limit`,
        { q, limit: neo4j.int(Math.max(1, Math.min(limit, 50))) },
      );
      const nodes = res.records.map((rec) => rec.get("n") as Node);
      const degrees = await this.#degrees(nodes.map((n) => n.elementId));
      return nodes.map((n) => toViewNode(n, degrees.get(n.elementId) ?? 0));
    } finally {
      await session.close();
    }
  }

  // --- read-only retrieval for querying (Část 3) -------------------------------

  async sampleLabelVocab(limit: number): Promise<LabelVocab> {
    const session = this.#driver.session({ defaultAccessMode: "READ" });
    const lim = { limit: neo4j.int(Math.max(1, limit)) };
    try {
      const t = await session.run(VOCAB_TOPICS, lim);
      const e = await session.run(VOCAB_ENTITIES, lim);
      const names = (recs: Neo4jRecord[]) =>
        recs.map((r) => r.get("name") as string | null).filter((s): s is string => Boolean(s));
      return { topics: names(t.records), entities: names(e.records) };
    } finally {
      await session.close();
    }
  }

  async searchDiscussionsByVector(
    vector: Float32Array,
    k: number,
    filters: RetrievalFilters,
  ): Promise<DiscussionMatch[]> {
    const fp = filterParams(filters);
    const hasFilter = Boolean(fp.channelIds || fp.types || fp.since);
    const kk = Math.max(1, k);
    const session = this.#driver.session({ defaultAccessMode: "READ" });
    try {
      const res = await session.run(VECTOR_SEARCH, {
        vector: Array.from(vector),
        fetchK: neo4j.int(hasFilter ? kk * 5 : kk),
        k: neo4j.int(kk),
        ...fp,
      });
      return res.records.map(rowToMatch);
    } finally {
      await session.close();
    }
  }

  async getDiscussionsByAnchors(
    topics: string[],
    entities: string[],
    limit: number,
    filters: RetrievalFilters,
  ): Promise<DiscussionMatch[]> {
    const lucene = toLucene([...topics, ...entities]);
    if (!lucene) return [];
    const fp = filterParams(filters);
    const session = this.#driver.session({ defaultAccessMode: "READ" });
    try {
      const res = await session.run(ANCHOR_SEARCH, {
        lucene,
        anchorNodeLimit: neo4j.int(Math.max(1, limit * 2)),
        limit: neo4j.int(Math.max(1, limit)),
        ...fp,
      });
      return res.records.map(rowToMatch);
    } catch (err) {
      // A malformed Lucene query or a missing fulltext index must not sink the whole request -
      // anchoring is one of several retrieval signals.
      console.error(`[query] anchor search failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    } finally {
      await session.close();
    }
  }

  async expandDiscussions(seedIds: string[], totalLimit: number): Promise<ExpansionMatch[]> {
    if (seedIds.length === 0) return [];
    const session = this.#driver.session({ defaultAccessMode: "READ" });
    try {
      const res = await session.run(EXPAND, {
        seedIds,
        totalLimit: neo4j.int(Math.max(1, totalLimit)),
      });
      return res.records.map((rec) => ({
        ...rowToMatch(rec),
        seedId: rec.get("seedId") as string,
        via: rec.get("via") as ExpansionVia,
      }));
    } finally {
      await session.close();
    }
  }

  async getDiscussionCores(ids: string[]): Promise<DiscussionCore[]> {
    if (ids.length === 0) return [];
    const session = this.#driver.session({ defaultAccessMode: "READ" });
    try {
      const res = await session.run(DISCUSSION_CORES, { ids });
      return res.records.map((rec) => {
        const participants = ((rec.get("participants") as Array<{ name: string | null; messageCount: number | null }>) ?? [])
          .filter((p) => p && p.name)
          .map((p) => ({ name: p.name as string, messageCount: p.messageCount ?? null }))
          .sort((a, b) => (b.messageCount ?? 0) - (a.messageCount ?? 0));
        return {
          id: rec.get("id") as string,
          title: (rec.get("title") as string | null) ?? null,
          summary: (rec.get("summary") as string | null) ?? null,
          topics: ((rec.get("topics") as (string | null)[]) ?? []).filter((s): s is string => Boolean(s)),
          entities: ((rec.get("entities") as (string | null)[]) ?? []).filter((s): s is string => Boolean(s)),
          sentiment: (rec.get("sentiment") as string | null) ?? null,
          discussionType: (rec.get("discussionType") as string | null) ?? null,
          resolved: (rec.get("resolved") as boolean | null) ?? null,
          startedAt: (rec.get("startedAt") as string | null) ?? null,
          messageCount: rec.get("messageCount") === null ? null : Number(rec.get("messageCount")),
          participantCount: rec.get("participantCount") === null ? null : Number(rec.get("participantCount")),
          channelId: (rec.get("channelId") as string | null) ?? null,
          channelName: (rec.get("channelName") as string | null) ?? null,
          participants,
        };
      });
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    // driver lifetime is managed by the shared singleton; nothing per-store to close
  }
}
