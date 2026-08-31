import type { EmbeddingProvider } from '../ports/EmbeddingProvider';
import type { ClusterableMessage } from './types';

interface ActiveSubCluster {
  index: number;
  centroid: Float32Array;
  memberCount: number;
  lastMessageAt: number;
  recentAuthors: Set<string>;
}

export interface SubClusterAssignment {
  messageId: string;
  subClusterIndex: number;
}

const AUTHOR_CONTINUITY_BONUS = 0.03;
const MENTION_BONUS = 0.05;

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  // embeddings are already L2-normalized by the embedding provider, so dot product == cosine similarity
  return dot;
}

function updateCentroid(
  centroid: Float32Array,
  memberCount: number,
  embedding: Float32Array
): Float32Array {
  const next = new Float32Array(centroid.length);
  for (let i = 0; i < centroid.length; i++) {
    next[i] = (centroid[i]! * memberCount + embedding[i]!) / (memberCount + 1);
  }
  return next;
}

/**
 * Streaming agglomerative clustering over the long (non-short-message-shortcut) messages
 * of a single time block. Bounded by the block size - never compares across blocks.
 */
export async function clusterLongMessages(
  messages: ClusterableMessage[],
  embeddingProvider: EmbeddingProvider,
  similarityThreshold: number,
  activeSubclusterIdleMinutes: number
): Promise<{
  assignments: SubClusterAssignment[];
  subClusterCount: number;
  centroids: Float32Array[];
}> {
  if (messages.length === 0)
    return { assignments: [], subClusterCount: 0, centroids: [] };

  const embeddings = await embeddingProvider.embed(
    messages.map((m) => m.content)
  );
  const idleMs = activeSubclusterIdleMinutes * 60_000;

  const active: ActiveSubCluster[] = [];
  const allClusters: ActiveSubCluster[] = [];
  const assignments: SubClusterAssignment[] = [];
  let nextIndex = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const embedding = embeddings[i]!;
    const msgTs = new Date(msg.createdAt).getTime();

    // retire sub-clusters idle for longer than the configured window
    for (let j = active.length - 1; j >= 0; j--) {
      if (msgTs - active[j]!.lastMessageAt > idleMs) active.splice(j, 1);
    }

    let best: { cluster: ActiveSubCluster; score: number } | null = null;
    for (const cluster of active) {
      let score = cosineSimilarity(embedding, cluster.centroid);
      if (cluster.recentAuthors.has(msg.authorId))
        score += AUTHOR_CONTINUITY_BONUS;
      if (msg.mentions?.some((userId) => cluster.recentAuthors.has(userId)))
        score += MENTION_BONUS;
      if (!best || score > best.score) best = { cluster, score };
    }

    if (best && best.score >= similarityThreshold) {
      const cluster = best.cluster;
      cluster.centroid = updateCentroid(
        cluster.centroid,
        cluster.memberCount,
        embedding
      );
      cluster.memberCount += 1;
      cluster.lastMessageAt = msgTs;
      cluster.recentAuthors.add(msg.authorId);
      assignments.push({ messageId: msg.id, subClusterIndex: cluster.index });
    } else {
      const cluster: ActiveSubCluster = {
        index: nextIndex++,
        centroid: embedding,
        memberCount: 1,
        lastMessageAt: msgTs,
        recentAuthors: new Set([msg.authorId])
      };
      active.push(cluster);
      allClusters.push(cluster);
      assignments.push({ messageId: msg.id, subClusterIndex: cluster.index });
    }
  }

  const centroids = allClusters
    .sort((a, b) => a.index - b.index)
    .map((c) => c.centroid);
  return { assignments, subClusterCount: nextIndex, centroids };
}
