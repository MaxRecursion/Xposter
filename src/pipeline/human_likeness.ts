/**
 * Heuristic human-likeness scoring and slop detection for tweet generation.
 *
 * Cheap post-generation gate — no extra LLM call. Shared by single-shot Groq,
 * agentic validators, and multi-candidate bait ranking.
 */
import type { EngagementMode } from './engagement_bait.js';
import { getBooleanSettingFromSchema, getIntSettingFromSchema, getSetting } from '../storage/settings.js';

export type BaitStyle = 'implicit' | 'explicit';
export type ContentStructure = 'one_liner' | 'setup_punch' | 'rant_fragment' | 'question_hook' | 'standard';

export const HUMAN_TEXTURE_RULES = `HUMAN TEXTURE (sound like a person, not a copywriter):
- Vary sentence length: one short punch plus one longer clause beats three uniform polished sentences.
- Mild imperfection is fine: contractions, a fragment, one emphasized word — not em-dash spam.
- One vivid concrete image beats three abstract claims.
- Do not sound like a headline, thumbnail, or engagement farm. Mid-conversation beats announcement.`;

/** Phrases distinctive enough to reject mechanically without many false positives. */
export const BANNED_PHRASES = [
  'i totally understand', 'i feel you', 'great point', 'well said', '💯',
  'must be tough', 'hope it gets better', 'stay strong', 'food for thought',
  "in today's world", 'as an ai',
  "it's worth noting", "let's be honest", 'at the end of the day', 'the reality is',
  "here's the thing", 'to be fair', 'i think we can all agree', 'this is a wake-up call',
  'game changer', 'deep dive', 'unpack', 'navigate', 'landscape', 'leverage', 'delve',
];

/** Template openers that scream engagement farm — reject when bait_style is implicit. */
export const BANNED_BAIT_OPENERS = [
  /^the part about\b/i,
  /^nobody (mentions|talks about|says)\b/i,
  /^you won'?t believe\b/i,
  /^wait until\b/i,
  /^this is why .+ keeps failing:/i,
  /^change my mind:/i,
  /^hot take:/i,
  /^unpopular opinion:/i,
  /^let me explain\b/i,
  /^thread:/i,
  /^breaking:/i,
];

export const BANNED_OPENERS = [
  /^hot take:/i,
  /^unpopular opinion:/i,
  /^in today'?s world/i,
  /^just\b/i,
  /^thread:/i,
];

