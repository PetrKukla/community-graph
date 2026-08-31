import { z } from 'zod';

export const DISCUSSION_TYPES = [
  'question',
  'help-request',
  'discussion',
  'announcement',
  'off-topic',
  'banter',
  'other'
] as const;

export const SENTIMENTS = ['positive', 'neutral', 'negative', 'mixed'] as const;

/** One coherent (sub-)discussion the LLM identified inside the staged cluster. */
export const enrichmentSegmentSchema = z.object({
  message_ids: z
    .array(z.string())
    .describe(
      'IDs of the messages that belong to this discussion. Ignored when you return a single segment; ' +
        'when you return several, any message id you leave out is auto-attached to the nearest segment.'
    ),
  title: z
    .string()
    .describe(
      "Short human title of the discussion (in the discussion's own language)."
    ),
  summary: z
    .string()
    .describe(
      'A few sentences capturing what was actually said and concluded.'
    ),
  topics: z
    .array(z.string())
    .describe(
      "Canonical short topic phrases, e.g. 'graphics cards', 'Arch Linux audio'."
    ),
  entities: z
    .array(z.object({ name: z.string(), type: z.string() }))
    .describe(
      'Named things: type is one of person|product|technology|organization|place|event|other.'
    ),
  key_points: z
    .array(z.string())
    .describe('Bullet-style facts, opinions or decisions worth remembering.'),
  sentiment: z.enum(SENTIMENTS),
  sentiment_score: z
    .number()
    .min(-1)
    .max(1)
    .describe('-1 very negative, 0 neutral, 1 very positive.'),
  language: z
    .string()
    .describe(
      "Dominant language of the discussion as an ISO 639-1 code, e.g. 'cs', 'en'."
    ),
  discussion_type: z.enum(DISCUSSION_TYPES),
  resolved: z
    .boolean()
    .nullable()
    .describe(
      'For question/help-request: true if resolved in-thread, false if not, null if N/A.'
    ),
  source_cluster: z
    .string()
    .optional()
    .describe(
      'Label of the input cluster (=== CLUSTER <label> ===) this segment came from. ' +
        'Omit on single-cluster calls; on batched calls fill it for every segment.'
    )
});

export const enrichmentResponseSchema = z.object({
  segments: z
    .array(enrichmentSegmentSchema)
    .min(1)
    .describe(
      'Return ONE segment if the cluster is a single coherent discussion. Return SEVERAL segments only if ' +
        'clearly separate conversations were merged together - one segment each, with their message_ids.'
    )
});

export type EnrichmentResponse = z.infer<typeof enrichmentResponseSchema>;
export type EnrichmentSegmentRaw = z.infer<typeof enrichmentSegmentSchema>;
