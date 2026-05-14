import { getDb } from '../storage/db.js';
import { detectTopics, type Topic } from './topics.js';
import { logger } from '../utils/logger.js';

export type MemoryKind = 'original' | 'reply';

export interface MemoryEvent {
  kind: MemoryKind;
  text: string;
  topic: string | null;
  contextText?: string | null;
  createdAt: number;
  engagement: number;
}

interface MemoryNode {
  key: string;
  weight: number;
  activations: number;
  lastSeenAt: number;
}

interface MemoryEdge {
  from: string;
  to: string;
  weight: number;
}

interface IndexedMemoryEvent extends MemoryEvent {
  concepts: string[];
  score: number;
}

export interface NeuralSchemaMemory {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
  events: IndexedMemoryEvent[];
}

export interface MemoryRecall {
  activatedConcepts: string[];
  events: IndexedMemoryEvent[];
  promptBlock: string;
}

const STOPWORDS = new Set([
  'about', 'after', 'again', 'also', 'because', 'being', 'between', 'could',
  'every', 'from', 'have', 'into', 'just', 'like', 'more', 'most', 'only',
  'over', 'people', 'should', 'their', 'there', 'these', 'this', 'those',
  'through', 'today', 'very', 'what', 'when', 'where', 'which', 'with',
  'without', 'would', 'your',
]);

const STRATEGIC_TERMS = new Set([
  'ai', 'automation', 'jobs', 'hiring', 'layoffs', 'pune', 'maharashtra',
  'hinjewadi', 'startup', 'startups', 'founders', 'funding', 'economy',
  'gdp', 'inflation', 'rbi', 'manufacturing', 'services', 'gcc', 'saas',
  'developers', 'upskilling', 'salary', 'salaries', 'housing',
]);

/**
 * A tiny associative memory graph inspired by neural schemas:
 * concepts are nodes, co-occurrence is an edge, and engagement/recency nudges
 * activation. It is rebuilt from persisted posts/replies, so it keeps learning
 * as the account publishes and replies.
 */
export function buildNeuralSchemaMemory(events: MemoryEvent[], nowSec = unixNow()): NeuralSchemaMemory {
  const nodes = new Map<string, MemoryNode>();
  const edges = new Map<string, MemoryEdge>();
  const indexed: IndexedMemoryEvent[] = [];

  for (const event of events) {
    const concepts = extractConcepts(event);
    if (concepts.length === 0) continue;

    const recency = recencyWeight(event.createdAt, nowSec);
    const engagement = engagementWeight(event.engagement);
    const eventWeight = recency * engagement;

    for (const concept of concepts) {
      const existing = nodes.get(concept) ?? {
        key: concept,
        weight: 0,
        activations: 0,
        lastSeenAt: event.createdAt,
      };
      existing.weight += eventWeight;
      existing.activations += 1;
      existing.lastSeenAt = Math.max(existing.lastSeenAt, event.createdAt);
      nodes.set(concept, existing);
    }

    for (let i = 0; i < concepts.length; i++) {
      for (let j = i + 1; j < concepts.length; j++) {
        const [from, to] = concepts[i] < concepts[j]
          ? [concepts[i], concepts[j]]
          : [concepts[j], concepts[i]];
        const key = `${from}\u0000${to}`;
        const existing = edges.get(key) ?? { from, to, weight: 0 };
        existing.weight += eventWeight;
        edges.set(key, existing);
      }
    }

    indexed.push({ ...event, concepts, score: eventWeight });
  }

  return {
    nodes: [...nodes.values()].sort((a, b) => b.weight - a.weight),
    edges: [...edges.values()].sort((a, b) => b.weight - a.weight),
    events: indexed,
  };
}

