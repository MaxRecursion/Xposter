import { franc } from 'franc';
import { Post, RawTweet } from '../storage/queries.js';

// ── Language Detection ────────────────────────────────────────────────────────

export type DetectedLanguage = 'marathi' | 'hindi' | 'english' | 'unknown';

// Marathi-specific words that help distinguish from Hindi
const MARATHI_MARKERS = [
  'आहे', 'आहेत', 'नाही', 'होता', 'होती', 'केला', 'केली', 'केलं', 'आलो', 'गेलो',
  'पुणे', 'मुंबई', 'महाराष्ट्र', 'मराठी', 'असं', 'तसं', 'म्हणजे', 'बघा', 'बघ',
  'पाऊस', 'रस्ता', 'वाहतूक', 'कसं', 'करतो', 'येतो', 'जातो', 'सांगा',
];

// Hindi-specific markers (to reduce false Marathi hits)
const HINDI_MARKERS = [
  'है', 'हैं', 'था', 'थी', 'होगा', 'करना', 'जाना', 'आना', 'नहीं',
  'बहुत', 'अच्छा', 'ठीक', 'यहाँ', 'वहाँ',
];

export function detectLanguage(text: string): DetectedLanguage {
  if (!text || text.trim().length < 5) return 'unknown';

  // Check for explicit Marathi markers first (high precision)
  const marathiHits = MARATHI_MARKERS.filter((w) => text.includes(w)).length;
  const hindiHits = HINDI_MARKERS.filter((w) => text.includes(w)).length;

  if (marathiHits > 0 && marathiHits >= hindiHits) return 'marathi';

  // Fall back to franc for statistical detection
  // Allowlist to speed up and avoid wrong Latin-script guesses
  const guess = franc(text, { minLength: 10, only: ['mar', 'hin', 'eng'] });

  if (guess === 'mar') return 'marathi';
  if (guess === 'hin') return 'hindi';
  if (guess === 'eng') return 'english';

  // Last resort: if Devanagari present and no clear guess, lean marathi for Pune context
  if (/[ऀ-ॿ]/.test(text)) return 'marathi';

  return 'unknown';
}

// ── Topic Keyword Filtering ───────────────────────────────────────────────────

const MARATHI_KEYWORDS: string[] = [
  // Pune
  'पुणे', 'पुण्यात', 'पुण्याच्या',
  // Rain
  'पाऊस', 'पावसाळा', 'पूर', 'पाणी तुंबलं', 'जलमय',
  // Traffic
  'वाहतूक', 'रस्ता', 'जाम', 'अपघात',
  // Events
  'गणेशोत्सव', 'दिवाळी', 'नवरात्र',
];

const DEFAULT_ENGLISH_KEYWORDS = [
  'pune', 'rain', 'traffic', 'flood', 'waterlog', 'pothole',
  'koregaon', 'kothrud', 'hinjewadi', 'baner', 'wakad',
  'local event', 'pmc', 'pune metro',
];

export interface FilterResult {
  pass: boolean;
  language: DetectedLanguage;
  matchedKeywords: string[];
  reason?: string;
}

export function filterPost(
  text: string,
  extraKeywords: string[] = [],
): FilterResult {
  const language = detectLanguage(text);
  const lower = text.toLowerCase();

  // Language gate: we only process marathi or english (skip hindi, unknown, etc.)
  if (language === 'unknown' || language === 'hindi') {
    return { pass: false, language, matchedKeywords: [], reason: `unsupported language: ${language}` };
  }

  const keywords = [
    ...MARATHI_KEYWORDS,
    ...DEFAULT_ENGLISH_KEYWORDS,
    ...extraKeywords.map((k) => k.toLowerCase()),
  ];

  const matchedKeywords = keywords.filter(
    (kw) => lower.includes(kw.toLowerCase()) || text.includes(kw),
  );

  // Marathi is the PRIMARY target language: any Marathi post passes regardless
  // of explicit topic keywords — we want to reply to Marathi speakers broadly.
  if (language === 'marathi') {
    return { pass: true, language, matchedKeywords };
  }

  // English posts must have at least one topic keyword match (secondary fallback)
  if (matchedKeywords.length === 0) {
    return { pass: false, language, matchedKeywords: [], reason: 'no topic match' };
  }

  return { pass: true, language, matchedKeywords };
}

// ── Deduplication ─────────────────────────────────────────────────────────────

export function isDuplicate(text: string, existingTexts: string[]): boolean {
  const normalized = normalizeText(text);
  return existingTexts.some((t) => {
    const sim = jaccardSimilarity(normalized, normalizeText(t));
    return sim > 0.8;
  });
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').replace(/[^\w\sऀ-ॿ]/g, '').trim();
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.split(' '));
  const setB = new Set(b.split(' '));
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}
