import { BrowserContext } from 'playwright';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import { logger } from '../utils/logger.js';
import { getBrowserUserDataDir, isBrowserHeadless, getXAuthToken, getXCt0 } from '../config.js';

// Stealth plugin masks the automation fingerprints X uses to flag the bot
// (navigator.webdriver, chrome.runtime quirks, plugin/permission shape, etc).
chromium.use(StealthPlugin());

const USER_DATA_DIR = getBrowserUserDataDir();

let _context: BrowserContext | null = null;

export async function getBrowserContext(): Promise<BrowserContext> {
  if (_context) return _context;

  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  const headless = isBrowserHeadless();

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

  await injectAuthCookiesFromEnv(_context);

  // tsx/esbuild injects __name(fn, "name") calls into compiled code to
  // preserve function .name in dev mode. When Playwright serialises a
  // page.evaluate() callback via Function.toString(), those __name() calls
  // are included but the __name helper itself (defined at module scope) is
  // not — causing "ReferenceError: __name is not defined" in the browser.
  // Defining it as a harmless polyfill here fixes every evaluate() call
  // across the whole codebase without touching individual files.
  await _context.addInitScript(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__name = (fn: unknown, _name?: string) => fn;
  });

  logger.info('Browser context ready');
  return _context;
}

/**
 * X aggressively flags Playwright-driven login flows — the username form
 * silently refuses to advance to the password step. Workaround: skip the
 * login flow entirely. The user logs in once in their normal Chrome, copies
 * the auth_token + ct0 cookies out of DevTools, and pastes them into .env.
 * We inject those cookies into the persistent context so the browser starts
 * already authenticated. No login form ever sees a CDP-controlled browser.
 *
 * Cookies typically last ~1 year; refresh from .env when isLoggedIn() flips
 * back to false.
 */
async function injectAuthCookiesFromEnv(ctx: BrowserContext): Promise<void> {
  const authToken = getXAuthToken();
  if (!authToken) return;

  const existing = await ctx.cookies('https://x.com');
  if (existing.some((c) => c.name === 'auth_token' && c.value === authToken)) {
    return; // cookies already present and matching
  }

  const ct0 = getXCt0();
  const cookies = [
    {
      name: 'auth_token',
      value: authToken,
      domain: '.x.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax' as const,
    },
    ...(ct0 ? [{
      name: 'ct0',
      value: ct0,
      domain: '.x.com',
      path: '/',
      httpOnly: false,
      secure: true,
      sameSite: 'Lax' as const,
    }] : []),
  ];
  await ctx.addCookies(cookies);
  logger.info('Injected X auth cookies from env', { ct0: Boolean(ct0) });
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
