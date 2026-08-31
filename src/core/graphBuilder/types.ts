/** Everything needed to write one enriched discussion into the graph, already normalised. */
export interface DiscussionGraphPayload {
  discussion: {
    id: string;
    channelId: string;
    startedAt: string;
    endedAt: string;
    messageCount: number;
    participantCount: number;
    title: string | null;
    summary: string | null;
    topics: string[]; // denormalised, canonical
    sentiment: string | null;
    sentimentScore: number | null;
    language: string | null;
    discussionType: string | null;
    resolved: boolean | null;
    embedding: number[] | null; // length must match the configured vector dimension, else omitted
  };
  channel: {
    id: string;
    name: string | null;
    guildId: string | null;
    guildName: string | null;
  };
  participants: GraphParticipant[];
  topics: string[]; // canonical, de-duped
  entities: GraphEntity[]; // canonical, de-duped by key
  topicPairs: GraphPair[]; // alphabetical a < b
  entityPairs: GraphPair[]; // alphabetical keyA < keyB
  continuation: GraphContinuation | null;
}

export interface GraphParticipant {
  id: string;
  username: string | null;
  displayName: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  userMessageCount: number; // global count from the users table
  messageCount: number; // messages in THIS discussion
  firstMessageAt: string;
  lastMessageAt: string;
}

export interface GraphEntity {
  key: string; // `${type}:${name}`
  name: string;
  type: string;
}

export interface GraphPair {
  a: string;
  b: string;
}

export interface GraphContinuation {
  targetDiscussionId: string;
  reason: string; // explicit_reply | semantic_similarity
  similarityScore: number | null;
}
