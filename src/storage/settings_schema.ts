import { clampInt, clampNumber } from '../utils/number.js';

export type SettingType = 'int' | 'bool' | 'float' | 'text';

export interface SettingSpec {
  key: string;
  type: SettingType;
  default: string;
  min?: number;
  max?: number;
  maxLen?: number;
  /** Dashboard PATCH /settings/update can mutate this key. */
  writable?: boolean;
}

/** Single source of truth for runtime settings defaults and dashboard validation. */
export const SETTINGS_SCHEMA: SettingSpec[] = [
  { key: 'system_running', type: 'bool', default: 'true', writable: true },
  { key: 'topic_keywords', type: 'text', default: 'Pune,AI,Technology,Consumer Electronics,Rage bait,Geopolitics,Monsoon,Rain,Open source,AI assisted coding,Grok,SpaceX,Elon Musk,Electric Vehicles', maxLen: 500, writable: true },
  { key: 'min_score', type: 'int', default: '40', min: 0, max: 100, writable: true },
  { key: 'max_candidates_per_run', type: 'int', default: '5', min: 1, max: 20, writable: true },
  { key: 'require_approval', type: 'bool', default: 'false', writable: true },
  { key: 'approval_timeout_min', type: 'int', default: '30', min: 5, max: 1440, writable: true },
  { key: 'wit_level', type: 'int', default: '55', min: 0, max: 100, writable: true },
  { key: 'random_runs_per_day', type: 'int', default: '20', min: 1, max: 30, writable: true },
  { key: 'active_window_start_hour', type: 'int', default: '9', min: 0, max: 23, writable: true },
  { key: 'active_window_end_hour', type: 'int', default: '22', min: 1, max: 24, writable: true },
  { key: 'max_follow_backs_per_day', type: 'int', default: '15', min: 0, max: 100, writable: true },
  { key: 'classification_ttl_days', type: 'int', default: '7', min: 1, max: 90, writable: true },
  { key: 'marathi_priority_boost', type: 'int', default: '15', min: 0, max: 100, writable: true },
  { key: 'blocklist_classifications', type: 'text', default: 'BOT,SPAM,BRAND_PROMO', maxLen: 200, writable: true },
  { key: 'original_posts_per_day', type: 'int', default: '10', min: 1, max: 15, writable: true },
  { key: 'original_post_marathi_ratio', type: 'int', default: '40', min: 0, max: 100, writable: true },
  { key: 'impression_sync_interval_h', type: 'int', default: '2', min: 1, max: 24, writable: true },
  { key: 'follow_back_window_hours', type: 'int', default: '24', min: 1, max: 168, writable: true },
  { key: 'topic_category_weights', type: 'text', default: '{"pune-tech-economy":0.40,"local-pune":0.20,"tech":0.15,"politics":0.07,"sports":0.08,"culture":0.07,"observation":0.03}', maxLen: 2000, writable: true },
  { key: 'agent_enabled', type: 'bool', default: 'false', writable: true },
  { key: 'agent_last_watched_at', type: 'int', default: '0', min: 0, writable: false },
  { key: 'agent_error_threshold', type: 'int', default: '3', min: 1, max: 50, writable: true },
  { key: 'agentic_generation', type: 'bool', default: 'false', writable: true },
  { key: 'auto_follow_back_enabled', type: 'bool', default: 'false', writable: true },
  { key: 'auto_follow_back_classifications', type: 'text', default: 'REGULAR,SERIOUS', maxLen: 200, writable: true },
  { key: 'auto_follow_back_min_confidence', type: 'int', default: '60', min: 0, max: 100, writable: true },
  { key: 'weekly_digest_enabled', type: 'bool', default: 'true', writable: true },
  { key: 'weekly_digest_hour', type: 'int', default: '9', min: 0, max: 23, writable: true },
  { key: 'weekly_digest_last_sent_week', type: 'text', default: '', maxLen: 16, writable: false },
  { key: 'likes_enabled', type: 'bool', default: 'true', writable: true },
  { key: 'likes_per_day', type: 'int', default: '100', min: 0, max: 500, writable: true },
  { key: 'topic_daily_cap', type: 'int', default: '10', min: 1, max: 100, writable: true },
  { key: 'image_posts_enabled', type: 'bool', default: 'false', writable: true },
  { key: 'image_posts_per_day', type: 'int', default: '1', min: 0, max: 4, writable: true },
  { key: 'image_evening_start_hour', type: 'int', default: '18', min: 0, max: 23, writable: true },
  { key: 'image_evening_end_hour', type: 'int', default: '22', min: 1, max: 24, writable: true },
  { key: 'image_qa_enabled', type: 'bool', default: 'true', writable: true },
  { key: 'image_qa_max_attempts', type: 'int', default: '3', min: 1, max: 5, writable: true },
  { key: 'image_use_references', type: 'bool', default: 'true', writable: true },
  { key: 'image_monthly_budget_usd', type: 'float', default: '3.0', min: 0, max: 100, writable: true },
  { key: 'image_daily_burst', type: 'float', default: '2.0', min: 1, max: 31, writable: true },
  { key: 'image_identity_json', type: 'text', default: '', maxLen: 1500, writable: true },
  { key: 'image_aspect', type: 'text', default: '4:5', maxLen: 8, writable: true },
  { key: 'trend_replies_enabled', type: 'bool', default: 'true', writable: true },
  { key: 'trend_reply_ratio', type: 'int', default: '70', min: 0, max: 100, writable: true },
  { key: 'trend_global_ratio', type: 'int', default: '50', min: 0, max: 100, writable: true },
  { key: 'contrarian_reply_pct', type: 'int', default: '33', min: 0, max: 100, writable: true },
  { key: 'engagement_bait_pct', type: 'int', default: '15', min: 0, max: 100, writable: true },
  { key: 'bait_style', type: 'text', default: 'implicit', maxLen: 16, writable: true },
  { key: 'bait_candidate_count', type: 'int', default: '2', min: 1, max: 3, writable: true },
  { key: 'human_likeness_gate', type: 'bool', default: 'true', writable: true },
  { key: 'conversation_gravity_min', type: 'int', default: '3', min: 1, max: 5, writable: true },
  { key: 'conversation_gravity_judge', type: 'bool', default: 'true', writable: true },
  { key: 'reply_tournament_enabled', type: 'bool', default: 'true', writable: true },
  { key: 'reply_tournament_rollout_pct', type: 'int', default: '20', min: 0, max: 100, writable: true },
  { key: 'velocity_targeting_enabled', type: 'bool', default: 'true', writable: true },
  { key: 'velocity_strike_window_min', type: 'int', default: '25', min: 5, max: 180, writable: true },
  { key: 'velocity_min_likes_per_min', type: 'float', default: '0.3', min: 0, max: 100, writable: true },
  { key: 'velocity_pool_enabled', type: 'bool', default: 'true', writable: true },
  { key: 'velocity_pool_max_age_min', type: 'int', default: '45', min: 5, max: 360, writable: true },
  { key: 'trend_refresh_minutes', type: 'int', default: '30', min: 10, max: 240, writable: true },
  { key: 'trend_max_replies_per_day', type: 'int', default: '2', min: 1, max: 10, writable: true },
  { key: 'trend_cooldown_hours', type: 'int', default: '12', min: 1, max: 72, writable: true },
  { key: 'trend_min_reply_interval_sec', type: 'int', default: '90', min: 0, max: 600, writable: true },
  { key: 'trend_blocklist', type: 'text', default: '', maxLen: 500, writable: true },
];

