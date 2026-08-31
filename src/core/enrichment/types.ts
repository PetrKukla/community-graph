/** A message as handed to the LLM for enrichment. */
export interface EnrichableMessage {
  id: string;
  authorId: string;
  authorLabel: string; // display name / username / author id, whatever is available
  content: string;
  createdAt: string; // ISO8601
}

/** The enrichment fields the LLM produces for one (sub-)discussion. */
export interface DiscussionEnrichment {
  title: string;
  summary: string;
  topics: string[];
  entities: { name: string; type: string }[];
  keyPoints: string[];
  sentiment: 'positive' | 'neutral' | 'negative' | 'mixed';
  sentimentScore: number;
  language: string;
  discussionType:
    | 'question'
    | 'help-request'
    | 'discussion'
    | 'announcement'
    | 'off-topic'
    | 'banter'
    | 'other';
  resolved: boolean | null;
}

/**
 * Outcome of enriching one staged discussion.
 *
 * - `kind: "single"` - the LLM returned one segment (or we collapsed to one); every message of
 *   the discussion stays on it, regardless of which ids the LLM listed.
 * - `kind: "split"` - the LLM returned >1 segments; each becomes its own child discussion and
 *   the messages are partitioned between them (messages the LLM forgot are attached to the
 *   chronologically nearest segment so nothing is dropped).
 */
export type EnrichmentOutcome =
  | {
      kind: 'single';
      enrichment: DiscussionEnrichment;
      embedding: Float32Array | null;
    }
  | { kind: 'split'; segments: EnrichmentSegment[] };

export interface EnrichmentSegment {
  messageIds: string[];
  blockStartAt: string;
  blockEndAt: string;
  enrichment: DiscussionEnrichment;
  embedding: Float32Array | null;
}
