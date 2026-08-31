import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';
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

/** launchd's StandardOutPath capture — plain append, no rotation of its own. */
const LAUNCHD_LOG = path.join(LOG_DIR, 'launchd.log');
const LAUNCHD_LOG_MAX_BYTES = 32 * 1024 * 1024;
const LAUNCHD_LOG_KEEP_BYTES = 2 * 1024 * 1024;

/**
 * Keeps launchd's capture file from growing without bound.
 *
 * The winston transport above rotates the app log, but launchd's
 * StandardOutPath/StandardErrorPath is a raw append that nothing prunes — it
 * had reached tens of MB. launchd holds the file open, so the file is
 * truncated in place (keeping the newest tail, which is what a crash
 * postmortem actually needs) rather than renamed, which would leave launchd
 * writing to an unlinked inode.
 */
export function trimLaunchdLog(): void {
  try {
    const stat = fs.statSync(LAUNCHD_LOG);
    if (stat.size <= LAUNCHD_LOG_MAX_BYTES) return;

    const fd = fs.openSync(LAUNCHD_LOG, 'r');
    const keep = Buffer.alloc(LAUNCHD_LOG_KEEP_BYTES);
    const read = fs.readSync(fd, keep, 0, LAUNCHD_LOG_KEEP_BYTES, stat.size - LAUNCHD_LOG_KEEP_BYTES);
    fs.closeSync(fd);

    // Drop the partial first line so the tail starts on a record boundary.
    const tail = keep.subarray(0, read);
    const firstNewline = tail.indexOf(0x0a);
    const body = firstNewline >= 0 ? tail.subarray(firstNewline + 1) : tail;

    fs.writeFileSync(LAUNCHD_LOG, body);
    logger.info('Trimmed launchd.log', {
      wasMB: Math.round(stat.size / 1024 / 1024),
      nowMB: Math.round(body.length / 1024 / 1024),
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;  // not run under launchd
    logger.warn('Could not trim launchd.log', { err: String(err) });
  }
}