export function recallFromMemory(
  memory: NeuralSchemaMemory,
  query: string,
  opts: { maxItems?: number; maxChars?: number } = {},
): MemoryRecall | null {
  const maxItems = opts.maxItems ?? 4;
  const maxChars = opts.maxChars ?? 1100;
  const queryConcepts = extractConcepts({
    kind: 'original',
    text: query,
    topic: query,
    createdAt: unixNow(),
    engagement: 0,
  });
  if (queryConcepts.length === 0 || memory.events.length === 0) return null;

  const nodeWeights = new Map(memory.nodes.map((n) => [n.key, n.weight]));
  const edgeWeights = new Map(memory.edges.map((e) => [`${e.from}\u0000${e.to}`, e.weight]));
  const qset = new Set(queryConcepts);

  const scored = memory.events
    .map((event) => {
      const overlap = event.concepts.filter((c) => qset.has(c));
      const edgeBoost = event.concepts.reduce((sum, concept) => {
        for (const q of queryConcepts) {
          if (q === concept) continue;
          const [from, to] = q < concept ? [q, concept] : [concept, q];
          sum += edgeWeights.get(`${from}\u0000${to}`) ?? 0;
        }
        return sum;
      }, 0);
      const nodeBoost = event.concepts.reduce((sum, concept) => sum + (nodeWeights.get(concept) ?? 0), 0);
      const score = overlap.length * 2.2 + edgeBoost * 0.18 + nodeBoost * 0.04 + event.score;
      return { event, score, overlap };
    })
    .filter((r) => r.overlap.length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxItems);

  if (scored.length === 0) return null;

  const activated = [...new Set([
    ...queryConcepts,
    ...scored.flatMap((r) => r.overlap),
  ])].slice(0, 10);

  const lines = [
    '[LEARNED MEMORY - from past Xposter originals/replies; use as a preference signal, not as a source of facts.]',
    `Activated concepts: ${activated.join(', ')}`,
    'Relevant past patterns:',
  ];
  let used = lines.join('\n').length;

  for (const { event } of scored) {
    const label = event.kind === 'original' ? 'original' : 'reply';
    const topic = event.topic ? ` topic=${event.topic}` : '';
    const text = truncate(event.text.replace(/\s+/g, ' '), 190);
    const line = `- ${label}${topic}: ${text}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }

  lines.push('Instruction: keep continuity with useful angles, but do not repeat exact wording or stale facts.');
  lines.push('[/LEARNED MEMORY]');

  return {
    activatedConcepts: activated,
    events: scored.map((r) => r.event),
    promptBlock: lines.join('\n'),
  };
}

export function recallNeuralMemory(
  query: string,
  opts: { maxItems?: number; maxChars?: number; limit?: number } = {},
): string {
  try {
    const events = loadMemoryEvents(opts.limit ?? 220);
    const memory = buildNeuralSchemaMemory(events);
    return recallFromMemory(memory, query, opts)?.promptBlock ?? '';
  } catch (err) {
    logger.warn('Neural memory recall failed; continuing without memory', { err: String(err) });
    return '';
  }
}

export function loadMemoryEvents(limit: number): MemoryEvent[] {
  const db = getDb();
  const originals = db.prepare(`
    SELECT
      'original' AS kind,
      op.content AS text,
      op.topic AS topic,
      op.research_context AS contextText,
      COALESCE(op.posted_at, op.created_at) AS createdAt,
      COALESCE(MAX(pi.likes * 2 + pi.replies * 5 + pi.retweets * 3 + pi.impressions * 0.01), 0) AS engagement
    FROM original_posts op
    LEFT JOIN post_impressions pi ON pi.original_post_id = op.id
    WHERE op.status = 'POSTED'
    GROUP BY op.id
    ORDER BY COALESCE(op.posted_at, op.created_at) DESC
    LIMIT ?
  `).all(limit) as MemoryEvent[];

  const replies = db.prepare(`
    SELECT
      'reply' AS kind,
      i.our_reply_text AS text,
      p.text AS topic,
      p.text AS contextText,
      i.posted_at AS createdAt,
      COALESCE(i.success_score, 0) + COALESCE(i.likes_received, 0) * 2 +
        COALESCE(i.replies_received, 0) * 5 + COALESCE(i.retweets_received, 0) * 3 AS engagement
    FROM interactions i
    JOIN posts p ON p.id = i.post_id
    ORDER BY i.posted_at DESC
    LIMIT ?
  `).all(limit) as MemoryEvent[];

  return [...originals, ...replies].slice(0, limit * 2);
}

function extractConcepts(event: MemoryEvent): string[] {
  const text = [event.topic, event.text, event.contextText].filter(Boolean).join(' ');
  const topics = detectTopics(text).map((t: Topic) => t);
  const words = normalizedWords(text);
  const concepts = new Set<string>(topics);

  for (const word of words) {
    if (STRATEGIC_TERMS.has(word)) concepts.add(word);
  }

  for (let i = 0; i < words.length - 1; i++) {
    const phrase = `${words[i]} ${words[i + 1]}`;
    if (isStrategicPhrase(phrase)) concepts.add(phrase);
  }

  return [...concepts].slice(0, 16);
}

function normalizedWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^-+|-+$/g, ''))
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function isStrategicPhrase(phrase: string): boolean {
  return (
    /^(ai|tech|startup|pune|maharashtra|hinjewadi|india|rbi|it|gcc|saas) /.test(phrase) ||
    / (jobs|hiring|automation|economy|funding|startups|founders|developers|salaries|housing)$/.test(phrase)
  );
}

function recencyWeight(createdAt: number, nowSec: number): number {
  const ageDays = Math.max(0, (nowSec - createdAt) / 86400);
  return 0.35 + Math.exp(-ageDays / 45);
}

function engagementWeight(engagement: number): number {
  return 1 + Math.log1p(Math.max(0, engagement)) / 4;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}...`;
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}