const SCHEMA_BY_KEY = new Map(SETTINGS_SCHEMA.map((s) => [s.key, s]));

export function getSettingSpec(key: string): SettingSpec | undefined {
  return SCHEMA_BY_KEY.get(key);
}

export function getSettingDefault(key: string, fallback = ''): string {
  return SCHEMA_BY_KEY.get(key)?.default ?? fallback;
}

function normalizeInt(value: unknown, spec: SettingSpec): string {
  return String(clampInt(value, Number(spec.default), spec.min ?? 0, spec.max ?? Number.MAX_SAFE_INTEGER));
}

function normalizeFloat(value: unknown, spec: SettingSpec): string {
  return String(clampNumber(value, Number(spec.default), spec.min ?? 0, spec.max ?? Number.MAX_SAFE_INTEGER));
}

function normalizeBool(value: unknown): string {
  return String(value === 'true' || value === true);
}

function normalizeText(value: unknown, spec: SettingSpec): string {
  return String(value).slice(0, spec.maxLen ?? 500);
}

export function normalizeSettingValue(key: string, value: unknown): string | null {
  const spec = SCHEMA_BY_KEY.get(key);
  if (!spec || spec.writable === false) return null;
  switch (spec.type) {
    case 'int': return normalizeInt(value, spec);
    case 'float': return normalizeFloat(value, spec);
    case 'bool': return normalizeBool(value);
    case 'text': return normalizeText(value, spec);
    default: return null;
  }
}

export function buildWritableSettingNormalizers(): Record<string, (v: unknown) => string> {
  const out: Record<string, (v: unknown) => string> = {};
  for (const spec of SETTINGS_SCHEMA) {
    if (spec.writable === false) continue;
    out[spec.key] = (value) => normalizeSettingValue(spec.key, value) ?? spec.default;
  }
  return out;
}

export function settingsSeedTuples(): Array<[string, string]> {
  return SETTINGS_SCHEMA.map((spec) => [spec.key, spec.default]);
}
