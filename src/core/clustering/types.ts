export interface ClusterableMessage {
  id: string;
  authorId: string;
  content: string;
  createdAt: string; // ISO8601
  replyToMessageId: string | null;
  threadId: string | null;
  mentions: string[] | null;
  wordCount: number;
}

export interface MessageAssignment {
  messageId: string;
  discussionId: string; // existing (reply target / extended thread) or newly generated uuid
  isNewDiscussion: boolean;
  continuationOfDiscussionId?: string;
  continuationReason?: 'explicit_reply';
}

export interface FinalizedDiscussion {
  id: string;
  channelId: string;
  threadId: string | null;
  blockStartAt: string;
  blockEndAt: string;
  messageCount: number;
  centroidEmbedding: Float32Array | null;
  continuationOfDiscussionId?: string;
  continuationReason?: 'explicit_reply';
  /** true when this row already existed (thread extension) and should be UPDATEd, not INSERTed */
  isExtension: boolean;
}

export interface ClusterBlockResult {
  assignments: MessageAssignment[];
  discussions: FinalizedDiscussion[];
}
