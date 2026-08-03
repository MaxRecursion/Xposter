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

const SENTENCE_PATTERN = /[^.!?]+[.!?]+|[^.!?]+$/g;

/**
 * Trims a single post into a character budget, dropping whole sentences before
 * resorting to a mid-sentence clip.
 *
 * The first sentence carries the hook and the last carries the question that
 * earns the replies, so the middle gives way first — a plain tail-clip removes
 * exactly the part of an engagement post that does the work. Sentences are
 * dropped from the end of the middle rather than cherry-picked, so what
 * survives still reads continuously.
 *
 * Returns null when nothing above `minChars` survives.
 */
export function fitToCharBudget(text: string, maxChars: number, minChars = 0): string | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  if (charLength(normalized) <= maxChars) {
    return charLength(normalized) >= minChars ? normalized : null;
  }

  const sentences = normalized.match(SENTENCE_PATTERN)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) ?? [];

  if (sentences.length > 1) {
    const first = sentences[0]!;
    const last = sentences.at(-1)!;
    const middle = sentences.slice(1, -1);

    if (charLength(`${first} ${last}`) <= maxChars) {
      const kept = [first];
      let used = charLength(first) + 1 + charLength(last);
      for (const sentence of middle) {
        const cost = charLength(sentence) + 1;
        if (used + cost > maxChars) break;
        kept.push(sentence);
        used += cost;
      }
      kept.push(last);
      const joined = kept.join(' ');
      if (charLength(joined) >= minChars) return joined;
    }

    // Hook and question cannot coexist — keep the question, which is the ask.
    for (const candidate of [last, first]) {
      const len = charLength(candidate);
      if (len <= maxChars && len >= minChars) return candidate;
    }
  }

  const clipped = clipWithTerminalPunctuation(normalized, maxChars);
  return clipped && charLength(clipped) >= minChars ? clipped : null;
}

/** Clips at a word boundary, leaving room for the full stop it appends. */
function clipWithTerminalPunctuation(text: string, maxChars: number): string | null {
  const clipped = enforceCharacterLimit(text, Math.max(1, maxChars - 1));
  if (!clipped) return null;
  return /[.!?]$/.test(clipped) ? clipped : `${clipped}.`;
}
