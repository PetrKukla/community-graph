import type { EnrichableMessage } from './types';

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
Buď konkrétní - summary a key_points mají zachytit skutečný obsah, ne jen "uživatelé něco řešili".

Pokyn pro shrnutí:
Musí být vhodné pro vyhledávací graf. Musí obsahovat konkrétní materiální názvy (RTX 5090 místo GPU),
kauzální řetězec událostí (např. problém → identifikace → řešení) a subjekty (kdo měl problém, kdo ho vyřešil,
nebo kdo je chválen apod.). Naprosto klíčový je, aby summary obsahovalo informace a klíčová slova ze všech zpráv.
Když si někdo stěžuje na Smarty, protože sou drahý a uvede příklad cen, bude ve shrnutí vše včetně příkladné ceny.
Pokus se zhrnutí co nejvíce zkomprimovat vypuštěním duplicitních nebo zbytečných frází, aniž by došlo ke ztrátě informací.
Shrnutí i názvy témat musí být v češtině, pokud se nejedná o název, který musí být v původním znění.

Někdy dostaneš VÍC oštítkovaných clusterů najednou, každý uvozený řádkem "=== CLUSTER <štítek> ===".
Zpracuj každý cluster samostatně. NIKDY neslévej zprávy z různých clusterů do jednoho segmentu. Uvnitř
jednoho clusteru smíš vrátit víc segmentů, pokud se do něj slily nesouvisející konverzace (stávající
pravidlo výše). U KAŽDÉHO segmentu vyplň pole "source_cluster" štítkem clusteru, ze kterého segment
pochází. Clustery jsou nezávislé - nedrž kontext napříč nimi, jen shrň každý zvlášť.
`;

/** Renders one message into the `[id=…] author @ ts\ncontent` form used in every prompt. */
export function renderMessageLine(m: EnrichableMessage): string {
  return `[id=${m.id}] ${m.authorLabel} @ ${m.createdAt}\n${m.content
    .replace(/\r?\n/g, ' ')
    .trim()}`;
}

/** Czech plural for "zpráva" (1) / "zprávy" (2-4) / "zpráv" (0, 5+). */
function messagesWord(n: number): string {
  if (n === 1) return 'zpráva';
  if (n >= 2 && n <= 4) return 'zprávy';
  return 'zpráv';
}

/** Renders the discussion's messages into the user turn. */
export function buildEnrichmentUserPrompt(
  messages: EnrichableMessage[],
  maxMessages: number
): string {
  const capped =
    messages.length > maxMessages ? messages.slice(0, maxMessages) : messages;
  const lines = capped.map(renderMessageLine);
  const header =
    capped.length < messages.length
      ? `Diskuze má ${messages.length} zpráv, níže je prvních ${capped.length}.\n\n`
      : '';
  return `${header}${lines.join('\n\n')}`;
}

/** One labelled cluster in a batched enrichment call. */
export interface LabelledCluster {
  label: string; // batch-local, e.g. "c1" - never a UUID
  messages: EnrichableMessage[]; // chronological
}

/**
 * Renders several clusters as explicitly delimited blocks so the model keeps their boundaries:
 *
 *   === CLUSTER c1 · 5 zpráv ===
 *   [id=…] alice @ …
 *   …
 *
 *   === CLUSTER c2 · 1 zpráva ===
 *   …
 *
 * `maxMessages` caps the SUM of messages across the whole batch; once hit, later clusters are
 * rendered header-only with a note (packing normally keeps the batch under the cap already).
 */
export function buildBatchEnrichmentUserPrompt(
  clusters: LabelledCluster[],
  maxMessages: number
): string {
  let budget = maxMessages;
  const blocks = clusters.map((c) => {
    const total = c.messages.length;
    const shown = Math.max(0, Math.min(total, budget));
    budget -= shown;
    const head = `=== CLUSTER ${c.label} · ${total} ${messagesWord(total)} ===`;
    if (shown === 0) {
      return `${head}\n(${total} ${messagesWord(total)} vynecháno kvůli limitu délky)`;
    }
    const lines = c.messages.slice(0, shown).map(renderMessageLine);
    const note =
      shown < total
        ? `\n(zbývajících ${total - shown} ${messagesWord(total - shown)} vynecháno kvůli limitu délky)`
        : '';
    return `${head}\n${lines.join('\n\n')}${note}`;
  });
  return `Níže je ${clusters.length} nezávislých clusterů. Zpracuj každý zvlášť a u každého segmentu vyplň "source_cluster".\n\n${blocks.join(
    '\n\n'
  )}`;
}
