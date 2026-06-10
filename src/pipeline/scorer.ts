import { Post } from '../storage/queries.js';
import { keywordMatches } from './keywords.js';

export interface ScoreBreakdown {
  recency: number;          // 0-30: newer = higher
  topicRelevance: number;   // 0-30: more keyword matches = higher
  replyOpportunity: number; // 0-20: questions, complaints, requests
  engagementSweet: number;  // 0-10: sweet spot (not 0, not viral)
}

export interface ScoredPost {
  id: string;
  score: number;
  breakdown: ScoreBreakdown;
}

// Signals that suggest a reply is welcome. Word boundaries prevent substring
// false positives ('how' in "show", 'fix' in "prefix", …).
const QUESTION_PATTERNS = [/\?/, /\bwhen\b/i, /\bwhere\b/i, /\bhow\b/i, /\banyone\b/i, /\bany idea/i];

const COMPLAINT_PATTERNS = [/\bterrible\b/i, /\bworst\b/i, /\bhorrible\b/i, /\bbroken\b/i, /\bfix\b/i,
  /\bfrustrated\b/i, /\bsick of\b/i];

const HELP_REQUEST_PATTERNS = [/\bhelp\b/i, /\bsuggest/i, /\brecommend/i, /\badvice\b/i];

// English topic keyword weights
const WEIGHTED_KEYWORDS: Array<[string, number]> = [
  ['pune', 3],
  ['rain', 2], ['flood', 2],
  ['traffic', 2],
  ['waterlog', 2], ['pothole', 2], ['pmc', 1],
  ['event', 1], ['local', 1], ['metro', 1],
];

export function scorePost(post: Post): ScoredPost {
  const now = Math.floor(Date.now() / 1000);
  const ageSeconds = now - post.timestamp;

  // ── Recency (0–30) ────────────────────────────────────────────────────────
  // Full score within 30 min, linear decay to 0 at 6 hours
  const sixHours = 6 * 3600;
  const recency = Math.max(0, 30 * (1 - ageSeconds / sixHours));

  // ── Topic Relevance (0–30) ─────────────────────────────────────────────────
  let kwScore = 0;
  for (const [kw, weight] of WEIGHTED_KEYWORDS) {
    if (keywordMatches(post.text, kw)) {
      kwScore += weight;
    }
  }
  const topicRelevance = Math.min(30, kwScore * 5);

  // ── Reply Opportunity (0–20) ───────────────────────────────────────────────
  let oppScore = 0;
  if (QUESTION_PATTERNS.some((p) => p.test(post.text))) oppScore += 12;
  if (COMPLAINT_PATTERNS.some((p) => p.test(post.text))) oppScore += 8;
  if (HELP_REQUEST_PATTERNS.some((p) => p.test(post.text))) oppScore += 10;
  const replyOpportunity = Math.min(20, oppScore);

  // ── Engagement Sweet Spot (0–10) ──────────────────────────────────────────
  // Zero engagement = possibly irrelevant spam
  // Viral (>500 likes) = hard to stand out, skip
  const totalEngagement = post.likes + post.replies * 2 + post.retweets;
  let engScore = 0;
  if (totalEngagement >= 1 && totalEngagement <= 50) engScore = 10;
  else if (totalEngagement > 50 && totalEngagement <= 200) engScore = 6;
  else if (totalEngagement > 200 && totalEngagement <= 500) engScore = 3;
  // 0 engagement or >500: engScore stays 0
  const engagementSweet = engScore;

  const breakdown: ScoreBreakdown = {
    recency: Math.round(recency * 10) / 10,
    topicRelevance: Math.round(topicRelevance * 10) / 10,
    replyOpportunity: Math.round(replyOpportunity * 10) / 10,
    engagementSweet,
  };

  const score = Math.min(100,
    breakdown.recency +
    breakdown.topicRelevance +
    breakdown.replyOpportunity +
    breakdown.engagementSweet,
  );

  return { id: post.id, score: Math.round(score * 10) / 10, breakdown };
}

export function rankCandidates(scored: ScoredPost[]): ScoredPost[] {
  return [...scored].sort((a, b) => b.score - a.score);
}
