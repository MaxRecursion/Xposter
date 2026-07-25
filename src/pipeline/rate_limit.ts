/**
 * Minimum spacing between posted replies.
 *
 * Extracted from the manual-approval route so the autonomous path can use it
 * too. That gap matters much more now: on the home timeline, five replies
 * 8-15 seconds apart is invisible, but under a live trending hashtag it is
 * exactly the burst signature that draws rate-limiting.
 */
import { getDb } from '../storage/db.js';

/** Unix seconds of the most recent posted reply, or null if there is none. */
export function lastReplyPostedAt(): number | null {
  const row = getDb().prepare(`
    SELECT MAX(updated_at) AS at FROM posts WHERE status = 'POSTED'
  `).get() as { at: number | null } | undefined;
  return row?.at ?? null;
}

/** Seconds still to wait before another reply may be posted. 0 when clear. */
export function secondsUntilNextReplyAllowed(minIntervalSec: number): number {
  if (minIntervalSec <= 0) return 0;
  const last = lastReplyPostedAt();
  if (!last) return 0;
  const elapsed = Math.floor(Date.now() / 1000) - last;
  return Math.max(0, minIntervalSec - elapsed);
}
