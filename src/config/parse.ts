export function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.trim().toLowerCase() === 'true';
}

export function parseIntValue(value: string | undefined, fallback: number, min = Number.MIN_SAFE_INTEGER): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < min) return fallback;
  return parsed;
}
