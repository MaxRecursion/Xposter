import { getDb } from './db.js';

// ──────────────────────────────────────────────────────────────────────────
// Account classification
// ──────────────────────────────────────────────────────────────────────────

export type Classification =
  | 'SERIOUS' | 'NEWS' | 'PARODY' | 'COMEDY' | 'INFLUENCER'
  | 'REGULAR' | 'BOT' | 'BRAND_PROMO' | 'UNKNOWN';

export interface Account {
  handle: string;
  display_name: string | null;
  bio: string | null;
  bio_fetched_at: number | null;
  classification: Classification | null;
  classification_confidence: number;
  classification_reasoning: string | null;
  classified_at: number | null;
  classification_model: string | null;
  is_marathi_creator: number;
  verified: number;
  follower_count_seen: number;
  following_count_seen: number;
  followed_by_us: number;
  following_us: number;
  mutual_follow: number;
  blocked_or_muted: number;
  total_replies_sent: number;
  total_engagement: number;
  avg_reply_score: number;
  successful_replies: number;
  first_seen_at: number;
  last_seen_at: number;
  updated_at: number;
}

export function upsertAccountSeen(
  handle: string,
  displayName?: string | null,
): Account {
  const db = getDb();
  db.prepare(`
    INSERT INTO accounts (handle, display_name, last_seen_at, updated_at)
    VALUES (?, ?, unixepoch(), unixepoch())
    ON CONFLICT(handle) DO UPDATE SET
      display_name = COALESCE(excluded.display_name, accounts.display_name),
      last_seen_at = unixepoch(),
      updated_at   = unixepoch()
  `).run(handle, displayName ?? null);
  return getAccount(handle)!;
}

export function getAccount(handle: string): Account | null {
  return (getDb()
    .prepare('SELECT * FROM accounts WHERE handle = ?')
    .get(handle) as Account | undefined) ?? null;
}

export function listAccounts(opts: {
  limit?: number;
  classification?: Classification;
  marathiOnly?: boolean;
} = {}): Account[] {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts.classification) {
    conds.push('classification = ?');
    params.push(opts.classification);
  }
  if (opts.marathiOnly) {
    conds.push('is_marathi_creator = 1');
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return getDb().prepare(`
    SELECT * FROM accounts ${where}
    ORDER BY last_seen_at DESC
    LIMIT ?
  `).all(...params, limit) as Account[];
}

export interface ClassificationUpdate {
  classification: Classification;
  confidence: number;
  reasoning: string;
  model: string;
  isMarathiCreator?: boolean;
  bio?: string | null;
  displayName?: string | null;
  verified?: boolean;
  followerCount?: number;
  followingCount?: number;
}

export function setAccountClassification(
  handle: string,
  update: ClassificationUpdate,
): void {
  getDb().prepare(`
    INSERT INTO accounts (
      handle, display_name, bio, bio_fetched_at, classification,
      classification_confidence, classification_reasoning, classified_at,
      classification_model, is_marathi_creator, verified,
      follower_count_seen, following_count_seen, last_seen_at, updated_at
    ) VALUES (?, ?, ?, unixepoch(), ?, ?, ?, unixepoch(), ?, ?, ?, ?, ?, unixepoch(), unixepoch())
    ON CONFLICT(handle) DO UPDATE SET
      display_name              = COALESCE(excluded.display_name, accounts.display_name),
      bio                       = COALESCE(excluded.bio, accounts.bio),
      bio_fetched_at            = excluded.bio_fetched_at,
      classification            = excluded.classification,
      classification_confidence = excluded.classification_confidence,
      classification_reasoning  = excluded.classification_reasoning,
      classified_at             = excluded.classified_at,
      classification_model      = excluded.classification_model,
      is_marathi_creator        = excluded.is_marathi_creator,
      verified                  = excluded.verified,
      follower_count_seen       = MAX(excluded.follower_count_seen, accounts.follower_count_seen),
      following_count_seen      = MAX(excluded.following_count_seen, accounts.following_count_seen),
      updated_at                = unixepoch()
  `).run(
    handle,
    update.displayName ?? null,
    update.bio ?? null,
    update.classification,
    update.confidence,
    update.reasoning,
    update.model,
    update.isMarathiCreator ? 1 : 0,
    update.verified ? 1 : 0,
    update.followerCount ?? 0,
    update.followingCount ?? 0,
  );
}

export function classificationIsFresh(
  account: Account | null,
  ttlDays: number,
): boolean {
  if (!account?.classified_at || !account.classification) return false;
  const ageSec = Math.floor(Date.now() / 1000) - account.classified_at;
  return ageSec < ttlDays * 86400;
}

