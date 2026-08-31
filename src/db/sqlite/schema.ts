import { sqliteTable, text, integer, real, blob, index } from "drizzle-orm/sqlite-core";

// name / type columns are owned exclusively by POST /api/v1/dictionary (Část 4.1); ingest only
// ever writes the id skeleton + activity timestamps. names_synced_at records when the dictionary
// endpoint last touched the name columns (observational: debug + "stáří názvů" in the web).
export const guilds = sqliteTable("guilds", {
  id: text("id").primaryKey(),
  name: text("name"),
  createdAt: text("created_at").notNull(),
  namesSyncedAt: text("names_synced_at"),
});

export const channels = sqliteTable("channels", {
  id: text("id").primaryKey(),
  guildId: text("guild_id").references(() => guilds.id),
  name: text("name"),
  type: text("type"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  namesSyncedAt: text("names_synced_at"),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username"),
  displayName: text("display_name"),
  // nullable so a dictionary pre-seed (names sent before the first message) can create the row;
  // ingest back-fills them with least()/greatest() on the first real message.
  firstSeenAt: text("first_seen_at"),
  lastSeenAt: text("last_seen_at"),
  messageCount: integer("message_count").notNull().default(0),
  namesSyncedAt: text("names_synced_at"),
});

export const ingestionBatches = sqliteTable("ingestion_batches", {
  id: text("id").primaryKey(),
  channelId: text("channel_id")
    .notNull()
    .references(() => channels.id),
  receivedAt: text("received_at").notNull(),
  messageCount: integer("message_count").notNull(),
  insertedCount: integer("inserted_count").notNull(),
  duplicateCount: integer("duplicate_count").notNull(),
});

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(), // Discord message id
    channelId: text("channel_id").notNull(),
    guildId: text("guild_id"),
    authorId: text("author_id").notNull(),
    content: text("content").notNull(),
    createdAt: text("created_at").notNull(), // ISO8601
    replyToMessageId: text("reply_to_message_id"),
    threadId: text("thread_id"),
    mentions: text("mentions", { mode: "json" }).$type<string[]>(),
    attachmentsCount: integer("attachments_count").notNull().default(0),
    wordCount: integer("word_count").notNull(),
    batchId: text("batch_id").references(() => ingestionBatches.id),
    ingestedAt: text("ingested_at").notNull(),
    processed: integer("processed").notNull().default(0), // 0=raw 1=clustered 2=enriched 3=graph-written
    discussionId: text("discussion_id"),
  },
  (table) => [
    index("idx_messages_channel_time").on(table.channelId, table.createdAt),
    index("idx_messages_thread").on(table.threadId),
    index("idx_messages_reply_to").on(table.replyToMessageId),
    index("idx_messages_processed").on(table.processed),
    index("idx_messages_discussion").on(table.discussionId),
  ],
);

export const channelCheckpoints = sqliteTable("channel_checkpoints", {
  channelId: text("channel_id").primaryKey(),
  lastClosedBlockEndAt: text("last_closed_block_end_at"),
  updatedAt: text("updated_at").notNull(),
});

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(), // cluster|enrich|graph_write (full_pipeline: budoucí zřetězení, není v1)
    status: text("status").notNull().default("pending"), // pending|running|completed|failed
    channelId: text("channel_id"),
    progressCurrent: integer("progress_current").notNull().default(0),
    progressTotal: integer("progress_total").notNull().default(0),
    result: text("result", { mode: "json" }).$type<Record<string, unknown>>(),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
  },
  (table) => [index("idx_jobs_channel_type").on(table.channelId, table.type)],
);

export const discussionsLocal = sqliteTable(
  "discussions_local",
  {
    id: text("id").primaryKey(), // uuid, stane se Neo4j Discussion.id
    channelId: text("channel_id").notNull(),
    threadId: text("thread_id"),
    blockStartAt: text("block_start_at").notNull(),
    blockEndAt: text("block_end_at").notNull(),
    status: text("status").notNull().default("clustering"), // clustering|needs_reenrichment|enriched|split|written
    messageCount: integer("message_count").notNull().default(0),
    centroidEmbedding: blob("centroid_embedding", { mode: "buffer" }),
    continuationOfDiscussionId: text("continuation_of_discussion_id"),
    continuationReason: text("continuation_reason"), // explicit_reply|semantic_similarity (semantic_similarity: fáze c, zatím nevyužito)
    // set on child rows produced when the LLM splits a discussion into smaller ones (krok 7);
    // the parent keeps status = 'split' and its messages are re-pointed to the children.
    parentDiscussionId: text("parent_discussion_id"),
  },
  (table) => [
    index("idx_discussions_channel_block").on(table.channelId, table.blockEndAt),
    index("idx_discussions_parent").on(table.parentDiscussionId),
  ],
);

// Instrumentation only - one row per completed (or failed) LLM call, powering the dashboard's
// AI view and the LLM aggregates in /api/v1/stats. Not an audit log of prompts (that stays in
// discussion_enrichment.raw_llm_response); a retention cap trims it on write.
export const llmCalls = sqliteTable(
  "llm_calls",
  {
    id: text("id").primaryKey(), // uuid
    provider: text("provider").notNull(), // anthropic|openai-compatible|gemini
    model: text("model").notNull(),
    context: text("context"), // request.context label (e.g. "discussion=abc (12 zpráv)")
    channelId: text("channel_id"),
    jobId: text("job_id"),
    startedAt: text("started_at").notNull(), // ISO8601
    durationMs: integer("duration_ms").notNull(),
    status: text("status").notNull(), // ok|error
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    error: text("error"),
  },
  (table) => [index("idx_llm_calls_started").on(table.startedAt), index("idx_llm_calls_model").on(table.model)],
);

export const discussionEnrichment = sqliteTable("discussion_enrichment", {
  discussionId: text("discussion_id")
    .primaryKey()
    .references(() => discussionsLocal.id),
  title: text("title"),
  summary: text("summary"),
  topics: text("topics", { mode: "json" }).$type<string[]>(),
  entities: text("entities", { mode: "json" }).$type<{ name: string; type: string }[]>(),
  keyPoints: text("key_points", { mode: "json" }).$type<string[]>(),
  sentiment: text("sentiment"), // positive|neutral|negative|mixed
  sentimentScore: real("sentiment_score"),
  language: text("language"),
  discussionType: text("discussion_type"), // question|help-request|discussion|announcement|off-topic|banter|other
  resolved: integer("resolved", { mode: "boolean" }),
  embedding: blob("embedding", { mode: "buffer" }), // discussion-level embedding of "title. summary. topics" (pro fázi c / Neo4j)
  rawLlmResponse: text("raw_llm_response"), // celá odpověď LLM, pro audit/ladění promptu
  enrichedAt: text("enriched_at").notNull(),
});
