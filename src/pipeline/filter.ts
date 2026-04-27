import { franc } from 'franc';
import { Post, RawTweet } from '../storage/queries.js';

// ── Language Detection ────────────────────────────────────────────────────────

/**
 * Languages we recognise:
 *   - marathi:       Devanagari-script Marathi
 *   - marathi-roman: Marathi written in Latin/Roman script ("majhya punyat aaj khup paus aahe")
 *   - hindi:         Devanagari Hindi (skipped)
 *   - english:       Pure English
 *   - unknown:       Anything else / too short
 */
export type DetectedLanguage = 'marathi' | 'marathi-roman' | 'hindi' | 'english' | 'unknown';

// Marathi-specific Devanagari words that help distinguish from Hindi
const MARATHI_MARKERS = [
  'आहे', 'आहेत', 'नाही', 'होता', 'होती', 'केला', 'केली', 'केलं', 'आलो', 'गेलो',
  'पुणे', 'मुंबई', 'महाराष्ट्र', 'मराठी', 'असं', 'तसं', 'म्हणजे', 'बघा', 'बघ',
  'पाऊस', 'रस्ता', 'वाहतूक', 'कसं', 'करतो', 'येतो', 'जातो', 'सांगा',
  'काय', 'कुठे', 'कधी', 'कोण', 'कशी', 'कसा', 'अरे', 'बाबा', 'दादा',
  'पुण्यात', 'मुंबईत', 'पाहिलं', 'झालं', 'झाला', 'झाली', 'व्हा', 'व्हायला',
];

// Hindi-specific markers (to reduce false Marathi hits)
const HINDI_MARKERS = [
  'है', 'हैं', 'था', 'थी', 'होगा', 'करना', 'जाना', 'आना', 'नहीं',
  'बहुत', 'अच्छा', 'ठीक', 'यहाँ', 'वहाँ', 'मेरा', 'तुम्हारा',
];

/**
 * Roman-script Marathi tokens. These are common, distinctive Marathi words that
 * appear when Marathi speakers type in Latin script. They are chosen to NOT
 * collide with regular English words.
 *
 * Detection rule: if franc thinks a Latin-script tweet is "english" but we see
 * 2+ of these tokens, it's almost certainly transliterated Marathi.
 */
const ROMAN_MARATHI_MARKERS = [
  // verb endings
  /\b(ahe|ahet|hota|hoti|hote|zala|zali|zale|jhala|jhali)\b/i,
  /\b(karto|karte|karat|kartoy|kartiy|karaycha)\b/i,
  /\b(jato|jate|jaycha|gele|geli|aalo|aali|aalay)\b/i,
  // pronouns
  /\b(majha|majhi|majhya|tujha|tujhi|tyacha|tyachi|aamhi|tumhi|aaplya|aaplyala)\b/i,
  /\b(mala|tula|tyala|tila|aamhala|tumhala)\b/i,
  // common adverbs/connectors
  /\b(khup|thoda|thodi|thodke|kharach|nakki|barobar|chukla|chukli)\b/i,
  /\b(mhanaje|mhanun|mhanje|tar|pan|ani|kinva|nahitar)\b/i,
  // negation / question words
  /\b(nahi|nai|naai|nako|naka|nakos|kashala|kashasathi|ka\?)/i,
  /\b(kasa|kashi|kase|kuthe|kadhi|kuthun|kahi|kay)\b/i,
  // place / context (very Marathi)
  /\b(punyat|mumbait|punyala|mumbaila|maharastrat|maharashtrat)\b/i,
  // weather / civic vocabulary
  /\b(paus|pavasala|pavsat|pani|tumbla|tumblay|rasta|vahatuk)\b/i,
  // exclamations
  /\b(arre|ho na|hoy ka|baghu ya|baghaycha|chala|chal)\b/i,
];

const HINDI_ROMAN_MARKERS = [
  /\b(hai|hain|tha|thi|the|hoga|hogi|honge)\b/i,
  /\b(mera|tera|uska|hamara|tumhara|unka)\b/i,
  /\b(kya|kahan|kab|kaun|kaise|kyun)\b/i,
  /\b(nahi|nahin|haan|theek|bahut|accha|kuch)\b/i,
];

export interface LanguageDetail {
  language: DetectedLanguage;
  confidence: number;
  signal: string;
}

export function detectLanguage(text: string): DetectedLanguage {
  return detectLanguageDetail(text).language;
}

export function detectLanguageDetail(text: string): LanguageDetail {
  if (!text || text.trim().length < 5) {
    return { language: 'unknown', confidence: 0, signal: 'too-short' };
  }

  // 1. Devanagari path
  if (/[ऀ-ॿ]/.test(text)) {
    const marathiHits = MARATHI_MARKERS.filter((w) => text.includes(w)).length;
    const hindiHits = HINDI_MARKERS.filter((w) => text.includes(w)).length;

    if (marathiHits > 0 && marathiHits >= hindiHits) {
      return { language: 'marathi', confidence: 0.9, signal: `marathi-markers=${marathiHits}` };
    }
    if (hindiHits > marathiHits) {
      return { language: 'hindi', confidence: 0.85, signal: `hindi-markers=${hindiHits}` };
    }
    const guess = franc(text, { minLength: 10, only: ['mar', 'hin'] });
    if (guess === 'hin') return { language: 'hindi', confidence: 0.7, signal: 'franc=hin' };
    // Default to marathi for Devanagari (we're a Marathi-first app)
    return { language: 'marathi', confidence: 0.6, signal: 'devanagari-fallback' };
  }

  // 2. Latin-script path: distinguish English / Marathi-Roman / Hindi-Roman
  const marathiRomanHits = ROMAN_MARATHI_MARKERS.filter((re) => re.test(text)).length;
  const hindiRomanHits = HINDI_ROMAN_MARKERS.filter((re) => re.test(text)).length;

  if (marathiRomanHits >= 2 && marathiRomanHits >= hindiRomanHits) {
    return {
      language: 'marathi-roman',
      confidence: Math.min(0.6 + marathiRomanHits * 0.05, 0.95),
      signal: `roman-marathi-hits=${marathiRomanHits}`,
    };
  }
  if (hindiRomanHits >= 2 && hindiRomanHits > marathiRomanHits) {
    return {
      language: 'hindi',
      confidence: 0.7,
      signal: `roman-hindi-hits=${hindiRomanHits}`,
    };
  }

  // 3. Pure Latin-script: trust franc
  const guess = franc(text, { minLength: 10, only: ['eng', 'mar', 'hin'] });
  if (guess === 'eng') return { language: 'english', confidence: 0.8, signal: 'franc=eng' };
  if (guess === 'mar') return { language: 'marathi-roman', confidence: 0.55, signal: 'franc=mar-on-latin' };
  if (guess === 'hin') return { language: 'hindi', confidence: 0.6, signal: 'franc=hin-on-latin' };

  // 4. Last resort: if mostly ASCII + has 1 marathi-roman marker, lean toward marathi-roman
  if (marathiRomanHits === 1) {
    return { language: 'marathi-roman', confidence: 0.45, signal: 'roman-marathi-hits=1' };
  }

  return { language: 'unknown', confidence: 0, signal: 'no-strong-signal' };
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

  // Language gate: we accept marathi (Devanagari + Roman) and english only.
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

  // Marathi (any script) is the PRIMARY target language: pass regardless of
  // explicit topic keywords — we want to reply to Marathi speakers broadly.
  if (language === 'marathi' || language === 'marathi-roman') {
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
