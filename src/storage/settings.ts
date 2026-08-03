import { getDb } from './db.js';
import { clampInt, clampNumber } from '../utils/number.js';
import { getSettingDefault, getSettingSpec } from './settings_schema.js';

export function getSetting(key: string, fallback: string): string {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? getSettingDefault(key, fallback);
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

/** Read an int setting using bounds/default from SETTINGS_SCHEMA. */
export function getIntSettingFromSchema(key: string): number {
  const spec = getSettingSpec(key);
  if (!spec || spec.type !== 'int') {
    return getIntSetting(key, Number(fallbackFor(key)), 0, Number.MAX_SAFE_INTEGER);
  }
  return getIntSetting(key, Number(spec.default), spec.min ?? 0, spec.max ?? Number.MAX_SAFE_INTEGER);
}

export function getBooleanSettingFromSchema(key: string): boolean {
  const spec = getSettingSpec(key);
  const fallback = spec?.type === 'bool' ? spec.default === 'true' : false;
  return getBooleanSetting(key, fallback);
}

export function getFloatSettingFromSchema(key: string): number {
  const spec = getSettingSpec(key);
  if (!spec || spec.type !== 'float') {
    return getFloatSetting(key, 0, 0, Number.MAX_SAFE_INTEGER);
  }
  return getFloatSetting(key, Number(spec.default), spec.min ?? 0, spec.max ?? Number.MAX_SAFE_INTEGER);
}

function fallbackFor(key: string): string {
  return getSettingDefault(key, '0');
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
