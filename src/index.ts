// Must stay the first import: loads .env before any other module reads process.env.
import './env.js';
import { createServer } from './api/server.js';
import { getDb } from './storage/db.js';
import { startScheduler } from './scheduler/cron.js';
import { isLoggedIn } from './browser/session.js';
import { logger, trimLaunchdLog } from './utils/logger.js';
import { getBindHost, getBrowserUrls, getPort } from './utils/network.js';
import { getIngestCron } from './config.js';
import { getTelemetryStatus, shutdownTelemetry } from './telemetry/bootstrap.js';
import { stopScheduler } from './scheduler/cron.js';

async function main(): Promise<void> {
  logger.info('=== Xposter starting ===');
  trimLaunchdLog();

  // Initialize database
  getDb();

  // Boot server
  const port = parseInt(getPort(), 10);
  const host = getBindHost();
  const app = createServer();

  await new Promise<void>((resolve) => { app.listen(port, host, () => resolve()); });

  const browserUrls = getBrowserUrls();
  logger.info(`Dashboard: http://localhost:${port}`);
  logger.info(`iPhone same WiFi: ${browserUrls.lan}`);
  if (browserUrls.tailscale) logger.info(`iPhone Tailscale: ${browserUrls.tailscale}`);

  // Check browser login
  const loggedIn = await isLoggedIn();
  if (!loggedIn) {
    logger.warn('╔══════════════════════════════════════════════════════════╗');
    logger.warn('║  NOT LOGGED IN TO X                                      ║');
    logger.warn('║                                                          ║');
    logger.warn('║  1. Set BROWSER_HEADLESS=false in .env                   ║');
    logger.warn('║  2. Run again — browser window will open                 ║');
    logger.warn('║  3. Log in to x.com manually                             ║');
    logger.warn('║  4. Close browser, set BROWSER_HEADLESS=true, restart    ║');
    logger.warn('╚══════════════════════════════════════════════════════════╝');
  } else {
    logger.info('X session: authenticated ✓');
  }

  // Start scheduler
  startScheduler();
  logger.info('Scheduler started — cron:', getIngestCron());

  const telemetry = getTelemetryStatus();
  if (telemetry.enabled) {
    logger.info('OpenTelemetry enabled', {
      endpoint: telemetry.endpoint,
      service: telemetry.serviceName,
      started: telemetry.started,
    });
  }

  logger.info('=== Xposter ready ===');

  // Graceful shutdown
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function shutdown(): Promise<void> {
  logger.info('Shutting down...');
  stopScheduler();
  const { closeBrowser } = await import('./browser/session.js');
  await closeBrowser();
  await shutdownTelemetry();
  process.exit(0);
}

main().catch((err) => {
  logger.error('Fatal startup error', { err });
  process.exit(1);
});
