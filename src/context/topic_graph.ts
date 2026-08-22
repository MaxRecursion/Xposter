/**
 * Topic neighborhood for the Xposter brain.
 *
 * Static links encode how a Punekar talks across beats (traffic ↔ metro,
 * AI ↔ jobs). Corpus links are co-occurrence edges from recent RAG items so
 * the graph keeps learning as feeds land.
 */
import { getDb } from '../storage/db.js';
import { logger } from '../utils/logger.js';
import { parseTopics, type Topic } from './topics.js';

export const ALL_TOPICS: Topic[] = [
  'monsoon', 'traffic', 'pmc', 'metro', 'roads', 'ai', 'jobs', 'startup',
  'economy', 'tech', 'maharashtra', 'politics', 'civic', 'crime', 'weather',
  'festival', 'pune-area', 'sports',
];

const TOPIC_SET = new Set<string>(ALL_TOPICS);

/** Undirected neighborhood: a tweet tagged X should also consider Y. */
export const STATIC_TOPIC_LINKS: Record<Topic, Topic[]> = {
  traffic: ['roads', 'metro', 'pune-area', 'civic', 'monsoon'],
  roads: ['traffic', 'metro', 'pune-area', 'civic', 'pmc'],
  metro: ['traffic', 'roads', 'pune-area', 'civic'],
  monsoon: ['weather', 'civic', 'traffic', 'pune-area', 'roads'],
  weather: ['monsoon', 'pune-area', 'civic'],
  civic: ['pmc', 'roads', 'traffic', 'pune-area', 'monsoon', 'politics'],
  pmc: ['civic', 'pune-area', 'roads', 'politics'],
  'pune-area': ['traffic', 'metro', 'civic', 'jobs', 'startup', 'weather', 'festival'],
  ai: ['jobs', 'tech', 'startup', 'economy'],
  jobs: ['ai', 'startup', 'economy', 'tech', 'pune-area'],
  startup: ['jobs', 'ai', 'tech', 'economy', 'pune-area'],
  tech: ['ai', 'jobs', 'startup', 'economy'],
  economy: ['jobs', 'startup', 'ai', 'maharashtra', 'tech'],
  maharashtra: ['pune-area', 'economy', 'politics', 'civic'],
  politics: ['civic', 'maharashtra', 'pmc'],
  festival: ['pune-area', 'civic'],
  crime: ['civic', 'pune-area'],
  sports: ['pune-area', 'festival'],
};

export interface TopicLink {
  from: Topic;
  to: Topic;
  weight: number;
  origin: 'static' | 'corpus';
}

export function isTopic(value: string): value is Topic {
  return TOPIC_SET.has(value);
}

export function asTopics(values: Iterable<string>): Topic[] {
  const out: Topic[] = [];
  const seen = new Set<Topic>();
  for (const value of values) {
    if (!isTopic(value) || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Expand seed topics by `hops` along static links, then add strong corpus
 * neighbors (co-occurrence in recent RAG items).
 */
export function expandLinkedTopics(
  seed: Iterable<string>,
  opts: { hops?: number; corpusNeighbors?: Map<string, string[]> } = {},
): Topic[] {
  const hops = Math.max(0, opts.hops ?? 1);
  const start = asTopics(seed);
  const seen = new Set<Topic>(start);
  let frontier = [...start];

  for (let hop = 0; hop < hops; hop++) {
    const next: Topic[] = [];
    for (const topic of frontier) {
      for (const neighbor of STATIC_TOPIC_LINKS[topic] ?? []) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
  }

  const corpus = opts.corpusNeighbors;
  if (corpus) {
    for (const topic of start) {
      for (const neighbor of corpus.get(topic) ?? []) {
        if (!isTopic(neighbor) || seen.has(neighbor)) continue;
        seen.add(neighbor);
      }
    }
  }

  return [...seen];
}

export function formatTopicWeb(seed: Topic[], linked: Topic[]): string {
  if (seed.length === 0) return '';
  const extra = linked.filter((t) => !seed.includes(t));
  if (extra.length === 0) return seed.join(', ');
  return `${seed.join(', ')} → ${extra.join(', ')}`;
}

export function loadCorpusTopicNeighbors(
  lookbackDays = 7,
  minCount = 2,
): Map<string, string[]> {
  const neighbors = new Map<string, string[]>();
  try {
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - lookbackDays * 86400;
    const rows = db.prepare(`
      SELECT topics FROM context_items
      WHERE COALESCE(published_at, fetched_at) >= ?
    `).all(cutoff) as Array<{ topics: string }>;

    const counts = new Map<string, number>();
    for (const row of rows) {
      const topics = asTopics(parseTopics(row.topics));
      if (topics.length < 2) continue;
      for (let i = 0; i < topics.length; i++) {
        for (let j = i + 1; j < topics.length; j++) {
          const [a, b] = topics[i] < topics[j]
            ? [topics[i], topics[j]]
            : [topics[j], topics[i]];
          const key = `${a}\u0000${b}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }

    const lists = new Map<string, Array<{ to: string; n: number }>>();
    for (const [key, n] of counts) {
      if (n < minCount) continue;
      const [from, to] = key.split('\u0000');
      pushNeighbor(lists, from, to, n);
      pushNeighbor(lists, to, from, n);
    }
    for (const [from, list] of lists) {
      neighbors.set(
        from,
        list.sort((a, b) => b.n - a.n).slice(0, 6).map((x) => x.to),
      );
    }
  } catch (err) {
    logger.debug('Corpus topic graph unavailable', { err: String(err) });
  }
  return neighbors;
}

export function listStaticTopicLinks(): TopicLink[] {
  const links: TopicLink[] = [];
  const seen = new Set<string>();
  for (const [from, tos] of Object.entries(STATIC_TOPIC_LINKS) as Array<[Topic, Topic[]]>) {
    for (const to of tos) {
      const [a, b] = from < to ? [from, to] : [to, from];
      const key = `${a}\u0000${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ from: a, to: b, weight: 1, origin: 'static' });
    }
  }
  return links;
}

function pushNeighbor(
  lists: Map<string, Array<{ to: string; n: number }>>,
  from: string,
  to: string,
  n: number,
): void {
  const list = lists.get(from) ?? [];
  list.push({ to, n });
  lists.set(from, list);
}
