import { parseBool, parseIntValue } from './parse.js';

export function isOtelEnabled(): boolean {
  if (process.env.NODE_ENV?.trim() === 'test') return false;
  return parseBool(process.env.OTEL_ENABLED, false);
}

export function getOtelServiceName(): string {
  return process.env.OTEL_SERVICE_NAME?.trim() || 'xposter';
}

export function getOtelExporterEndpoint(): string | null {
  const value = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return value || null;
}

export function getOtelTracesSamplerArg(): number {
  const parsed = Number.parseFloat(process.env.OTEL_TRACES_SAMPLER_ARG ?? '1.0');
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 1.0;
}

export function shouldLogPrompts(): boolean {
  if (process.env.LOG_PROMPTS?.trim().toLowerCase() === 'false') return false;
  if (process.env.NODE_ENV?.trim() === 'test' && process.env.LOG_PROMPTS?.trim().toLowerCase() !== 'true') return false;
  return true;
}

export function getIngestCron(): string {
  return process.env.INGEST_CRON ?? '*/15 * * * *';
}

export function getMinReplyIntervalSeconds(): number {
  return parseIntValue(process.env.MIN_REPLY_INTERVAL_SECONDS, 300, 0);
}
