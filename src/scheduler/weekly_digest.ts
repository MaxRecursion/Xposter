import { sendWeeklyDigestNotification } from '../notifications/ntfy.js';
import { getWeeklyDigest } from '../storage/digest.js';
import { getBooleanSetting, getIntSetting, getSetting, setSetting } from '../storage/settings.js';
import { logEvent } from '../storage/queries.js';
import { logger } from '../utils/logger.js';

const CHECK_INTERVAL_MS = 60 * 60_000;
const BOOT_DELAY_MS = 4 * 60_000;

let _interval: NodeJS.Timeout | null = null;
let _bootTimer: NodeJS.Timeout | null = null;
let _running = false;

export function startWeeklyDigestScheduler(): void {
  if (_interval) return;
  _bootTimer = setTimeout(() => { void runWeeklyDigest('scheduled'); }, BOOT_DELAY_MS);
  _interval = setInterval(() => { void runWeeklyDigest('scheduled'); }, CHECK_INTERVAL_MS);
  logger.info('Weekly digest scheduler started');
}

export function stopWeeklyDigestScheduler(): void {
  if (_bootTimer) { clearTimeout(_bootTimer); _bootTimer = null; }
  if (_interval) { clearInterval(_interval); _interval = null; }
}

export async function runWeeklyDigest(
  trigger: 'scheduled' | 'manual' = 'manual',
  now = new Date(),
): Promise<{ sent: boolean; skipped?: string; error?: string }> {
  if (_running) return { sent: false, skipped: 'already running' };
  if (!getBooleanSetting('weekly_digest_enabled', true)) {
    return { sent: false, skipped: 'disabled' };
  }

  const digestHour = getIntSetting('weekly_digest_hour', 9, 0, 23);
  if (trigger === 'scheduled' && (now.getDay() !== 0 || now.getHours() < digestHour)) {
    return { sent: false, skipped: 'not due' };
  }

  const weekKey = currentWeekKey(now);
  if (getSetting('weekly_digest_last_sent_week', '') === weekKey) {
    return { sent: false, skipped: 'already sent this week' };
  }

  _running = true;
  try {
    const digest = getWeeklyDigest(Math.floor(now.getTime() / 1000));
    const result = await sendWeeklyDigestNotification(digest);
    if (!result.ok) {
      logEvent('WEEKLY_DIGEST_FAILED', result.error ?? 'unknown error');
      return { sent: false, error: result.error ?? 'notification failed' };
    }

    setSetting('weekly_digest_last_sent_week', weekKey);
    logEvent(
      'WEEKLY_DIGEST_SENT',
      `replies=${digest.replies_posted} followers=${digest.follower_delta} topic=${digest.best_topic?.topic ?? 'none'}`,
    );
    logger.info('Weekly digest sent', { weekKey, replies: digest.replies_posted });
    return { sent: true };
  } finally {
    _running = false;
  }
}

function currentWeekKey(now: Date): string {
  const sunday = new Date(now);
  sunday.setHours(12, 0, 0, 0);
  sunday.setDate(sunday.getDate() - sunday.getDay());
  const y = sunday.getFullYear();
  const m = String(sunday.getMonth() + 1).padStart(2, '0');
  const d = String(sunday.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
