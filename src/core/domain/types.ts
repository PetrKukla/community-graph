// Batches carry IDs only. Names (guild/channel/author) travel out-of-band through
// POST /api/v1/dictionary (Část 4.1); sending a name field here is a 400.
export interface IngestMessage {
  id: string;
  author: { id: string };
  content: string;
  created_at: string;
  reply_to_message_id?: string;
  thread_id?: string;
  mentions?: string[];
  attachments_count?: number;
}

export interface IngestBatchRequest {
  guild: { id: string };
  channel: { id: string; type?: string };
  messages: IngestMessage[];
}

export interface StoredMessage {
  id: string;
  channelId: string;
  guildId: string | null;
  authorId: string;
  content: string;
  createdAt: string;
  replyToMessageId: string | null;
  threadId: string | null;
  mentions: string[] | null;
  attachmentsCount: number;
  wordCount: number;
  discussionId: string | null;
}
