import { z } from "zod";
import { DISCUSSION_TYPES } from "../enrichment/schemas";

/** What the user is trying to get out of the graph - drives retrieval and synthesis. */
export const QUERY_INTENTS = [
  "opinion", // "jaký mají lidé názor na X"
  "troubleshooting", // "něco mi nefunguje, poraď"
  "factual", // "kdy vyšlo X", "kdo je Y"
  "summary", // "co se dělo kolem X"
  "person-activity", // "co řešil uživatel Z"
  "timeline", // "jak se vyvíjel názor na X"
  "other",
] as const;

export type QueryIntent = (typeof QUERY_INTENTS)[number];

/**
 * Fáze 1 - porozumění dotazu. One LLMProvider.generateStructured call turns the raw question
 * into this plan. Kept deliberately flat (no nested objects, only enums / string arrays /
 * nullable strings) so it round-trips cleanly through every provider's JSON-schema mode.
 */
export const queryPlanSchema = z.object({
  search_queries: z
    .array(z.string())
    .min(1)
    .max(6)
    .describe(
      "1–6 přeformulování otázky optimalizovaných pro sémantické vyhledávání proti shrnutím diskuzí " +
        "(diskuze byly embeddovány z 'title. summary. topics'). Vícečetnou otázku rozlož na dílčí. " +
        "Piš je jako oznamovací věty s konkrétními klíčovými slovy, ne jako otázku.",
    ),
  topics: z
    .array(z.string())
    .describe("Kandidátní kanonické názvy témat k dohledání mezi Topic uzly. Preferuj názvy ze slovníku grafu, pokud sedí."),
  entities: z
    .array(z.string())
    .describe("Kandidátní pojmenované entity (produkt, technologie, značka, osoba, místo). Prázdné, pokud žádné."),
  intent: z.enum(QUERY_INTENTS),
  filter_discussion_types: z
    .array(z.enum(DISCUSSION_TYPES))
    .describe("Omez typ diskuze, jen pokud to otázka jasně vyžaduje (např. troubleshooting -> ['help-request']). Jinak prázdné."),
  filter_since: z
    .string()
    .nullable()
    .describe("ISO 8601 datum (YYYY-MM-DD), pokud je otázka časově omezená ('minulý týden', 'od ledna'). Jinak null."),
  filter_usernames: z
    .array(z.string())
    .describe("Jména uživatelů, pokud je otázka o konkrétních lidech. Jinak prázdné."),
  answer_language: z
    .string()
    .describe("ISO 639-1 kód jazyka, ve kterém je otázka a ve kterém se má odpovědět (např. 'cs', 'en')."),
});

export type QueryPlan = z.infer<typeof queryPlanSchema>;

/** Fáze 4 - syntéza. The synthesizer's structured answer. */
export const answerSchema = z.object({
  answer: z
    .string()
    .describe(
      "Odpověď v jazyce otázky. Fakta VÝHRADNĚ z dodaných diskuzí. Za tvrzením uveď odkaz [D#] (nebo víc). " +
        "U názorových otázek shrň převažující postoj i menšinové názory s hrubým poměrem. " +
        "Když podklady nestačí, řekni to otevřeně.",
    ),
  used_citations: z
    .array(z.string())
    .describe("Seznam identifikátorů diskuzí použitých v odpovědi, přesně jak jsou v kontextu, např. ['D1','D3']."),
  confidence: z
    .enum(["high", "medium", "low"])
    .describe("high = podklady přímo a jednoznačně odpovídají; medium = částečně; low = jen okrajově / nejistě."),
  caveats: z
    .string()
    .nullable()
    .describe("Krátce co podklady nepokrývají nebo kde je odpověď nejistá. null, pokud není co dodat."),
});

export type AnswerDraft = z.infer<typeof answerSchema>;
