import type { EnrichableMessage } from "./types";

export const ENRICHMENT_SYSTEM_PROMPT = `Jsi analytik komunitních diskuzí. Dostaneš shluk zpráv z jednoho Discord kanálu, který
předběžný clustering seskupil dohromady. Tvým úkolem je vytěžit z něj co nejvíc znalostí pro
znalostní graf komunity.

Nejdřív rozhodni, jestli shluk odpovídá JEDNÉ souvislé diskuzi, nebo jestli se do něj omylem
slilo VÍCE nesouvisejících konverzací:
- Pokud jde o jednu diskuzi (i když odbíhá k podtématům), vrať přesně JEDEN objekt v poli "segments".
  Pole "message_ids" v tom případě klidně nech prázdné - všechny zprávy shluku se k němu přiřadí samy.
- Pokud se slily zjevně samostatné konverzace, vrať VÍC objektů - jeden za každou konverzaci - a do
  "message_ids" u každého dej ID zpráv, které do ní patří. Když nějaké ID zapomeneš, doplní se
  automaticky k časově nejbližšímu segmentu, takže se nikdy nic neztratí. Neděl diskuzi zbytečně,
  rozděluj jen tam, kde jde opravdu o různá témata/vlákna probíhající vedle sebe.

Pro každý segment vyplň title, summary, topics, entities, key_points, sentiment, sentiment_score,
language, discussion_type a resolved. Piš ve stejném jazyce, jakým je psaná diskuze (většinou česky).
Buď konkrétní - summary a key_points mají zachytit skutečný obsah, ne jen "uživatelé něco řešili".`;

/** Renders the discussion's messages into the user turn. */
export function buildEnrichmentUserPrompt(messages: EnrichableMessage[], maxMessages: number): string {
  const capped = messages.length > maxMessages ? messages.slice(0, maxMessages) : messages;
  const lines = capped.map(
    (m) => `[id=${m.id}] ${m.authorLabel} @ ${m.createdAt}\n${m.content.replace(/\r?\n/g, " ").trim()}`,
  );
  const header =
    capped.length < messages.length
      ? `Diskuze má ${messages.length} zpráv, níže je prvních ${capped.length}.\n\n`
      : "";
  return `${header}${lines.join("\n\n")}`;
}
