import type { GraphStore } from '../ports/GraphStore';
import type { Config } from '../../config/config';
import { cosine, viaWeight } from './scoring';
import type { WorkingCandidate } from './types';

/**
 * Fáze 3 - one hop out of the best seed discussions along meaningful edges (CONTINUATION_OF,
 * shared Topic/Entity, COOCCURS_WITH). New discussions are added as candidates; already-known
 * ones just gain an expansion contribution. Every expansion row is re-scored by cosine to the
 * question vector so a topically-adjacent but off-question discussion does not float up.
 */
export async function expand(
  candidates: Map<string, WorkingCandidate>,
  questionVector: Float32Array,
  deps: { graph: GraphStore },
  cfg: Config['query']
): Promise<void> {
  const seedIds = [...candidates.values()]
    .map((c) => ({
      id: c.id,
      prelim:
        cfg.weight_vector * c.vecSim + cfg.weight_anchor * (c.anchorHit ? 1 : 0)
    }))
    .sort((a, b) => b.prelim - a.prelim)
    .slice(0, cfg.expansion_seed_count)
    .map((s) => s.id);

  if (seedIds.length === 0) return;

  const rows = await deps.graph.expandDiscussions(
    seedIds,
    cfg.expansion_seed_count * cfg.expansion_fanout
  );

  for (const row of rows) {
    const w = viaWeight(row.via);
    const sim =
      row.embedding && questionVector.length > 0
        ? cosine(questionVector, row.embedding)
        : 0;

    let c = candidates.get(row.id);
    if (!c) {
      c = {
        id: row.id,
        title: row.title,
        summary: row.summary,
        channelId: row.channelId,
        discussionType: row.discussionType,
        sentiment: row.sentiment,
        resolved: row.resolved,
        startedAt: row.startedAt,
        vecSim: sim,
        anchorHit: false,
        expansionScore: 0,
        via: null,
        sources: new Set()
      };
      candidates.set(row.id, c);
    } else {
      c.vecSim = Math.max(c.vecSim, sim);
    }

    c.sources.add('expansion');
    if (w > c.expansionScore) {
      c.expansionScore = w;
      c.via = row.via;
    }
  }
}
