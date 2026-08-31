import type { ExpansionVia } from './types';

/** Cosine similarity of two vectors. Inputs are normally L2-normalised already; we normalise anyway. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 1.0 for a discussion happening now, decaying to 0.5 after one half-life. Unknown date -> 1.0 (no penalty). */
export function recencyBoost(
  startedAt: string | null,
  halfLifeDays: number,
  now: number = Date.now()
): number {
  if (!startedAt) return 1;
  const t = Date.parse(startedAt);
  if (Number.isNaN(t)) return 1;
  const ageDays = Math.max(0, (now - t) / 86_400_000);
  return 0.5 ** (ageDays / Math.max(1, halfLifeDays));
}

/** How much weight an expansion edge carries relative to a direct semantic hit. */
export function viaWeight(via: ExpansionVia): number {
  switch (via) {
    case 'continuation':
      return 1.0;
    case 'shared_entity':
      return 0.8;
    case 'shared_topic':
      return 0.6;
    case 'cooccurring_topic':
      return 0.4;
  }
}
