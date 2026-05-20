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

export {
  getInteractionStats,
  listRecentInteractions,
  recordInteraction,
  updateInteractionMetrics,
} from './interactions.js';
export type { Interaction } from './interactions.js';

export {
  countActionedFollowBacksToday,
  enqueueFollowerEvent,
  getFollowerEvent,
  listFollowerEvents,
  listPendingFollowBackEvents,
  setFollowerEventStatus,
  upsertPendingFollowBackEvent,
} from './follower_events.js';
export type {
  FollowerEvent,
  FollowerEventStatus,
  FollowerEventType,
  UpsertFollowerEventResult,
} from './follower_events.js';

export {
  getDuePendingRuns,
  getScheduledRunsForDate,
  getUpcomingRuns,
  insertScheduledRun,
  markRunFired,
  markRunSkipped,
} from './scheduled_runs.js';
export type { ScheduledRun } from './scheduled_runs.js';

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
