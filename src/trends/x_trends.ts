/**
 * X trending topics, fetched unauthenticated via the guest-token API.
 *
 * `GET /1.1/trends/place.json?id=<WOEID>` still serves ~50 trends per location
 * to a guest token, which means trend discovery needs no cookies, no API key
 * and no browser — and it can't get the logged-in session rate-limited.
 *
 * Deliberately NOT a ContextSource: those flow into the embedding store, and
 * paying for a Voyage embedding of a two-word hashtag would be silly. What we
 * want instead is a rollup with cross-poll rank velocity, which is what the
 * `trends` table gives us.
 */
import axios, { AxiosError } from 'axios';
import { getDb } from '../storage/db.js';
import { recordSourceRun } from '../context/ingest/health.js';
import { getIntSetting } from '../storage/settings.js';
import { logger } from '../utils/logger.js';
import { classifyTrendSafety, detectScript, type TrendSafetyClass } from './trend_filter.js';

/** The public web-app bearer used by x.com itself for guest requests. */
const GUEST_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const ACTIVATE_URL = 'https://api.twitter.com/1.1/guest/activate.json';
const TRENDS_URL = 'https://api.twitter.com/1.1/trends/place.json';
const TIMEOUT_MS = 15_000;
const GUEST_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const SNAPSHOT_RETENTION_DAYS = 7;

export const WOEID_WORLDWIDE = 1;
export const WOEID_INDIA = 23424848;

export const WOEIDS: Record<'TREND_GLOBAL' | 'TREND_INDIA', number> = {
  TREND_GLOBAL: WOEID_WORLDWIDE,
  TREND_INDIA: WOEID_INDIA,
};

function sourceLabel(woeid: number): string {
  return woeid === WOEID_INDIA ? 'trends:india' : 'trends:global';
}

// ── Guest token ───────────────────────────────────────────────────────────────

let _guestToken: string | null = null;
let _guestTokenAt = 0;

export function invalidateGuestToken(): void {
  _guestToken = null;
  _guestTokenAt = 0;
}

async function getGuestToken(): Promise<string> {
  if (_guestToken && Date.now() - _guestTokenAt < GUEST_TOKEN_TTL_MS) return _guestToken;

  const response = await axios.post(ACTIVATE_URL, null, {
    headers: { Authorization: `Bearer ${GUEST_BEARER}` },
    timeout: TIMEOUT_MS,
  });

  const token = response.data?.guest_token;
  if (!token) throw new Error('guest/activate returned no guest_token');

  _guestToken = String(token);
  _guestTokenAt = Date.now();
  logger.info('X guest token acquired');
  return _guestToken;
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

export interface RawTrend {
  name: string;
  query: string;
  url: string | null;
  tweetVolume: number | null;
  rank: number;
}

/**
 * Fetches the trend list for one WOEID.
 *
 * Retries exactly once on 401/403 with a fresh guest token — tokens expire, but
 * an unbounded retry loop against an unauthenticated endpoint is how you get
 * IP-banned.
 */
export async function fetchTrends(woeid: number): Promise<RawTrend[]> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const token = await getGuestToken();
      const response = await axios.get(TRENDS_URL, {
        params: { id: woeid },
        headers: { Authorization: `Bearer ${GUEST_BEARER}`, 'x-guest-token': token },
        timeout: TIMEOUT_MS,
      });

      const trends = response.data?.[0]?.trends;
      if (!Array.isArray(trends)) throw new Error('trends/place returned an unexpected shape');

      return trends.flatMap((t: Record<string, unknown>, index: number) => {
        const name = typeof t.name === 'string' ? t.name.trim() : '';
        if (!name) return [];
        // Promoted trends are ads, not organic conversation.
        if (t.promoted_content) return [];
        return [{
          name,
          query: typeof t.query === 'string' && t.query ? t.query : encodeURIComponent(name),
          url: typeof t.url === 'string' ? t.url : null,
          tweetVolume: typeof t.tweet_volume === 'number' ? t.tweet_volume : null,
          rank: index + 1,
        }];
      });
    } catch (err) {
      const status = (err as AxiosError)?.response?.status;
      if (attempt === 1 && (status === 401 || status === 403)) {
        logger.warn('X trends auth rejected — refreshing guest token', { status, woeid });
        invalidateGuestToken();
        continue;
      }
      throw err;
    }
  }
  return [];
}

// ── Refresh ───────────────────────────────────────────────────────────────────

export interface TrendRow {
  key: string;
  woeid: number;
  name: string;
  query: string;
  first_seen_at: number;
  last_seen_at: number;
  best_rank: number;
  last_rank: number;
  prev_rank: number | null;
  poll_count: number;
  peak_volume: number | null;
  script: string;
  safety_class: TrendSafetyClass;
  safety_reason: string | null;
  classified_at: number | null;
  replies_sent: number;
  last_reply_at: number | null;
  english_yield: number;
  cooldown_until: number | null;
}

export function trendKey(woeid: number, name: string): string {
  return `${woeid}:${name.toLowerCase()}`;
}

/** Polls both locations and updates the snapshot log + rollup. Never throws. */
export async function refreshTrends(): Promise<{ global: number; india: number }> {
  const counts = { global: 0, india: 0 };

  for (const woeid of [WOEID_WORLDWIDE, WOEID_INDIA]) {
    const label = sourceLabel(woeid);
    try {
      const trends = await fetchTrends(woeid);
      persistTrends(woeid, trends);
      recordSourceRun(label, true, null);
      if (woeid === WOEID_INDIA) counts.india = trends.length;
      else counts.global = trends.length;
      logger.info('X trends refreshed', { source: label, count: trends.length });
    } catch (err) {
      recordSourceRun(label, false, String(err).slice(0, 300));
      logger.warn('X trends refresh failed', { source: label, err: String(err).slice(0, 200) });
    }
  }

  pruneSnapshots();
  return counts;
}

