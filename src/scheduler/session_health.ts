import { isLoggedIn } from '../browser/session.js';
import { sendSessionExpiredNotification } from '../notifications/ntfy.js';
import { logEvent } from '../storage/queries.js';
import { setSetting } from '../storage/settings.js';
import { logger } from '../utils/logger.js';

const CHECK_INTERVAL_MS = 15 * 60_000;
const BOOT_DELAY_MS = 2 * 60_000;

let _interval: NodeJS.Timeout | null = null;
let _bootTimer: NodeJS.Timeout | null = null;
let _running = false;
let _lastLoggedIn: boolean | null = null;

export function startSessionHealthWatchdog(): void {
  if (_interval) return;
  _bootTimer = setTimeout(() => { void runSessionHealthCheck('boot'); }, BOOT_DELAY_MS);
  _interval = setInterval(() => { void runSessionHealthCheck('interval'); }, CHECK_INTERVAL_MS);
  logger.info('Session health watchdog started', {
    everyMinutes: CHECK_INTERVAL_MS / 60_000,
  });
}

export function stopSessionHealthWatchdog(): void {
  if (_bootTimer) { clearTimeout(_bootTimer); _bootTimer = null; }
  if (_interval) { clearInterval(_interval); _interval = null; }
  _lastLoggedIn = null;
}

export async function runSessionHealthCheck(
  trigger: 'boot' | 'interval' | 'manual' = 'manual',
): Promise<{ loggedIn: boolean | null; paused: boolean; alerted: boolean }> {
  if (_running) return { loggedIn: null, paused: false, alerted: false };
  _running = true;

  try {
    const loggedIn = await isLoggedIn();
    if (loggedIn) {
      if (_lastLoggedIn === false) {
        logEvent('SESSION_RESTORED', `trigger=${trigger}; manual resume required`);
        logger.info('X session restored; system remains paused until manually resumed');
      }
      _lastLoggedIn = true;
      return { loggedIn: true, paused: false, alerted: false };
    }

    const transitionedToLoggedOut = _lastLoggedIn !== false;
    _lastLoggedIn = false;
    if (!transitionedToLoggedOut) {
      return { loggedIn: false, paused: false, alerted: false };
    }

    setSetting('system_running', 'false');
    logEvent('SESSION_EXPIRED', `trigger=${trigger}; system paused`);
    logger.error('X session is logged out; schedulers paused');

    const notification = await sendSessionExpiredNotification();
    if (!notification.ok) {
      logEvent('NOTIFICATION_FAILED', notification.error ?? 'session alert failed');
    }
    return { loggedIn: false, paused: true, alerted: notification.ok };
  } catch (err) {
    logger.warn('Session health check failed without changing scheduler state', {
      trigger,
      err: String(err),
    });
    logEvent('SESSION_HEALTH_CHECK_ERROR', String(err));
    return { loggedIn: null, paused: false, alerted: false };
  } finally {
    _running = false;
  }
}
