import { describe, expect, it } from 'vitest';
import * as config from '../../src/config.js';

describe('config module', () => {
  it('returns default port and host', () => {
    expect(config.getPort()).toBe('3000');
    expect(config.getHost()).toBe('0.0.0.0');
  });

  it('parses boolean env values correctly', () => {
    process.env.BROWSER_HEADLESS = 'false';
    expect(config.isBrowserHeadless()).toBe(false);
    process.env.BROWSER_HEADLESS = 'true';
    expect(config.isBrowserHeadless()).toBe(true);
    delete process.env.BROWSER_HEADLESS;
  });

  it('returns null when X auth cookies are not configured', () => {
    delete process.env.X_AUTH_TOKEN;
    delete process.env.X_CT0;
    expect(config.getXAuthToken()).toBeNull();
    expect(config.getXCt0()).toBeNull();
  });
});
