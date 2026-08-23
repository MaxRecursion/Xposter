import { describe, expect, it } from 'vitest';
import {
  SETTINGS_SCHEMA,
  buildWritableSettingNormalizers,
  getSettingDefault,
  normalizeSettingValue,
  settingsSeedTuples,
} from '../../src/storage/settings_schema.js';

describe('settings_schema', () => {
  it('has unique keys', () => {
    const keys = SETTINGS_SCHEMA.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('returns schema defaults', () => {
    expect(getSettingDefault('min_score')).toBe('60');
    expect(getSettingDefault('unknown_key', 'fallback')).toBe('fallback');
  });

  it('normalizes writable settings with bounds', () => {
    expect(normalizeSettingValue('min_score', '999')).toBe('100');
    expect(normalizeSettingValue('min_score', '-5')).toBe('0');
    expect(normalizeSettingValue('system_running', true)).toBe('true');
    expect(normalizeSettingValue('system_running', 'false')).toBe('false');
    expect(normalizeSettingValue('image_monthly_budget_usd', '99')).toBe('99');
  });

  it('rejects unknown or non-writable keys', () => {
    expect(normalizeSettingValue('unknown_key', 'x')).toBeNull();
  });

  it('builds normalizers for all writable keys', () => {
    const normalizers = buildWritableSettingNormalizers();
    for (const spec of SETTINGS_SCHEMA) {
      if (spec.writable === false) continue;
      expect(normalizers[spec.key]).toBeTypeOf('function');
      const normalized = normalizers[spec.key](spec.default);
      if (spec.type === 'float') {
        expect(Number(normalized)).toBe(Number(spec.default));
      } else {
        expect(normalized).toBe(spec.default);
      }
    }
  });

  it('seeds one tuple per schema entry', () => {
    const tuples = settingsSeedTuples();
    expect(tuples).toHaveLength(SETTINGS_SCHEMA.length);
    expect(tuples.find(([key]) => key === 'approval_timeout_min')).toEqual(['approval_timeout_min', '30']);
  });
});
