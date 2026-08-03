import { parseBool, parseIntValue } from './parse.js';

export function getPort(): string {
  return process.env.PORT ?? '3000';
}

export function getHost(): string {
  return process.env.HOST ?? '0.0.0.0';
}

export function getApiKey(): string | null {
  return process.env.API_KEY?.trim() || null;
}

export function isApiKeySet(): boolean {
  const apiKey = getApiKey();
  return Boolean(apiKey) && apiKey !== 'change_me_generate_with_openssl_rand_hex_32';
}

export function getLogLevel(): string {
  return process.env.LOG_LEVEL?.trim() || 'info';
}

export function getDbPathOverride(): string | null {
  const value = process.env.DB_PATH_OVERRIDE?.trim();
  return value && value !== '' ? value : null;
}

export function getEnvVar(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined ? undefined : value.trim();
}

export function getTrustDashboardOrigin(): boolean {
  return parseBool(process.env.TRUST_DASHBOARD_ORIGIN, true);
}

export function getNodeEnv(): string {
  return process.env.NODE_ENV?.trim() || 'development';
}

export function getActionTokenTTLSeconds(): number {
  return parseIntValue(process.env.ACTION_TOKEN_TTL_SECONDS, 86400, 1);
}
