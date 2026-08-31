import type { LLMProvider } from '../ports/LLMProvider';
import { buildPlannerUserPrompt, PLANNER_SYSTEM_PROMPT } from './prompt';
import { queryPlanSchema, type QueryPlan } from './schemas';
import type { LabelVocab } from './types';

/** Used when the planner LLM call fails - keeps the endpoint answering on vector search alone. */
export function fallbackPlan(question: string): QueryPlan {
  return {
    search_queries: [question.trim()].filter(Boolean).slice(0, 1),
    topics: [],
    entities: [],
    intent: 'other',
    preferred_discussion_types: [],
    answer_language: 'cs'
  };
}

/** Fáze 1 - one structured LLM call turns the raw question into a retrieval plan. */
export async function planQuery(
  question: string,
  llm: LLMProvider,
  vocab: LabelVocab
): Promise<QueryPlan> {
  const { value } = await llm.generateStructured({
    system: PLANNER_SYSTEM_PROMPT,
    user: buildPlannerUserPrompt(question, vocab),
    schema: queryPlanSchema,
    schemaName: 'query_plan',
    context: `query-plan: ${question.slice(0, 60)}`
  });

  // guarantee at least one search string even if the model returned an empty array
  if (value.search_queries.length === 0)
    value.search_queries = [question.trim()].filter(Boolean);
  return value;
}
