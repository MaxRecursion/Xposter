import type { ContextStore } from '../store/store.js';
import type { RetrievedContextItem } from '../types.js';
import { loadCorpusTopicNeighbors, expandLinkedTopics } from '../topic_graph.js';
import { detectTopics, parseTopics, type Topic } from '../topics.js';

export interface RetrievalQuery {
  text: string;
  language?: string | null;
  k?: number;
  maxAgeSeconds?: number;
  linkedTopics?: Topic[];
}

const RECENCY_HALF_LIFE_HOURS = 12;
const W_SIM = 0.48;
const W_RECENCY = 0.22;
const W_CRED = 0.08;
const W_TOPIC = 0.22;

/**
 * Hard cutoff to drop irrelevant items. voyage-3-lite cosine distances run
 * higher than I initially tuned for: a perfectly-related item lands around
 * 0.55–0.65 against a tweet-style query. Anything beyond ~0.95 is genuinely
 * unrelated.
 */
const MAX_DISTANCE = 0.95;

export interface RankedHit {
  item: RetrievedContextItem;
  score: number;
  topicOverlap: number;
}

/**
 * Wraps the vector store with a recency × similarity × credibility × topic-overlap
 * re-ranker. Linked topics from the brain expand the overlap set so a traffic
 * tweet can surface metro/civic reporting.
 */
export class Retriever {
  constructor(private readonly store: ContextStore) {}

  async retrieve(q: RetrievalQuery): Promise<RetrievedContextItem[]> {
    const k = q.k ?? 5;
    const queryTopics = detectTopics(q.text);
    const linkedTopics = q.linkedTopics ?? expandLinkedTopics(queryTopics, {
      hops: 1,
      corpusNeighbors: loadCorpusTopicNeighbors(),
    });
    const searchText = linkedTopics.length > 0
      ? `${q.text}\nRelated topics: ${linkedTopics.join(', ')}`
      : q.text;

    const candidates = await this.store.semanticSearch(searchText, {
      k: k * 3,
      maxAgeSeconds: q.maxAgeSeconds ?? 36 * 3600,
      language: q.language ?? null,
    });
    if (candidates.length === 0) return [];

    const ranked = rankRetrievedItems(candidates, {
      queryTopics,
      linkedTopics,
      nowSec: Math.floor(Date.now() / 1000),
    });
    const topical = ranked.filter((r) => r.topicOverlap > 0 || queryTopics.length === 0);
    const pool = topical.length > 0 ? topical : ranked.filter((r) => r.item.distance <= MAX_DISTANCE);
    const chosen = (pool.length > 0 ? pool : ranked).slice(0, k);
    return chosen.map((r) => r.item);
  }
}

export function rankRetrievedItems(
  candidates: RetrievedContextItem[],
  opts: {
    queryTopics: Topic[];
    linkedTopics: Topic[];
    nowSec: number;
  },
): RankedHit[] {
  const querySet = new Set(opts.queryTopics);
  const linkedSet = new Set(opts.linkedTopics);
  const now = opts.nowSec;

  return candidates
    .filter((c) => c.distance <= MAX_DISTANCE)
    .map((c) => {
      const ts = c.publishedAt ?? c.fetchedAt;
      const ageHours = Math.max(0, (now - ts) / 3600);
      const recency = Math.exp(-ageHours / RECENCY_HALF_LIFE_HOURS);
      const similarity = clamp01(1 - c.distance);
      const credibility = clamp01(c.credibility);
      const itemTopics = parseTopics(c.topics);
      let overlap = 0;
      for (const topic of itemTopics) {
        if (querySet.has(topic)) overlap += 1;
        else if (linkedSet.has(topic)) overlap += 0.55;
      }
      const denom = Math.max(querySet.size, 1);
      const topicOverlap = overlap / denom;
      const score =
        W_SIM * similarity +
        W_RECENCY * recency +
        W_CRED * credibility +
        W_TOPIC * clamp01(topicOverlap);
      return { item: c, score, topicOverlap };
    })
    .sort((a, b) => b.score - a.score);
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
