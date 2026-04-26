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
                        'POSTED','SKIPPED','EXPIRED','ERROR'
                      )),
      score           REAL,
      score_breakdown TEXT,
      generated_reply TEXT,
      final_reply     TEXT,
      ingested_at     INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_posts_status   ON posts(status);
    CREATE INDEX IF NOT EXISTS idx_posts_ingested ON posts(ingested_at DESC);
    CREATE INDEX IF NOT EXISTS idx_posts_tweet_id ON posts(tweet_id);

    CREATE TABLE IF NOT EXISTS activity_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id     TEXT,
      event       TEXT NOT NULL,
      detail      TEXT,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_log_post    ON activity_log(post_id);
    CREATE INDEX IF NOT EXISTS idx_log_created ON activity_log(created_at DESC);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT OR IGNORE INTO settings(key, value) VALUES
      ('system_running',       'true'),
      ('topic_keywords',       'pune,rain,traffic,flooding,waterlogging,pothole,event'),
      ('min_score',            '40'),
      ('max_candidates_per_run', '3'),
      ('approval_timeout_min', '30');
  `);
}
