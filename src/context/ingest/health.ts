import { getDb } from '../../storage/db.js';

export interface SourceHealth {
  source: string;
  lastRunAt: number | null;
  lastOkAt: number | null;
  consecutiveFailures: number;
  lastError: string | null;
}

export function recordSourceRun(source: string, ok: boolean, error: string | null): void {
  const now = Math.floor(Date.now() / 1000);
  const errTrimmed = error ? error.slice(0, 500) : null;
  getDb().prepare(`
    INSERT INTO context_source_health (source, last_run_at, last_ok_at,
                                        consecutive_failures, last_error)
    VALUES (
      @source, @now,
      CASE WHEN @ok = 1 THEN @now ELSE NULL END,
      CASE WHEN @ok = 1 THEN 0 ELSE 1 END,
      @error
    )
    ON CONFLICT(source) DO UPDATE SET
      last_run_at = @now,
      last_ok_at = CASE WHEN @ok = 1 THEN @now ELSE context_source_health.last_ok_at END,
      consecutive_failures =
        CASE WHEN @ok = 1 THEN 0
             ELSE context_source_health.consecutive_failures + 1 END,
      last_error = CASE WHEN @ok = 1 THEN NULL ELSE @error END
  `).run({ source, now, ok: ok ? 1 : 0, error: errTrimmed });
}

/**
 * Consecutive failures for one source, or 0 when it has never run.
 *
 * Used by the ingest circuit breaker: a feed that has been dead for months
 * (a subreddit now behind OAuth, a retired feed URL) otherwise keeps its full
 * schedule forever, spending a request every interval to collect the same 403.
 */
export function getConsecutiveFailures(source: string): number {
  const row = getDb()
    .prepare('SELECT consecutive_failures AS n FROM context_source_health WHERE source = ?')
    .get(source) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function getSourceHealth(): SourceHealth[] {
  const rows = getDb()
    .prepare('SELECT * FROM context_source_health ORDER BY source')
    .all() as Array<{
      source: string;
      last_run_at: number | null;
      last_ok_at: number | null;
      consecutive_failures: number;
      last_error: string | null;
    }>;
  return rows.map((r) => ({
    source: r.source,
    lastRunAt: r.last_run_at,
    lastOkAt: r.last_ok_at,
    consecutiveFailures: r.consecutive_failures,
    lastError: r.last_error,
  }));
}
