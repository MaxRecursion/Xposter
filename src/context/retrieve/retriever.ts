import type { ContextStore } from '../store/store.js';
import type { RetrievedContextItem } from '../types.js';

export interface RetrievalQuery {
  text: string;
  language?: string | null;
  k?: number;
  maxAgeSeconds?: number;
}

const RECENCY_HALF_LIFE_HOURS = 12;
const W_SIM = 0.55;
const W_RECENCY = 0.30;
const W_CRED = 0.15;

/**
 * Wraps the vector store with a recency × similarity × credibility re-ranker.
 * The vec0 KNN already does similarity well; we over-fetch and re-rank to
 * prefer recent and authoritative items.
 */
export class Retriever {
  constructor(private readonly store: ContextStore) {}

  async retrieve(q: RetrievalQuery): Promise<RetrievedContextItem[]> {
    const k = q.k ?? 5;
    const candidates = await this.store.semanticSearch(q.text, {
      k: k * 3,
      maxAgeSeconds: q.maxAgeSeconds ?? 36 * 3600,
      language: q.language ?? null,
    });
    if (candidates.length === 0) return [];

    const now = Math.floor(Date.now() / 1000);
    const ranked = candidates.map((c) => {
      const ts = c.publishedAt ?? c.fetchedAt;
      const ageHours = Math.max(0, (now - ts) / 3600);
      const recency = Math.exp(-ageHours / RECENCY_HALF_LIFE_HOURS);
      const similarity = clamp01(1 - c.distance);
      const credibility = clamp01(c.credibility);
      const score = W_SIM * similarity + W_RECENCY * recency + W_CRED * credibility;
      return { item: c, score };
    });

    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, k).map((r) => r.item);
  }
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
