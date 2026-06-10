import { fetchOurFollowerEntries, resolveOwnHandle, type FollowerListEntry } from '../browser/followers.js';
import {
  listFollowerHandles, setFollowerState, setFollowingState, upsertPendingFollowBackEvent,
} from '../storage/accounts.js';
import { autoApproveFollowBack } from '../storage/follower_events.js';
import { logEvent } from '../storage/queries.js';
import { getBooleanSetting, getIntSetting, getListSetting } from '../storage/settings.js';
import { logger } from '../utils/logger.js';
import { randomBetween } from '../utils/delay.js';
import { sendFollowerNotification } from '../notifications/ntfy.js';
import { classifyAccount } from '../pipeline/classifier.js';

const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;  // 6 hours
let _interval: NodeJS.Timeout | null = null;
let _bootTimer: NodeJS.Timeout | null = null;

export interface FollowerSyncResult {
  ok: boolean;
  newFollowers: number;
  queued: number;
  total: number;
  notFollowedBack?: number;
  autoScheduled?: number;
  handle?: string;
  reason?: string;
  message?: string;
}

// ── Auto-follow-back policy ───────────────────────────────────────────────────

export interface AutoFollowBackConfig {
  enabled: boolean;
  /** Uppercased classifications that qualify for an automatic follow-back. */
  classifications: Set<string>;
  /** Minimum classification confidence, as a 0–100 percentage. */
  minConfidencePct: number;
}

export function getAutoFollowBackConfig(): AutoFollowBackConfig {
  return {
    enabled: getBooleanSetting('auto_follow_back_enabled', false),
    classifications: new Set(
      getListSetting('auto_follow_back_classifications', ['REGULAR', 'SERIOUS'])
        .map((c) => c.toUpperCase()),
    ),
    minConfidencePct: getIntSetting('auto_follow_back_min_confidence', 60, 0, 100),
  };
}

/** Pure decision: should this follower be followed back without asking? */
export function shouldAutoFollowBack(
  cfg: AutoFollowBackConfig,
  classification: string | null,
  confidence: number,
): boolean {
  if (!cfg.enabled || !classification) return false;
  if (!cfg.classifications.has(classification.toUpperCase())) return false;
  return confidence * 100 >= cfg.minConfidencePct;
}

export function startFollowerSync(): void {
  if (_interval) return;

  // First sync 5 minutes after boot (let everything settle)
  _bootTimer = setTimeout(() => {
    void runFollowerSync().catch((err) => logger.error('Follower sync failed', { err }));
  }, 5 * 60_000);
  _interval = setInterval(() => {
    void runFollowerSync().catch((err) => logger.error('Follower sync failed', { err }));
  }, SYNC_INTERVAL_MS);

  logger.info('Follower sync scheduled', { everyHours: SYNC_INTERVAL_MS / 3_600_000 });
}

export function stopFollowerSync(): void {
  if (_bootTimer) { clearTimeout(_bootTimer); _bootTimer = null; }
  if (_interval) { clearInterval(_interval); _interval = null; }
}

/**
 * One pass:
 *   1. Read X_HANDLE env var (our own handle). If missing, log and skip.
 *   2. Fetch follower rows via Playwright from the main followers timeline.
 *   3. Mark accounts as following us and record whether we already follow them.
 *   4. For confirmed followers we do not follow back:
 *        - classify (cached) so the pending decision has useful context
 *        - enqueue or refresh a PENDING follow-back decision
 *        - send one ntfy notification only for newly-created decisions
 */
