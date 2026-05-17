import { EmptyReplyError } from './errors.js';

export function cleanModelText(raw: string): string {
  return raw.replace(/^["']|["']$/g, '').trim();
}

export function charLength(text: string): number {
  return Array.from(text).length;
}

export function assertEnglishOnly(text: string, context: string): void {
  if (!text.trim()) throw new EmptyReplyError(`${context} returned empty reply`);
  if (/[ऀ-ॿ]/.test(text)) {
    throw new Error(`${context} violated English-only policy: Devanagari script detected`);
  }
}

export function enforceCharacterLimit(text: string, maxChars: number): string {
  const trimmed = text.trim();
  const chars = Array.from(trimmed);
  if (chars.length <= maxChars) return trimmed;

  const clipped = chars.slice(0, maxChars).join('');
  const lastSpace = clipped.lastIndexOf(' ');
  const safeClip = lastSpace > 80 ? clipped.slice(0, lastSpace) : clipped;

  return safeClip.replace(/[,.!?;:।-]+$/g, '').trim();
}