const PUNE_LOCAL_TOKENS = /\b(pune|punekar|puneri|hinjewadi|pmc|fc road|kharadi|baner|wakad|mula|mutha|metro)\b/i;
const CONTRACTION_RE = /\b(i'?m|i'?ve|don'?t|won'?t|can'?t|isn'?t|aren'?t|wasn'?t|weren'?t|it'?s|that'?s|there'?s|we'?re|you'?re|they'?re)\b/gi;
const FIRST_PERSON_RE = /\b(i|my|me)\b/i;
const DIGIT_RE = /\d/;
const NAMED_ENTITY_RE = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/;

export interface HumanLikenessOptions {
  engagementMode?: EngagementMode;
  flavor?: 'pune' | 'general';
  baitStyle?: BaitStyle;
  /** Recent texts to avoid structural clones against. */
  avoidTexts?: string[];
}

export interface HumanLikenessResult {
  ok: boolean;
  reason: string | null;
  score: number;
  structure: ContentStructure;
}

export function getBaitStyle(): BaitStyle {
  const raw = getSetting('bait_style', 'implicit').trim().toLowerCase();
  return raw === 'explicit' ? 'explicit' : 'implicit';
}

export function isHumanLikenessGateEnabled(): boolean {
  return getBooleanSettingFromSchema('human_likeness_gate');
}

export function getBaitCandidateCount(): number {
  return getIntSettingFromSchema('bait_candidate_count');
}

export function findBannedPhrase(text: string): string | null {
  const lower = text.toLowerCase();
  return BANNED_PHRASES.find((p) => lower.includes(p)) ?? null;
}

export function findBannedOpener(text: string, baitStyle: BaitStyle = getBaitStyle()): string | null {
  const trimmed = text.trim();
  const patterns = baitStyle === 'implicit'
    ? [...BANNED_BAIT_OPENERS, ...BANNED_OPENERS]
    : BANNED_OPENERS;
  for (const re of patterns) {
    if (re.test(trimmed)) return re.source;
  }
  return null;
}

function countQuestions(text: string): number {
  return (text.match(/\?/g) ?? []).length;
}

function sentenceWordCounts(text: string): number[] {
  const sentences = text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return sentences.map((s) => s.split(/\s+/).filter(Boolean).length);
}

function sentenceLengthVarianceTooLow(text: string): boolean {
  const counts = sentenceWordCounts(text);
  if (counts.length < 2) return false;
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  return max - min <= 5;
}

function jaccardSimilarity(a: string, b: string): number {
  const tokenize = (s: string) => new Set(
    s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2),
  );
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Classify the structural shape of outbound text for analytics / few-shot tuning. */
export function detectContentStructure(text: string): ContentStructure {
  const trimmed = text.trim();
  const chars = trimmed.length;
  const lines = trimmed.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const questions = countQuestions(trimmed);

  if (chars <= 140 && lines.length <= 1) return 'one_liner';
  if (questions >= 1 && /[?]\s*$/.test(trimmed)) return 'question_hook';
  if (lines.length >= 2 && chars <= 200) return 'setup_punch';
  if (lines.length >= 2 || (sentenceWordCounts(trimmed).length >= 3 && chars < 220)) {
    return 'rant_fragment';
  }
  return 'standard';
}

function humanTextureScore(text: string, flavor: 'pune' | 'general'): number {
  let score = 0;
  const contractions = (text.match(CONTRACTION_RE) ?? []).length;
  if (contractions >= 1) score += 0.2;
  if (contractions >= 2) score += 0.1;
  if (FIRST_PERSON_RE.test(text)) score += 0.15;
  if (DIGIT_RE.test(text)) score += 0.1;
  if (NAMED_ENTITY_RE.test(text)) score += 0.1;
  if (flavor === 'pune' && PUNE_LOCAL_TOKENS.test(text)) score += 0.15;

  const counts = sentenceWordCounts(text);
  if (counts.length >= 2) {
    const spread = Math.max(...counts) - Math.min(...counts);
    if (spread >= 6) score += 0.2;
    else if (spread >= 3) score += 0.1;
  }

  return Math.min(1, score);
}

function baitMechanicsScore(text: string, mode: EngagementMode): number {
  if (mode === 'NONE') return 0.5;
  let score = 0.3;
  const trimmed = text.trim();

  if (mode === 'CLICKBAIT') {
    if (/\b(but|until|then|because|after)\b/i.test(trimmed)) score += 0.15;
    if (trimmed.endsWith('...') || trimmed.endsWith('…')) score += 0.1;
    if (countQuestions(trimmed) === 1) score += 0.15;
    if (findBannedOpener(trimmed, 'implicit')) score -= 0.4;
  }

  if (mode === 'RAGEBAIT') {
    if (/\b(broken|useless|joke|theatre|scam|joke|farce|joke)\b/i.test(trimmed)) score += 0.1;
    if (/\b(not|never|always|every|nobody)\b/i.test(trimmed)) score += 0.1;
    if (FIRST_PERSON_RE.test(trimmed)) score += 0.1;
    if (findBannedOpener(trimmed, 'implicit')) score -= 0.4;
  }

  return Math.min(1, Math.max(0, score));
}

function specificityScore(text: string): number {
  let score = 0;
  if (DIGIT_RE.test(text)) score += 0.35;
  if (NAMED_ENTITY_RE.test(text)) score += 0.35;
  if (/\b(road|salary|metro|pmc|lane|phase|sector|ward|station|flight|model|api)\b/i.test(text)) {
    score += 0.3;
  }
  return Math.min(1, score);
}

/**
 * Composite score for ranking multiple LLM candidates. Higher is better.
 * score = humanTexture * 0.4 + baitMechanics * 0.3 + specificity * 0.2 - slopPenalty * 0.1
 */
export function humanLikenessScore(
  text: string,
  opts: HumanLikenessOptions = {},
): number {
  const flavor = opts.flavor ?? 'general';
  const mode = opts.engagementMode ?? 'NONE';
  const humanTexture = humanTextureScore(text, flavor);
  const baitMechanics = baitMechanicsScore(text, mode);
  const specificity = specificityScore(text);

  let slopPenalty = 0;
  if (findBannedPhrase(text)) slopPenalty += 0.5;
  if (findBannedOpener(text, opts.baitStyle ?? getBaitStyle())) slopPenalty += 0.5;
  if (sentenceLengthVarianceTooLow(text) && text.split(/[.!?]+/).filter(Boolean).length >= 3) {
    slopPenalty += 0.2;
  }

  return (
    humanTexture * 0.4
    + baitMechanics * 0.3
    + specificity * 0.2
    - slopPenalty * 0.1
  );
}

/** Gate check — returns rejection reason or null if acceptable. */
export function checkHumanLikeness(
  text: string,
  opts: HumanLikenessOptions = {},
): string | null {
  if (!isHumanLikenessGateEnabled()) return null;

  const trimmed = text.trim();
  if (!trimmed) return 'empty text';

  const banned = findBannedPhrase(trimmed);
  if (banned) return `contains AI-slop phrase "${banned}"`;

  const opener = findBannedOpener(trimmed, opts.baitStyle ?? getBaitStyle());
  if (opener) return `uses banned engagement-farm opener`;

  if (countQuestions(trimmed) > 2) return 'too many rhetorical questions';

  if (sentenceLengthVarianceTooLow(trimmed) && trimmed.split(/[.!?]+/).filter(Boolean).length >= 3) {
    return 'uniform sentence length reads like polished AI prose';
  }

  const avoid = opts.avoidTexts ?? [];
  for (const prior of avoid) {
    if (jaccardSimilarity(trimmed, prior) > 0.8) {
      return 'too similar to a recent post structurally';
    }
  }

  return null;
}

export function evaluateHumanLikeness(
  text: string,
  opts: HumanLikenessOptions = {},
): HumanLikenessResult {
  const reason = checkHumanLikeness(text, opts);
  return {
    ok: reason === null,
    reason,
    score: humanLikenessScore(text, opts),
    structure: detectContentStructure(text),
  };
}

/** Pick the highest-scoring candidate; ties broken by higher human-likeness score. */
export function pickBestCandidate(
  candidates: string[],
  opts: HumanLikenessOptions = {},
): { text: string; structure: ContentStructure; score: number } {
  if (candidates.length === 0) throw new Error('pickBestCandidate: no candidates');

  let best = candidates[0];
  let bestScore = humanLikenessScore(best, opts);
  let bestStructure = detectContentStructure(best);

  for (let i = 1; i < candidates.length; i++) {
    const candidate = candidates[i];
    const gate = checkHumanLikeness(candidate, opts);
    const score = humanLikenessScore(candidate, opts);
    const gatedScore = gate ? score - 1 : score;
    const bestGate = checkHumanLikeness(best, opts);
    const bestGatedScore = bestGate ? bestScore - 1 : bestScore;

    if (gatedScore > bestGatedScore) {
      best = candidate;
      bestScore = score;
      bestStructure = detectContentStructure(candidate);
    }
  }

  return { text: best, structure: bestStructure, score: bestScore };
}
