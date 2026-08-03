import path from 'path';
import { parseBool } from './parse.js';

export function getBrowserUserDataDir(): string {
  return path.resolve(process.cwd(), process.env.BROWSER_USER_DATA_DIR ?? './browser-profile');
}

export function isBrowserHeadless(): boolean {
  return parseBool(process.env.BROWSER_HEADLESS, true);
}