// ──────────────────────────────────────────────────────────────────────────
// Interaction tracking
// ──────────────────────────────────────────────────────────────────────────

export interface Interaction {
  id: number;
  post_id: string;
  account_handle: string;
  our_reply_text: string;
  our_tweet_id: string | null;
  our_tweet_url: string | null;
  posted_at: number;
  likes_received: number;
  replies_received: number;
  retweets_received: number;
  impressions: number;
  last_metric_check: number | null;
  success_score: number;
  author_engaged: number;
  notes: string | null;
}

export function recordInteraction(
  postId: string,
  accountHandle: string,
  replyText: string,
  posted: { tweetId?: string; tweetUrl?: string } = {},
): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO interactions (
      post_id, account_handle, our_reply_text, our_tweet_id, our_tweet_url
    ) VALUES (?, ?, ?, ?, ?)
  `).run(postId, accountHandle, replyText, posted.tweetId ?? null, posted.tweetUrl ?? null);

  // Bump aggregate counters on accounts
  db.prepare(`
    INSERT INTO accounts (handle, total_replies_sent, last_seen_at, updated_at)
    VALUES (?, 1, unixepoch(), unixepoch())
    ON CONFLICT(handle) DO UPDATE SET
      total_replies_sent = accounts.total_replies_sent + 1,
      last_seen_at       = unixepoch(),
      updated_at         = unixepoch()
  `).run(accountHandle);

  return result.lastInsertRowid as number;
}

export function updateInteractionMetrics(
  id: number,
  metrics: {
    likes?: number;
    replies?: number;
    retweets?: number;
    impressions?: number;
    authorEngaged?: boolean;
  },
): void {
  const successScore =
    (metrics.likes ?? 0) * 1 +
    (metrics.replies ?? 0) * 13 +
    (metrics.retweets ?? 0) * 20 +
    (metrics.authorEngaged ? 25 : 0);

  getDb().prepare(`
    UPDATE interactions SET
      likes_received    = COALESCE(?, likes_received),
      replies_received  = COALESCE(?, replies_received),
      retweets_received = COALESCE(?, retweets_received),
      impressions       = COALESCE(?, impressions),
      author_engaged    = COALESCE(?, author_engaged),
      last_metric_check = unixepoch(),
      success_score     = ?
    WHERE id = ?
  `).run(
    metrics.likes ?? null,
    metrics.replies ?? null,
    metrics.retweets ?? null,
    metrics.impressions ?? null,
    metrics.authorEngaged === undefined ? null : (metrics.authorEngaged ? 1 : 0),
    successScore,
    id,
  );
}

export function listRecentInteractions(limit = 50): Interaction[] {
  return getDb()
    .prepare(`SELECT * FROM interactions ORDER BY posted_at DESC LIMIT ?`)
    .all(Math.min(Math.max(limit, 1), 500)) as Interaction[];
}

export function getInteractionStats(): {
  total: number;
  total_likes: number;
  total_replies: number;
  total_retweets: number;
  avg_success: number;
} {
  const row = getDb().prepare(`
    SELECT
      COUNT(*)                       AS total,
      COALESCE(SUM(likes_received),0)    AS total_likes,
      COALESCE(SUM(replies_received),0)  AS total_replies,
      COALESCE(SUM(retweets_received),0) AS total_retweets,
      COALESCE(AVG(success_score),0)     AS avg_success
    FROM interactions
  `).get() as any;
  return row;
}

// ──────────────────────────────────────────────────────────────────────────
// Follower events
// ──────────────────────────────────────────────────────────────────────────

export type FollowerEventType = 'NEW_FOLLOWER' | 'UNFOLLOWED' | 'FOLLOW_BACK_DUE';
export type FollowerEventStatus =
  | 'PENDING' | 'APPROVED' | 'ACTIONED' | 'SKIPPED' | 'ERROR' | 'EXPIRED';

export interface FollowerEvent {
  id: number;
  account_handle: string;
  event_type: FollowerEventType;
  status: FollowerEventStatus;
  detected_at: number;
  action_taken_at: number | null;
  detail: string | null;
}

export function enqueueFollowerEvent(
  handle: string,
  type: FollowerEventType,
  detail?: string,
): number | null {
  // Skip if there is already an open (pending/approved) event for this handle/type
  const existing = getDb().prepare(`
    SELECT id FROM follower_events
    WHERE account_handle = ? AND event_type = ? AND status IN ('PENDING','APPROVED')
  `).get(handle, type) as { id: number } | undefined;
  if (existing) return null;

  const result = getDb().prepare(`
    INSERT INTO follower_events (account_handle, event_type, detail) VALUES (?, ?, ?)
  `).run(handle, type, detail ?? null);
  return result.lastInsertRowid as number;
}

export function getFollowerEvent(id: number): FollowerEvent | null {
  return (getDb()
    .prepare('SELECT * FROM follower_events WHERE id = ?')
    .get(id) as FollowerEvent | undefined) ?? null;
}

export function listFollowerEvents(status?: FollowerEventStatus): FollowerEvent[] {
  if (status) {
    return getDb()
      .prepare(`SELECT * FROM follower_events WHERE status = ? ORDER BY detected_at DESC LIMIT 200`)
      .all(status) as FollowerEvent[];
  }
  return getDb()
    .prepare(`SELECT * FROM follower_events ORDER BY detected_at DESC LIMIT 200`)
    .all() as FollowerEvent[];
}

export function setFollowerEventStatus(
  id: number,
  status: FollowerEventStatus,
  detail?: string,
): void {
  getDb().prepare(`
    UPDATE follower_events
    SET status = ?, action_taken_at = unixepoch(),
        detail = COALESCE(?, detail)
    WHERE id = ?
  `).run(status, detail ?? null, id);
}

export function countActionedFollowBacksToday(): number {
  const startOfDay = startOfTodayUnix();
  const row = getDb().prepare(`
    SELECT COUNT(*) AS n FROM follower_events
    WHERE event_type = 'NEW_FOLLOWER'
      AND status = 'ACTIONED'
      AND COALESCE(action_taken_at, 0) >= ?
  `).get(startOfDay) as { n: number };
  return row.n;
}

export function setFollowingState(handle: string, ourFollow: boolean): void {
  getDb().prepare(`
    INSERT INTO accounts (handle, followed_by_us, last_seen_at, updated_at)
    VALUES (?, ?, unixepoch(), unixepoch())
    ON CONFLICT(handle) DO UPDATE SET
      followed_by_us = ?, updated_at = unixepoch()
  `).run(handle, ourFollow ? 1 : 0, ourFollow ? 1 : 0);
}

export function setFollowerState(handle: string, theyFollowUs: boolean): void {
  getDb().prepare(`
    INSERT INTO accounts (handle, following_us, last_seen_at, updated_at)
    VALUES (?, ?, unixepoch(), unixepoch())
    ON CONFLICT(handle) DO UPDATE SET
      following_us = ?, updated_at = unixepoch()
  `).run(handle, theyFollowUs ? 1 : 0, theyFollowUs ? 1 : 0);
}

function startOfTodayUnix(): number {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor(start.getTime() / 1000);
}

// ──────────────────────────────────────────────────────────────────────────
// Scheduled runs (today's randomized pipeline times)
// ──────────────────────────────────────────────────────────────────────────

export interface ScheduledRun {
  id: number;
  run_date: string;
  run_at: number;
  kind: string;
  status: 'SCHEDULED' | 'FIRED' | 'SKIPPED' | 'ERROR';
  fired_at: number | null;
  detail: string | null;
}

export function insertScheduledRun(date: string, runAt: number, kind = 'PIPELINE', detail?: string): void {
  getDb().prepare(`
    INSERT OR IGNORE INTO scheduled_runs (run_date, run_at, kind, detail) VALUES (?, ?, ?, ?)
  `).run(date, runAt, kind, detail ?? null);
}

export function getScheduledRunsForDate(date: string, kind = 'PIPELINE'): ScheduledRun[] {
  return getDb()
    .prepare(`SELECT * FROM scheduled_runs WHERE run_date = ? AND kind = ? ORDER BY run_at`)
    .all(date, kind) as ScheduledRun[];
}

export function getDuePendingRuns(now: number, kind = 'PIPELINE'): ScheduledRun[] {
  return getDb()
    .prepare(`SELECT * FROM scheduled_runs WHERE status='SCHEDULED' AND run_at <= ? AND kind = ? ORDER BY run_at`)
    .all(now, kind) as ScheduledRun[];
}

export function getUpcomingRuns(now: number, limit = 10, kind = 'PIPELINE'): ScheduledRun[] {
  return getDb()
    .prepare(`SELECT * FROM scheduled_runs WHERE status='SCHEDULED' AND run_at >= ? AND kind = ? ORDER BY run_at LIMIT ?`)
    .all(now, kind, limit) as ScheduledRun[];
}

export function markRunFired(id: number, detail?: string): void {
  getDb().prepare(`
    UPDATE scheduled_runs
    SET status='FIRED', fired_at=unixepoch(), detail=COALESCE(?, detail)
    WHERE id=?
  `).run(detail ?? null, id);
}

export function markRunSkipped(id: number, detail: string): void {
  getDb().prepare(`
    UPDATE scheduled_runs
    SET status='SKIPPED', fired_at=unixepoch(), detail=?
    WHERE id=?
  `).run(detail, id);
}
