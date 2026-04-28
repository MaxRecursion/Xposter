import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger.js';

const DB_PATH = process.env.DB_PATH_OVERRIDE
  ? path.resolve(process.cwd(), process.env.DB_PATH_OVERRIDE)
  : path.resolve(process.cwd(), 'data', 'xposter.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  applyMigrations(_db);
  logger.info('SQLite database ready', { path: DB_PATH });
  return _db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`
    -- ──────────────────────────────────────────────────────────────────────
    -- posts: every tweet we've ever ingested + its lifecycle
    -- ──────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS posts (
      id              TEXT PRIMARY KEY,
      tweet_id        TEXT UNIQUE NOT NULL,
      author_handle   TEXT NOT NULL,
      author_name     TEXT NOT NULL,
      text            TEXT NOT NULL,
      language        TEXT NOT NULL DEFAULT 'unknown',
      timestamp       INTEGER NOT NULL,
      likes           INTEGER NOT NULL DEFAULT 0,
      replies         INTEGER NOT NULL DEFAULT 0,
      retweets        INTEGER NOT NULL DEFAULT 0,
      tweet_url       TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'INGESTED'
                      CHECK(status IN (
                        'INGESTED','FILTERED','SCORED','GENERATING',
                        'PENDING_APPROVAL','APPROVED','POSTING',
                        'POSTED','SKIPPED','EXPIRED','ERROR','DELETED'
                      )),
      score           REAL,
      score_breakdown TEXT,
      generated_reply TEXT,
      final_reply     TEXT,
      posted_tweet_id TEXT,
      ingested_at     INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_posts_status   ON posts(status);
    CREATE INDEX IF NOT EXISTS idx_posts_ingested ON posts(ingested_at DESC);
    CREATE INDEX IF NOT EXISTS idx_posts_tweet_id ON posts(tweet_id);
    CREATE INDEX IF NOT EXISTS idx_posts_author   ON posts(author_handle);

    -- ──────────────────────────────────────────────────────────────────────
    -- activity_log: every system event for the hacker console
    -- ──────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS activity_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id     TEXT,
      event       TEXT NOT NULL,
      detail      TEXT,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_log_post    ON activity_log(post_id);
    CREATE INDEX IF NOT EXISTS idx_log_created ON activity_log(created_at DESC);

    -- ──────────────────────────────────────────────────────────────────────
    -- settings: simple kv store
    -- ──────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT OR IGNORE INTO settings(key, value) VALUES
      ('system_running',          'true'),
      ('topic_keywords',          'pune,rain,traffic,flooding,waterlogging,pothole,event'),
      ('min_score',               '40'),
      ('max_candidates_per_run',  '3'),
      ('approval_timeout_min',    '30'),
      ('wit_level',               '55'),
      ('random_runs_per_day',     '5'),
      ('active_window_start_hour','9'),
      ('active_window_end_hour',  '22'),
      ('max_follow_backs_per_day','15'),
      ('classification_ttl_days', '7'),
      ('marathi_priority_boost',  '15'),
      ('blocklist_classifications','BOT,SPAM,BRAND_PROMO');

    -- ──────────────────────────────────────────────────────────────────────
    -- accounts: every X account we've encountered + its classification
    -- ──────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS accounts (
      handle                    TEXT PRIMARY KEY,
      display_name              TEXT,
      bio                       TEXT,
      bio_fetched_at            INTEGER,
      classification            TEXT,    -- SERIOUS|NEWS|PARODY|COMEDY|INFLUENCER|REGULAR|BOT|BRAND_PROMO|UNKNOWN
      classification_confidence REAL DEFAULT 0,
      classification_reasoning  TEXT,
      classified_at             INTEGER,
      classification_model      TEXT,
      is_marathi_creator        INTEGER DEFAULT 0,
      verified                  INTEGER DEFAULT 0,
      follower_count_seen       INTEGER DEFAULT 0,
      following_count_seen      INTEGER DEFAULT 0,

      followed_by_us            INTEGER DEFAULT 0, -- 1 if we follow them
      following_us              INTEGER DEFAULT 0, -- 1 if they follow us
      mutual_follow             INTEGER GENERATED ALWAYS AS
                                 (followed_by_us AND following_us) VIRTUAL,
      blocked_or_muted          INTEGER DEFAULT 0,

      total_replies_sent        INTEGER DEFAULT 0,
      total_engagement          INTEGER DEFAULT 0,
      avg_reply_score           REAL DEFAULT 0,
      successful_replies        INTEGER DEFAULT 0,

      first_seen_at             INTEGER NOT NULL DEFAULT (unixepoch()),
      last_seen_at              INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at                INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_classification ON accounts(classification);
    CREATE INDEX IF NOT EXISTS idx_accounts_following_us   ON accounts(following_us);
    CREATE INDEX IF NOT EXISTS idx_accounts_followed_by_us ON accounts(followed_by_us);
    CREATE INDEX IF NOT EXISTS idx_accounts_marathi        ON accounts(is_marathi_creator);
    CREATE INDEX IF NOT EXISTS idx_accounts_last_seen      ON accounts(last_seen_at DESC);

    -- ──────────────────────────────────────────────────────────────────────
    -- interactions: every reply we posted, with engagement tracking
    -- ──────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS interactions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id           TEXT NOT NULL REFERENCES posts(id),
      account_handle    TEXT NOT NULL REFERENCES accounts(handle),
      our_reply_text    TEXT NOT NULL,
      our_tweet_id      TEXT,
      our_tweet_url     TEXT,
      posted_at         INTEGER NOT NULL DEFAULT (unixepoch()),
      likes_received    INTEGER DEFAULT 0,
      replies_received  INTEGER DEFAULT 0,
      retweets_received INTEGER DEFAULT 0,
      impressions       INTEGER DEFAULT 0,
      last_metric_check INTEGER,
      success_score     REAL DEFAULT 0,
      author_engaged    INTEGER DEFAULT 0,
      notes             TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_interactions_account ON interactions(account_handle);
    CREATE INDEX IF NOT EXISTS idx_interactions_posted  ON interactions(posted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_interactions_post    ON interactions(post_id);

    -- ──────────────────────────────────────────────────────────────────────
    -- follower_events: detected follower changes pending action
    -- Status: PENDING -> APPROVED -> ACTIONED  |  SKIPPED  |  AUTO_FOLLOWED_BACK
    -- ──────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS follower_events (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      account_handle    TEXT NOT NULL,
      event_type        TEXT NOT NULL CHECK(event_type IN (
                          'NEW_FOLLOWER','UNFOLLOWED','FOLLOW_BACK_DUE'
                        )),
      status            TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN (
                          'PENDING','APPROVED','ACTIONED','SKIPPED','ERROR','EXPIRED'
                        )),
      detected_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      action_taken_at   INTEGER,
      detail            TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_follower_events_status   ON follower_events(status);
    CREATE INDEX IF NOT EXISTS idx_follower_events_account  ON follower_events(account_handle);
    CREATE INDEX IF NOT EXISTS idx_follower_events_detected ON follower_events(detected_at DESC);

    -- ──────────────────────────────────────────────────────────────────────
    -- scheduled_runs: today's randomly-picked pipeline runtimes
    -- ──────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS scheduled_runs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date     TEXT NOT NULL,        -- YYYY-MM-DD (local)
      run_at       INTEGER NOT NULL,     -- unix seconds
      kind         TEXT NOT NULL DEFAULT 'PIPELINE',
      status       TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK(status IN (
                     'SCHEDULED','FIRED','SKIPPED','ERROR'
                   )),
      fired_at     INTEGER,
      detail       TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_runs_dedup
      ON scheduled_runs(run_date, run_at, kind);
    CREATE INDEX IF NOT EXISTS idx_scheduled_runs_pending
      ON scheduled_runs(status, run_at);

    -- ──────────────────────────────────────────────────────────────────────
    -- original_posts: brand-new tweets we authored (not replies)
    -- ──────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS original_posts (
      id               TEXT PRIMARY KEY,
      content          TEXT NOT NULL,
      language         TEXT NOT NULL DEFAULT 'english',
      topic            TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'GENERATING'
                       CHECK(status IN ('GENERATING','POSTED','ERROR','SKIPPED')),
      tweet_id         TEXT,
      tweet_url        TEXT,
      research_context TEXT,
      posted_at        INTEGER,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_original_posts_status  ON original_posts(status);
    CREATE INDEX IF NOT EXISTS idx_original_posts_topic   ON original_posts(topic);
    CREATE INDEX IF NOT EXISTS idx_original_posts_created ON original_posts(created_at DESC);

    -- ──────────────────────────────────────────────────────────────────────
    -- post_impressions: periodic engagement checks on our original tweets
    -- ──────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS post_impressions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      original_post_id TEXT NOT NULL REFERENCES original_posts(id),
      tweet_id         TEXT NOT NULL,
      impressions      INTEGER DEFAULT 0,
      likes            INTEGER DEFAULT 0,
      replies          INTEGER DEFAULT 0,
      retweets         INTEGER DEFAULT 0,
      checked_at       INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_post_impressions_post    ON post_impressions(original_post_id);
    CREATE INDEX IF NOT EXISTS idx_post_impressions_checked ON post_impressions(checked_at DESC);
  `);

  // Insert default settings for original posts feature
  db.prepare(`
    INSERT OR IGNORE INTO settings(key, value) VALUES
      ('original_posts_per_day',    '5'),
      ('original_post_marathi_ratio','40'),
      ('impression_sync_interval_h', '2')
  `).run();

  // Forward-compatible column adds (sqlite ALTER TABLE doesn't support IF NOT EXISTS)
  addColumnIfMissing(db, 'posts', 'posted_tweet_id', 'TEXT');
  addColumnIfMissing(db, 'posts', 'deleted_at', 'INTEGER');

}
// Note: the DELETED status is allowed on existing DBs via PRAGMA ignore_check_constraints
// inside markReplyDeleted() in queries.ts (new DBs have it in the CHECK from the start).

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
