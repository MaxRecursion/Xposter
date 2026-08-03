import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import { trace } from '@opentelemetry/api';
import { OpenTelemetryTransportV3 } from '@opentelemetry/winston-transport';
import { getLogLevel, isOtelEnabled } from '../config.js';

const LOG_DIR = path.resolve(process.cwd(), 'logs');

function serializeErrors(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => serializeErrors(item, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, serializeErrors(item, seen)]),
  );
}

const fmt = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const span = trace.getActiveSpan();
    const ctx = span?.spanContext();
    const traceMeta = ctx?.traceId
      ? { trace_id: ctx.traceId, span_id: ctx.spanId }
      : {};
    const merged = { ...traceMeta, ...meta };
    const metaStr = Object.keys(merged).length ? ` ${JSON.stringify(serializeErrors(merged))}` : '';
    return `[${timestamp}] ${level.toUpperCase().padEnd(5)} ${message}${metaStr}`;
  }),
);

export const logger = winston.createLogger({
  level: getLogLevel(),
  format: fmt,
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), fmt),
    }),
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'xposter-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',
      zippedArchive: true,
    }),
    ...(isOtelEnabled() ? [new OpenTelemetryTransportV3()] : []),
  ],
});
