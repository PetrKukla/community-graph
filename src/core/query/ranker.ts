import type { Config } from '../../config/config';
import { recencyBoost } from './scoring';
import type { QueryPlan } from './schemas';
import type { Candidate, WorkingCandidate } from './types';

/**
 * Soft nudges only - none of these can drop a candidate, they just reorder. The planner's
 * `preferred_discussion_types` lands here (never in a WHERE clause) so a mislabelled discussion
 * type can't hide the right answer.
 */
function preferenceBoost(
  plan: QueryPlan,
  c: WorkingCandidate,
  cfg: Config['query']
): number {
  let b = 0;
  if (
    c.discussionType &&
    (plan.preferred_discussion_types as string[]).includes(c.discussionType)
  ) {
    b += cfg.weight_type_preference;
  }
  if (plan.intent === 'troubleshooting' && c.resolved === true) b += 0.05;
  return b;
}

function finalize(
  plan: QueryPlan,
  c: WorkingCandidate,
  cfg: Config['query'],
  now: number
): Candidate {
  const recency = recencyBoost(c.startedAt, cfg.recency_half_life_days, now);
  const pref = preferenceBoost(plan, c, cfg);
  const score =
    cfg.weight_vector * c.vecSim +
    cfg.weight_anchor * (c.anchorHit ? 1 : 0) +
    cfg.weight_expansion * c.expansionScore +
    cfg.weight_recency * recency +
    pref;
  return {
    id: c.id,
    title: c.title,
    summary: c.summary,
    channelId: c.channelId,
    discussionType: c.discussionType,
    sentiment: c.sentiment,
    resolved: c.resolved,
    startedAt: c.startedAt,
    vecSim: c.vecSim,
    anchorHit: c.anchorHit,
    expansionScore: c.expansionScore,
    via: c.via,
    recencyBoost: recency,
    preferenceBoost: pref,
    score,
    sources: [...c.sources]
  };
}

export interface RankResult {
  /** Everything above threshold, best first. */
  ranked: Candidate[];
  /** The slice that goes into context assembly + synthesis. */
  evidence: Candidate[];
}

/** Fuse the score components, drop everything below the floor, then pick the evidence set. */
export function rankCandidates(
  candidates: Map<string, WorkingCandidate>,
  plan: QueryPlan,
  cfg: Config['query'],
  now: number = Date.now()
): RankResult {
  const ranked = [...candidates.values()]
    .map((c) => finalize(plan, c, cfg, now))
    .filter((c) => c.score >= cfg.min_candidate_score)
    .sort((a, b) => b.score - a.score);

  let evidence = ranked.slice(0, cfg.evidence_set_size);

  if (
    cfg.opinion_sentiment_diversity &&
    plan.intent === 'opinion' &&
    ranked.length > evidence.length
  ) {
    evidence = enforceSentimentDiversity(evidence, ranked);
  }

  return { ranked, evidence };
}

/**
 * For opinion questions, make sure a present-but-crowded-out sentiment gets a seat: swap in the
 * best candidate of a missing sentiment for the weakest current pick. Bounded to 2 swaps and only
 * touches the tail so the top results stay put.
 */
function enforceSentimentDiversity(
  evidence: Candidate[],
  ranked: Candidate[]
): Candidate[] {
  const out = [...evidence];
  const inSet = new Set(out.map((c) => c.id));
  let swaps = 0;

  for (const want of ['negative', 'positive']) {
    if (swaps >= 2) break;
    if (out.some((c) => c.sentiment === want)) continue;
    const pick = ranked.find((c) => c.sentiment === want && !inSet.has(c.id));
    if (!pick) continue;
    // replace the weakest current member (last, since `out` stays score-sorted)
    const dropped = out.pop();
    if (dropped) inSet.delete(dropped.id);
    out.push(pick);
    inSet.add(pick.id);
    out.sort((a, b) => b.score - a.score);
    swaps++;
  }
  return out;
}
