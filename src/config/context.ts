import { parseBool, parseIntValue } from './parse.js';

export function isContextEnabled(): boolean {
  return parseBool(process.env.CONTEXT_ENABLED, false);
}

export function getVoyageApiKey(): string | null {
  return process.env.VOYAGE_API_KEY?.trim() || null;
}

export function getVoyageDim(): number {
  return parseIntValue(process.env.VOYAGE_DIM, 512, 1);
}

export function getVoyageRpm(): number {
  const rpm = parseFloat(process.env.VOYAGE_RPM ?? '');
  return Number.isFinite(rpm) && rpm > 0 ? rpm : 2.7;
}

export function getContextIngestIntervalMin(): number | null {
  const value = parseInt(process.env.CONTEXT_INGEST_INTERVAL_MIN ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function isTrendsEnabled(): boolean {
  return process.env.X_TRENDS_ENABLED?.trim().toLowerCase() !== 'false';
}
