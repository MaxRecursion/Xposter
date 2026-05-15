import { getDb } from './db.js';

/**
 * Follower-activity heatmap scraped from x.com/i/account_analytics/audience.
 *
 * X aggregates a 7-day × 24-hour grid over the last 28 days. We store the
 * latest snapshot as one row with cells encoded as a 7×24 JSON matrix
 * (matrix[dayOfWeek][hour], dayOfWeek 0=Sunday, hour 0=12am..23=11pm).
 *
 * Intensity is a float 0..1 where 1 = most engaged. Bucket levels 0..4 are
 * also stored for UI display (matches X's 5 legend colors).
 */
export interface AudienceSnapshot {
  id: number;
  fetched_at: number;
  cells_json: string;
  raw_levels: string | null;
  detail: string | null;
}

const MAX_SNAPSHOTS = 30;

function ensureTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS audience_heatmap (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      fetched_at INTEGER NOT NULL,
      cells_json TEXT NOT NULL,
      raw_levels TEXT,
      detail     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audience_heatmap_fetched
      ON audience_heatmap(fetched_at DESC);
  `);
}

export function saveHeatmap(
  cells: number[][],
  levels?: number[][] | null,
  detail?: string,
): AudienceSnapshot {
  ensureTable();
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO audience_heatmap (fetched_at, cells_json, raw_levels, detail)
    VALUES (unixepoch(), ?, ?, ?)
  `).run(JSON.stringify(cells), levels ? JSON.stringify(levels) : null, detail ?? null);

  // Prune anything older than the most recent MAX_SNAPSHOTS rows.
  db.prepare(`
    DELETE FROM audience_heatmap
    WHERE id NOT IN (
      SELECT id FROM audience_heatmap ORDER BY fetched_at DESC LIMIT ?
    )
  `).run(MAX_SNAPSHOTS);

  return db.prepare('SELECT * FROM audience_heatmap WHERE id = ?')
    .get(result.lastInsertRowid as number) as AudienceSnapshot;
}

export function getLatestHeatmap(): AudienceSnapshot | null {
  ensureTable();
  return (getDb()
    .prepare(`SELECT * FROM audience_heatmap ORDER BY fetched_at DESC LIMIT 1`)
    .get() as AudienceSnapshot | undefined) ?? null;
}

export function getHeatmapAgeSeconds(): number | null {
  const latest = getLatestHeatmap();
  if (!latest) return null;
  return Math.floor(Date.now() / 1000) - latest.fetched_at;
}
