import { BrowserContext } from 'playwright';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger.js';

// Stealth plugin masks the automation fingerprints X uses to flag the bot
// (navigator.webdriver, chrome.runtime quirks, plugin/permission shape, etc).
chromium.use(StealthPlugin());

const USER_DATA_DIR = path.resolve(
  process.cwd(),
  process.env.BROWSER_USER_DATA_DIR ?? './browser-profile',
);

let _context: BrowserContext | null = null;

export async function getBrowserContext(): Promise<BrowserContext> {
  if (_context) return _context;

  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  const headless = (process.env.BROWSER_HEADLESS ?? 'true') === 'true';

  logger.info('Launching browser', { userDataDir: USER_DATA_DIR, headless });

  _context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome', // use user's installed Google Chrome instead of the (detected-as-automation) Chrome for Testing build
    headless,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'Asia/Kolkata',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  logger.info('Browser context ready');
  return _context;
}

export async function closeBrowser(): Promise<void> {
  if (_context) {
    try {
      await _context.close();
    } catch {
      // ignore — already closed or process tearing down
    }
    _context = null;
    logger.info('Browser context closed');
  }
}

/** Returns true if the browser profile appears to have an X session. */
export async function isLoggedIn(): Promise<boolean> {
  const ctx = await getBrowserContext();
  const cookies = await ctx.cookies('https://x.com');
  return cookies.some((c) => c.name === 'auth_token');
}
