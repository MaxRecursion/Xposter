import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
// Load .env from repo root regardless of working directory (fixes worktree starts).
// tsconfig targets CommonJS, so __dirname is provided by the runtime — using
// import.meta.url here would break `tsc` with TS1343.
dotenvConfig({ path: resolve(__dirname, '../.env') });
import { createServer } from './api/server.js';
import { getDb } from './storage/db.js';
import { startScheduler } from './scheduler/cron.js';
import { isLoggedIn } from './browser/session.js';
import { logger } from './utils/logger.js';
import { getBindHost, getBrowserUrls, getPort } from './utils/network.js';

async function main(): Promise<void> {
  logger.info('=== Xposter starting ===');

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
  logger.info('Scheduler started — cron:', process.env.INGEST_CRON ?? '*/15 * * * *');

  logger.info('=== Xposter ready ===');

  // Graceful shutdown
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function shutdown(): Promise<void> {
  logger.info('Shutting down...');
  const { closeBrowser } = await import('./browser/session.js');
  await closeBrowser();
  process.exit(0);
}

main().catch((err) => {
  logger.error('Fatal startup error', { err });
  process.exit(1);
});
