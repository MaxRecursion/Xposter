import { getDb } from './db.js';
import { clampInt, clampNumber } from '../utils/number.js';

export function getSetting(key: string, fallback: string): string {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)')
    .run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const rows = getDb()
    .prepare('SELECT key, value FROM settings')
    .all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function getBooleanSetting(key: string, fallback: boolean): boolean {
  const value = getSetting(key, String(fallback)).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  return fallback;
}

export function getIntSetting(key: string, fallback: number, min: number, max: number): number {
  return clampInt(getSetting(key, String(fallback)), fallback, min, max);
}

export function getFloatSetting(key: string, fallback: number, min: number, max: number): number {
  return clampNumber(getSetting(key, String(fallback)), fallback, min, max);
}

export function getListSetting(key: string, fallback: string[] = []): string[] {
  const raw = getSetting(key, fallback.join(','));
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

export function getJsonSetting<T>(key: string, fallback: T): T {
  const raw = getSetting(key, '');
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
