import type { Driver } from "neo4j-driver";
import { config } from "../../config/config";
import type { GraphStore } from "../../core/ports/GraphStore";
import type { DiscussionGraphPayload } from "../../core/graphBuilder/types";
import { getNeo4jDriver } from "./driver";

const CONSTRAINTS = [
  "CREATE CONSTRAINT user_id IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE",
  "CREATE CONSTRAINT channel_id IF NOT EXISTS FOR (c:Channel) REQUIRE c.id IS UNIQUE",
  "CREATE CONSTRAINT discussion_id IF NOT EXISTS FOR (d:Discussion) REQUIRE d.id IS UNIQUE",
  "CREATE CONSTRAINT topic_name IF NOT EXISTS FOR (t:Topic) REQUIRE t.name IS UNIQUE",
  "CREATE CONSTRAINT entity_key IF NOT EXISTS FOR (e:Entity) REQUIRE e.key IS UNIQUE",
];

const MERGE_DISCUSSION_AND_CHANNEL = `
MERGE (c:Channel {id: $channel.id})
  ON CREATE SET c.name = $channel.name, c.guild_id = $channel.guildId
  ON MATCH SET c.name = coalesce($channel.name, c.name), c.guild_id = coalesce($channel.guildId, c.guild_id)
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

  async close(): Promise<void> {
    // driver lifetime is managed by the shared singleton; nothing per-store to close
  }
}
