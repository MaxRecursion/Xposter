/**
 * Conversation Gravity — would a human hit Reply, especially the original author?
 *
 * Heuristic first (cheap, testable). Optional LLM judge blends in when the
 * dashboard setting is on. Fail closed: below the min score we skip the tweet.
 */
import { getBooleanSettingFromSchema, getIntSettingFromSchema } from '../storage/settings.js';
import { logger } from '../utils/logger.js';
import { GravitySkipError } from './errors.js';
import { findBannedOpener, findBannedPhrase } from './human_likeness.js';
import { generateText } from './llm_runner.js';

export interface GravityScore {
  score: number;
  reasons: string[];
}

const AGREEMENT_OPENERS = /^(exactly|agreed|so true|this,?$|this!|100%|facts|couldn'?t agree|absolutely|yes,? this|well said)/i;
const QUESTION_RE = /\?/g;
const DIGIT_RE = /\d/;
const NAMED_ENTITY_RE = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/;
const CONCRETE_NOUN_RE = /\b(road|salary|metro|pmc|lane|phase|sector|ward|station|flight|model|api|pothole|bridge|flyover|gcc|hinjewadi|baner|wakad|kharadi)\b/i;
const IMPLICATION_RE = /\b(so |that's why|which means|because|unless|until|if we|the catch)\b/i;

export function getConversationGravityMin(): number {
  return getIntSettingFromSchema('conversation_gravity_min');
}

export function isConversationGravityJudgeEnabled(): boolean {
  return getBooleanSettingFromSchema('conversation_gravity_judge');
}

export function jaccardTokens(a: string, b: string): number {
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

/**
 * 1–5 heuristic. Specific receipts and a single reply-invitation raise the
 * score; echoing the parent, agreement-only openers, and slop lower it.
 */
export function scoreConversationGravityHeuristic(parentTweet: string, draft: string): GravityScore {
  const reasons: string[] = [];
  const trimmed = draft.trim();
  if (!trimmed) {
    return { score: 1, reasons: ['empty draft'] };
  }

  let raw = 2.6;

  const overlap = jaccardTokens(parentTweet, trimmed);
  if (overlap > 0.5) {
    raw -= 1.6;
    reasons.push('echoes the parent tweet');
  } else if (overlap > 0.35) {
    raw -= 0.6;
    reasons.push('too close to the parent wording');
  } else {
    raw += 0.35;
    reasons.push('adds wording the parent did not use');
  }

  if (AGREEMENT_OPENERS.test(trimmed)) {
    raw -= 1.5;
    reasons.push('agreement opener');
  }

  const banned = findBannedPhrase(trimmed);
  if (banned) {
    raw -= 1.2;
    reasons.push(`slop phrase "${banned}"`);
  }

  const opener = findBannedOpener(trimmed);
  if (opener) {
    raw -= 0.8;
    reasons.push('engagement-farm opener');
  }

  const questions = (trimmed.match(QUESTION_RE) ?? []).length;
  if (questions > 2) {
    raw -= 1;
    reasons.push('too many questions');
  } else if (questions === 1) {
    raw += 0.7;
    reasons.push('one natural question');
  }

  if (DIGIT_RE.test(trimmed) || NAMED_ENTITY_RE.test(trimmed) || CONCRETE_NOUN_RE.test(trimmed)) {
    raw += 0.9;
    reasons.push('concrete receipt');
  } else {
    raw -= 0.4;
    reasons.push('no named place, number, or system');
  }

  if (IMPLICATION_RE.test(trimmed)) {
    raw += 0.35;
    reasons.push('implication / second-order angle');
  }

  const parentTokens = new Set(
    parentTweet.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 3),
  );
  const newTokens = trimmed
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !parentTokens.has(w));
  if (newTokens.length >= 3) {
    raw += 0.4;
    reasons.push('new information vs parent');
  }

  const score = clampGravity(raw);
  return { score, reasons };
}

function clampGravity(value: number): number {
  const clamped = Math.min(5, Math.max(1, value));
  return Math.round(clamped * 10) / 10;
}

export function pickByGravity(
  parentTweet: string,
  drafts: string[],
): { text: string; score: number; reasons: string[] } {
  if (drafts.length === 0) {
    throw new Error('pickByGravity: no drafts');
  }
  let best = drafts[0];
  let bestScored = scoreConversationGravityHeuristic(parentTweet, best);
  for (let i = 1; i < drafts.length; i++) {
    const scored = scoreConversationGravityHeuristic(parentTweet, drafts[i]);
    if (scored.score > bestScored.score) {
      best = drafts[i];
      bestScored = scored;
    }
  }
  return { text: best, score: bestScored.score, reasons: bestScored.reasons };
}

async function judgeWithLlm(parentTweet: string, draft: string): Promise<number | null> {
  if (!isConversationGravityJudgeEnabled()) return null;
  try {
    const raw = await generateText({
      taskName: 'conversationGravityJudge',
      systemPrompt: `You score X (Twitter) reply drafts on conversation gravity: would a human, especially the original author, hit Reply?
Return ONLY JSON: {"score":1-5,"reason":"short"}.
5 = specific new receipt + a falsifiable claim or genuine question.
3 = decent take, might get a like.
1 = echo, slop, or farm copy. English drafts only.`,
      userPrompt: `PARENT:\n${parentTweet.slice(0, 600)}\n\nDRAFT:\n${draft.slice(0, 400)}`,
      minChars: 8,
      groq: { maxTokens: 80, temperature: 0 },
    });
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { score?: unknown };
    const n = typeof parsed.score === 'number' ? parsed.score : Number(parsed.score);
    if (!Number.isFinite(n)) return null;
    return clampGravity(n);
  } catch (err) {
    logger.warn('Conversation gravity judge failed; using heuristic', { err: String(err) });
    return null;
  }
}

export async function scoreConversationGravity(
  parentTweet: string,
  draft: string,
): Promise<GravityScore> {
  const heuristic = scoreConversationGravityHeuristic(parentTweet, draft);
  const judged = await judgeWithLlm(parentTweet, draft);
  if (judged == null) return heuristic;
  return {
    score: clampGravity(heuristic.score * 0.5 + judged * 0.5),
    reasons: [...heuristic.reasons, `llm judge ${judged}`],
  };
}

/**
 * Rank drafts by heuristic, optionally blend an LLM judge on the winner,
 * rewrite once if below min, then fail closed.
 */
export async function applyConversationGravity(opts: {
  parentText: string;
  drafts: string[];
  rewrite?: (reasons: string[]) => Promise<string>;
  minScore?: number;
}): Promise<{ text: string; score: number; reasons: string[] }> {
  const minScore = opts.minScore ?? getConversationGravityMin();
  const picked = pickByGravity(opts.parentText, opts.drafts);
  let scored = await scoreConversationGravity(opts.parentText, picked.text);
  let text = picked.text;

  if (scored.score < minScore && opts.rewrite) {
    const retry = await opts.rewrite(scored.reasons);
    const retryScored = await scoreConversationGravity(opts.parentText, retry);
    if (retryScored.score >= scored.score) {
      text = retry;
      scored = retryScored;
    }
  }

  if (scored.score < minScore) {
    throw new GravitySkipError(
      `gravity ${scored.score} < ${minScore}: ${scored.reasons.slice(0, 3).join('; ')}`,
    );
  }

  return { text, score: scored.score, reasons: scored.reasons };
}
