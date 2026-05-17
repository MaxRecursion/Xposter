import crypto from 'crypto';

/**
 * Error signatures for activity_log dedup.
 *
 * Two activity-log rows with the same root cause (e.g. "browser timed out
 * connecting to x.com") should hash to the same signature, even when their
 * `detail` field differs in volatile bits like UUIDs, timestamps, line
 * numbers, or absolute path prefixes.
 *
 * Implementation: aggressive normalization, then sha256 of `${event}::${normDetail}`,
 * truncated to 16 hex chars. The output is a stable, short bucket key.
 */

/** Normalize a `detail` string by stripping common volatile bits. */
export function normalizeDetail(detail: string | null | undefined): string {
  if (!detail) return '';
  let s = detail;

  // Absolute paths under user home / common repo roots → strip prefix
  s = s.replace(/\/(?:Users|home|var|tmp|private)\/[^\s)]+\//gi, '<PATH>/');

  // UUIDs (v4 and generic 8-4-4-4-12 hex)
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>');

  // ISO timestamps + unix timestamps (10–13 digit numerics)
  s = s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<TS>');
  s = s.replace(/\b\d{10,13}\b/g, '<N>');

  // Tweet IDs (15-20 digits) - already covered by <N> above; explicit for clarity if needed
  // (intentionally left to <N> tag)

  // Port numbers in URLs
  s = s.replace(/:\d{2,5}(?=\/)/g, ':<PORT>');

  // Hex hashes (≥10 chars)
  s = s.replace(/\b[0-9a-f]{10,}\b/gi, '<HEX>');

  // Line:column refs in stack traces: foo.ts:42:10
  s = s.replace(/(\.[a-z]{2,5}):\d+:\d+/gi, '$1:<L>:<C>');
  s = s.replace(/(\.[a-z]{2,5}):\d+\)/gi, '$1:<L>)');

  // Quoted strings can vary wildly (user content, error messages) — keep first 60 chars
  s = s.replace(/"((?:[^"\\]|\\.){61,})"/g, (_m, content) => `"${(content as string).slice(0, 60)}…"`);

  // Long whitespace runs
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

export function errorSignature(event: string, detail: string | null | undefined): string {
  const normalized = `${event}::${normalizeDetail(detail)}`;
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}
