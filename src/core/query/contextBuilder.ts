import type { GraphStore } from '../ports/GraphStore';
import type { Config } from '../../config/config';
import type {
  Candidate,
  DiscussionCore,
  EvidenceItem,
  RawMessage
} from './types';

export interface EnrichmentBits {
  keyPoints: string[];
  summary: string | null;
  topics: string[];
  entities: { name: string; type: string }[];
}

/**
 * The SQLite reads context assembly needs, as a port so `core/query` never imports the DB client
 * directly (keeps the pipeline unit-testable without a database). The real implementation lives in
 * src/db/sqlite/repositories/queryRepository.ts and is wired in by the HTTP route.
 */
export interface SqliteContextSource {
  getEnrichmentBits(ids: string[]): Map<string, EnrichmentBits>;
  getDiscussionMessagesForQuery(
    discussionId: string,
    limit: number
  ): RawMessage[];
}

const MSG_MAX_CHARS = 400;

/** Rough token estimate for mixed Czech/English text - deliberately conservative. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.4);
}

function resolvedLabel(v: boolean | null): string {
  if (v === true) return 'ano';
  if (v === false) return 'ne';
  return '–';
}

function oneLine(s: string): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  return collapsed.length > MSG_MAX_CHARS
    ? `${collapsed.slice(0, MSG_MAX_CHARS)}…`
    : collapsed;
}

function renderBlock(item: EvidenceItem, includeRaw: boolean): string {
  const c = item.candidate;
  const core = item.core;
  const title = core?.title ?? c.title ?? '(bez názvu)';
  const channel = core?.channelName ?? null;
  const summary = core?.summary ?? item.summary ?? c.summary ?? null;
  const topics = core?.topics ?? [];
  const entities = core?.entities ?? [];
  const participants = (core?.participants ?? []).slice(0, 8);

  const lines: string[] = [];
  lines.push(`[${item.ref}] "${title}"`);
  lines.push(
    `kanál: ${channel ? `#${channel}` : '?'} · začátek: ${core?.startedAt ?? c.startedAt ?? '?'} · typ: ${
      core?.discussionType ?? c.discussionType ?? '?'
    } · sentiment: ${core?.sentiment ?? c.sentiment ?? '?'} · vyřešeno: ${resolvedLabel(core?.resolved ?? c.resolved)}`
  );
  if (participants.length > 0) {
    lines.push(
      `účastníci: ${participants.map((p) => `${p.name}${p.messageCount ? ` (${p.messageCount})` : ''}`).join(', ')}`
    );
  }
  if (summary) lines.push(`shrnutí: ${summary}`);
  if (item.keyPoints.length > 0) {
    lines.push('klíčové body:');
    for (const kp of item.keyPoints) lines.push(`- ${kp}`);
  }
  if (topics.length > 0) lines.push(`témata: ${topics.join(', ')}`);
  if (entities.length > 0) lines.push(`entity: ${entities.join(', ')}`);
  if (includeRaw && item.rawMessages.length > 0) {
    lines.push('ukázky zpráv:');
    for (const m of item.rawMessages)
      lines.push(`  [${m.createdAt}] ${m.authorLabel}: ${oneLine(m.content)}`);
  }
  return lines.join('\n');
}

export interface BuiltContext {
  contextText: string;
  /** The items actually included in the context (budget may drop the tail). */
  items: EvidenceItem[];
}

/**
 * Fáze 4a - assemble the LLM context from the evidence set: graph core (Neo4j) + key_points and
 * optional raw messages (SQLite), with stable [D#] refs and a token budget that trims from the
 * lowest-scored end (raw messages first, then whole blocks).
 */
export async function buildContext(
  evidence: Candidate[],
  deps: { graph: GraphStore; sqlite: SqliteContextSource },
  cfg: Config['query']
): Promise<BuiltContext> {
  const { sqlite } = deps;
  const ids = evidence.map((c) => c.id);
  const cores = await deps.graph.getDiscussionCores(ids);
  const coreById = new Map<string, DiscussionCore>(cores.map((c) => [c.id, c]));
  const bitsById = sqlite.getEnrichmentBits(ids);

  const items: EvidenceItem[] = evidence.map((candidate, i) => {
    const bits = bitsById.get(candidate.id);
    return {
      ref: `D${i + 1}`,
      candidate,
      core: coreById.get(candidate.id) ?? null,
      summary: bits?.summary ?? null,
      keyPoints: bits?.keyPoints ?? [],
      rawMessages: []
    };
  });

  // pull raw messages for the top few discussions
  const rawCount = Math.min(cfg.raw_message_discussions, items.length);
  for (let i = 0; i < rawCount; i++) {
    const item = items[i];
    if (item)
      item.rawMessages = sqlite.getDiscussionMessagesForQuery(
        item.candidate.id,
        cfg.raw_messages_per_discussion
      );
  }

  const blocks: string[] = [];
  const included: EvidenceItem[] = [];
  let tokens = 0;
  for (const item of items) {
    const withRaw = renderBlock(item, true);
    const withoutRaw = renderBlock(item, false);
    const full = estimateTokens(withRaw);
    const lean = estimateTokens(withoutRaw);

    if (tokens + lean > cfg.context_token_budget && included.length > 0) break;

    if (tokens + full <= cfg.context_token_budget) {
      blocks.push(withRaw);
      tokens += full;
    } else {
      blocks.push(withoutRaw);
      tokens += lean;
      item.rawMessages = [];
    }
    included.push(item);
  }

  return { contextText: blocks.join('\n\n'), items: included };
}
