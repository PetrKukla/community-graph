import type { LLMProvider } from "../ports/LLMProvider";
import { buildSynthesisUserPrompt, SYNTHESIS_SYSTEM_PROMPT } from "./prompt";
import { answerSchema, type AnswerDraft, type QueryPlan } from "./schemas";

/** Fáze 4b - one structured LLM call turns the assembled context into a grounded answer. */
export async function synthesizeAnswer(
  question: string,
  plan: QueryPlan,
  contextText: string,
  llm: LLMProvider,
): Promise<AnswerDraft> {
  const { value } = await llm.generateStructured({
    system: SYNTHESIS_SYSTEM_PROMPT,
    user: buildSynthesisUserPrompt(question, plan, contextText),
    schema: answerSchema,
    schemaName: "community_answer",
    context: `query-answer: ${question.slice(0, 60)}`,
  });
  return value;
}
