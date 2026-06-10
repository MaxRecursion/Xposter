const regexCache = new Map<string, RegExp>();

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Prefix word-boundary keyword match: the keyword must start at a word
 * boundary, so 'rain' matches "rain"/"raining"/"rainfall" but not
 * "train"/"brain"/"drain". Devanagari (and other non-ASCII) keywords fall back
 * to substring matching because JS \b only anchors on ASCII word characters.
 */
export function keywordMatches(text: string, keyword: string): boolean {
  const kw = keyword.trim();
  if (!kw) return false;
  if (!/^[\x20-\x7F]+$/.test(kw)) return text.includes(kw);

  let re = regexCache.get(kw);
  if (!re) {
    re = new RegExp(`\\b${escapeRegExp(kw)}`, 'i');
    regexCache.set(kw, re);
  }
  return re.test(text);
}