function persistTrends(woeid: number, trends: RawTrend[]): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const insertSnapshot = db.prepare(`
    INSERT INTO trend_snapshots (woeid, name, query, url, rank, tweet_volume, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const upsert = db.prepare(`
    INSERT INTO trends (
      key, woeid, name, query, first_seen_at, last_seen_at,
      best_rank, last_rank, prev_rank, poll_count, peak_volume,
      script, safety_class, safety_reason, classified_at
    )
    VALUES (@key, @woeid, @name, @query, @now, @now,
            @rank, @rank, NULL, 1, @volume,
            @script, @safetyClass, @safetyReason, @now)
    ON CONFLICT(key) DO UPDATE SET
      query        = @query,
      last_seen_at = @now,
      prev_rank    = trends.last_rank,
      last_rank    = @rank,
      best_rank    = MIN(trends.best_rank, @rank),
      poll_count   = trends.poll_count + 1,
      peak_volume  = MAX(COALESCE(trends.peak_volume, 0), COALESCE(@volume, 0))
  `);

  // Re-run the safety classifier for rows older than a day so rule edits take
  // effect without waiting for the trend to disappear and come back.
  const reclassify = db.prepare(`
    UPDATE trends SET safety_class = ?, safety_reason = ?, classified_at = ?
    WHERE key = ? AND (classified_at IS NULL OR classified_at < ?)
  `);

  const staleBefore = now - 24 * 3600;

  const run = db.transaction((rows: RawTrend[]) => {
    for (const t of rows) {
      insertSnapshot.run(woeid, t.name, t.query, t.url, t.rank, t.tweetVolume, now);

      const safety = classifyTrendSafety(t.name);
      upsert.run({
        key: trendKey(woeid, t.name),
        woeid,
        name: t.name,
        query: t.query,
        now,
        rank: t.rank,
        volume: t.tweetVolume,
        script: detectScript(t.name),
        safetyClass: safety.class,
        safetyReason: safety.reason,
      });
      reclassify.run(safety.class, safety.reason, now, trendKey(woeid, t.name), staleBefore);
    }
  });

  run(trends);
}

function pruneSnapshots(): void {
  const cutoff = Math.floor(Date.now() / 1000) - SNAPSHOT_RETENTION_DAYS * 86400;
  getDb().prepare('DELETE FROM trend_snapshots WHERE captured_at < ?').run(cutoff);
}

// ── Read ──────────────────────────────────────────────────────────────────────

export function listTrends(woeid: number, limit = 50): TrendRow[] {
  return getDb().prepare(`
    SELECT * FROM trends WHERE woeid = ? ORDER BY last_seen_at DESC, last_rank ASC LIMIT ?
  `).all(woeid, limit) as TrendRow[];
}

export function getTrend(key: string): TrendRow | null {
  return (getDb().prepare('SELECT * FROM trends WHERE key = ?').get(key) as TrendRow | undefined) ?? null;
}

/** Seconds since the most recent poll for this location, or Infinity if never. */
export function secondsSinceLastRefresh(woeid: number): number {
  const row = getDb().prepare(
    'SELECT MAX(captured_at) AS at FROM trend_snapshots WHERE woeid = ?',
  ).get(woeid) as { at: number | null };
  if (!row?.at) return Infinity;
  return Math.floor(Date.now() / 1000) - row.at;
}

/** Refreshes only if the cached snapshot has aged past `trend_refresh_minutes`. */
export async function refreshTrendsIfStale(): Promise<void> {
  const maxAge = getIntSetting('trend_refresh_minutes', 30, 10, 240) * 60;
  const stalest = Math.max(
    secondsSinceLastRefresh(WOEID_WORLDWIDE),
    secondsSinceLastRefresh(WOEID_INDIA),
  );
  if (stalest < maxAge) return;
  await refreshTrends();
}

// ── Reply bookkeeping ─────────────────────────────────────────────────────────

export function recordTrendReply(key: string): void {
  const cooldownHours = getIntSetting('trend_cooldown_hours', 12, 1, 72);
  const maxPerDay = getIntSetting('trend_max_replies_per_day', 2, 1, 10);
  const now = Math.floor(Date.now() / 1000);

  getDb().prepare(`
    UPDATE trends
    SET replies_sent = replies_sent + 1,
        last_reply_at = ?,
        cooldown_until = CASE WHEN replies_sent + 1 >= ? THEN ? ELSE cooldown_until END
    WHERE key = ?
  `).run(now, maxPerDay, now + cooldownHours * 3600, key);
}

/**
 * Records how many usable English candidates a trend produced.
 *
 * Worldwide trends are heavily non-English, and script alone can't tell a
 * Turkish trend from an English one. Rather than guess, we search once and
 * remember: a trend that yields nothing usable is benched for a day.
 */
export function recordEnglishYield(key: string, yieldCount: number): void {
  const now = Math.floor(Date.now() / 1000);
  if (yieldCount > 0) {
    getDb().prepare('UPDATE trends SET english_yield = ? WHERE key = ?').run(yieldCount, key);
    return;
  }
  getDb().prepare(
    'UPDATE trends SET english_yield = 0, cooldown_until = ? WHERE key = ?',
  ).run(now + 24 * 3600, key);
}