export async function runFollowerSync(): Promise<FollowerSyncResult> {
  const me = await resolveOwnHandle();
  if (!me) {
    const message = 'Could not determine your X handle. Set X_HANDLE in .env or log in to X in the browser profile.';
    logger.warn(message);
    logEvent('FOLLOWER_SYNC_SKIPPED', message);
    return { ok: false, reason: 'missing_handle', message, newFollowers: 0, queued: 0, total: 0 };
  }

  if (!getBooleanSetting('system_running', true)) {
    return {
      ok: false,
      reason: 'system_paused',
      message: 'System is paused. Resume it before syncing followers.',
      newFollowers: 0,
      queued: 0,
      total: 0,
      handle: me,
    };
  }

  logEvent('FOLLOWER_SYNC_START');
  let followers: FollowerListEntry[] = [];
  try {
    followers = await fetchOurFollowerEntries(me, 200);
  } catch (err) {
    const message = `Follower fetch failed: ${String(err)}`;
    logger.error('Follower fetch failed', { err: String(err) });
    logEvent('FOLLOWER_SYNC_ERROR', message);
    return { ok: false, reason: 'fetch_failed', message, newFollowers: 0, queued: 0, total: 0, handle: me };
  }

  const knownFollowers = listFollowerHandles();

  const newOnes: string[] = [];
  const notFollowedBack: string[] = [];
  for (const entry of followers) {
    const handle = entry.handle;
    setFollowerState(handle, true);
    if (!knownFollowers.has(handle.toLowerCase())) newOnes.push(handle);
    if (entry.followedByUs !== null) {
      setFollowingState(handle, entry.followedByUs);
    }
    if (entry.followedByUs === false) {
      notFollowedBack.push(handle);
    }
  }

  // Cap to avoid notification/classification bursts on first run after a long absence.
  const maxPerRun = 5;
  const autoCfg = getAutoFollowBackConfig();

  let queued = 0;
  let autoScheduled = 0;
  for (const handle of notFollowedBack.slice(0, maxPerRun)) {
    try {
      const account = await classifyAccount(handle, null, { fetchProfileIfMissing: true });
      const cls = (account.classification ?? 'UNKNOWN').toUpperCase();
      const detail = `source=follower_scan_v2; relationship=not_followed_back; classification=${cls}; followers=${account.follower_count_seen}`;
      const event = upsertPendingFollowBackEvent(handle, detail);

      if (event !== null) {
        queued++;
        logEvent('FOLLOW_BACK_PENDING', `@${handle} follows you; you do not follow back`, undefined);
        logger.info('Queued pending follow-back decision', { handle, cls, created: event.created });

        if (shouldAutoFollowBack(autoCfg, account.classification, account.classification_confidence)) {
          // Safe classification → schedule the follow automatically at a
          // randomized delay; the 5-minute processor executes it (and
          // enforces the daily cap). No approval notification needed.
          const delayMin = randomBetween(5, 60);
          const scheduledAt = Math.floor(Date.now() / 1000) + delayMin * 60;
          autoApproveFollowBack(event.id, scheduledAt, `${detail}; auto_follow=true`);
          autoScheduled++;
          logEvent('FOLLOW_BACK_AUTO_SCHEDULED', `@${handle} (${cls}) in ~${delayMin}m`);
          logger.info('Auto follow-back scheduled', { handle, cls, delayMin });
        } else if (event.created) {
          await sendFollowerNotification(event.id, handle, account).catch((err) => {
            logger.warn('Follower notification failed', { handle, err: String(err) });
          });
        }
      }
    } catch (err) {
      logger.warn('Failed to process pending follow-back candidate', { handle, err: String(err) });
    }
  }

  if (notFollowedBack.length > maxPerRun) {
    logEvent(
      'FOLLOW_BACK_BATCH_TRUNCATED',
      `${notFollowedBack.length} not-followed-back followers; processed ${maxPerRun}`,
    );
  }

  logEvent('FOLLOWER_SYNC_COMPLETE', `total=${followers.length} new=${newOnes.length} notFollowedBack=${notFollowedBack.length} autoScheduled=${autoScheduled}`);
  logger.info('Follower sync complete', {
    total: followers.length,
    new: newOnes.length,
    notFollowedBack: notFollowedBack.length,
    autoScheduled,
  });
  return {
    ok: true,
    newFollowers: newOnes.length,
    queued,
    total: followers.length,
    notFollowedBack: notFollowedBack.length,
    autoScheduled,
    handle: me,
  };
}
