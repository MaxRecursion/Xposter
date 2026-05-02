import { getDb } from '../storage/db.js';
import { getSetting } from '../storage/queries.js';
import { getTopicPerformance } from '../storage/original_posts.js';
import { getVelocityMap } from '../context/trends.js';
import { isContextEnabled } from '../context/enrich.js';
import { logger } from '../utils/logger.js';

export type TopicCategory =
  | 'local-pune'
  | 'tech'
  | 'politics'
  | 'sports'
  | 'culture'
  | 'observation';

export interface TopicSpec {
  topic: string;
  category: TopicCategory;
}

/**
 * Per-category topic pools. The bot picks a category first, then a topic
 * within it — so the mix of subjects stays diverse even if one category has
 * many candidate topics.
 */
const CATEGORY_TOPICS: Record<TopicCategory, string[]> = {
  'local-pune': [
    'pune monsoon', 'pune traffic', 'pmc', 'pune metro', 'mumbai-pune expressway',
    'fc road', 'kothrud', 'aundh', 'baner', 'hinjewadi commute',
    'pune potholes', 'pune water supply', 'pune housing', 'pune cafe scene',
    'pune street food',
  ],
  'tech': [
    'AI hype cycle', 'large language models', 'india startup ecosystem',
    'tech layoffs', 'open source', 'developer tools', 'apple vs android',
    'crypto skepticism', 'gpu shortage', 'remote work tools',
    'product launches',
  ],
  'politics': [
    'maharashtra politics', 'indian politics', 'union budget',
    'election season', 'parliament debates', 'india foreign policy',
    'state vs centre', 'civic elections',
  ],
  'sports': [
    'IPL season', 'india test cricket', 'india odi cricket', 'F1 race weekend',
    'football transfer window', 'pro kabaddi', 'olympic preparation',
    'badminton internationals', 'tennis grand slam',
  ],
  'culture': [
    'bollywood release', 'marathi cinema', 'indian street food',
    'monsoon food cravings', 'book recommendations', 'music recommendations',
    'ganesh festival', 'diwali plans', 'restaurant openings',
    'weekend trip ideas',
  ],
  'observation': [
    'work from home reality', 'monday morning', 'weekend planning',
    'commuting woes', 'apartment hunting', 'cooking at home',
    'auto rickshaw stories', 'sleep schedule', 'gym vs running',
    'office wifi pain',
  ],
};

const DEFAULT_CATEGORY_WEIGHTS: Record<TopicCategory, number> = {
  'local-pune': 0.30,
  'tech': 0.20,
  'politics': 0.10,
  'sports': 0.15,
  'culture': 0.15,
  'observation': 0.10,
};

const RECENT_HISTORY_WINDOW = 5;
const RECENT_PENALTY = 0.30;
const VELOCITY_FLOOR = 0.6;
const VELOCITY_CEIL = 2.5;

/**
 * Read user-configurable category weights from settings, falling back to
 * defaults if the setting is missing or malformed. Weights are normalized.
 */
export function getCategoryWeights(): Record<TopicCategory, number> {
  const raw = getSetting('topic_category_weights', '');
  if (raw.trim() === '') return { ...DEFAULT_CATEGORY_WEIGHTS };

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<TopicCategory, number> = { ...DEFAULT_CATEGORY_WEIGHTS };
    for (const cat of Object.keys(out) as TopicCategory[]) {
      const v = parsed[cat];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
        out[cat] = v;
      }
    }
    const sum = Object.values(out).reduce((a, b) => a + b, 0);
    if (sum <= 0) return { ...DEFAULT_CATEGORY_WEIGHTS };
    return out;
  } catch (err) {
    logger.warn('topic_category_weights setting is invalid JSON; using defaults', { err: String(err) });
    return { ...DEFAULT_CATEGORY_WEIGHTS };
  }
}

/** Topics already used in the last N original posts (most-recent first). */
export function getRecentTopics(n = RECENT_HISTORY_WINDOW): string[] {
  try {
    const rows = getDb().prepare(`
      SELECT topic FROM original_posts
      WHERE status IN ('POSTED','GENERATING')
      ORDER BY created_at DESC
      LIMIT ?
    `).all(n) as Array<{ topic: string }>;
    return rows.map((r) => r.topic);
  } catch {
    return [];
  }
}

/** Weighted pick from a {key: weight} map. */
function weightedRandom<K>(entries: Array<[K, number]>): K {
  const total = entries.reduce((a, b) => a + b[1], 0);
  if (total <= 0) return entries[0][0];
  let r = Math.random() * total;
  for (const [k, w] of entries) {
    r -= w;
    if (r <= 0) return k;
  }
  return entries[entries.length - 1][0];
}

/**
 * Pick a topic for an original post, taking into account:
 *   - configured category weights (settings.topic_category_weights)
 *   - past engagement performance per topic
 *   - current trend velocity (when context is enabled)
 *   - recency penalty (topics used in the last N posts get downweighted)
 */
export function pickTopicAndCategory(): TopicSpec {
  const categoryWeights = getCategoryWeights();
  const category = weightedRandom(
    Object.entries(categoryWeights) as Array<[TopicCategory, number]>,
  );
  const topics = CATEGORY_TOPICS[category];

  const performance = getTopicPerformance();
  const perfMap = new Map(performance.map((p) => [p.topic, p.engagement_score]));

  let velMap: Map<string, number> = new Map();
  if (isContextEnabled()) {
    try {
      velMap = getVelocityMap();
    } catch (err) {
      logger.warn('Velocity map lookup failed; ignoring trend signal', { err: String(err) });
    }
  }

  const recent = new Set(getRecentTopics());

  const weighted = topics.map<[string, number]>((t) => {
    const baseline = 1.0;
    const perf = perfMap.get(t) ?? 0;
    const perfBoost = 1.0 + perf * 0.10;
    const velKey = matchVelocityKey(t, velMap);
    const rawVel = velKey ? velMap.get(velKey) ?? 1.0 : 1.0;
    const velocity = Math.min(VELOCITY_CEIL, Math.max(VELOCITY_FLOOR, rawVel));
    const penalty = recent.has(t) ? RECENT_PENALTY : 1.0;
    return [t, baseline * perfBoost * velocity * penalty];
  });

  const topic = weightedRandom(weighted);
  return { topic, category };
}

/**
 * Trend velocities are keyed by topic *tags* (monsoon, traffic, metro, …)
 * defined in context/topics.ts, while our category topics are short
 * phrases ("pune monsoon", "F1 race weekend"). Map a phrase → tag when
 * possible so the trend signal still influences phrase weighting.
 */
function matchVelocityKey(topic: string, velMap: Map<string, number>): string | null {
  const lc = topic.toLowerCase();
  for (const key of velMap.keys()) {
    if (lc.includes(key)) return key;
  }
  return null;
}

/** Public so generator.ts can match a tweet to a category for voice selection. */
export const PUNE_LOCAL_TOPIC_TAGS = new Set(['pune-area', 'pmc', 'metro', 'roads', 'civic', 'monsoon']);
