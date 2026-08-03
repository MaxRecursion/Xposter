/**
 * Engagement-bait allocator for replies and original posts.
 *
 * Goal: about `engagement_bait_pct` of outbound text (default 30%) uses a
 * clickbait or ragebait frame to earn impressions — without punching down on
 * identity, grief, or other third-rail topics.
 *
 * Same deficit math as stance.ts: a per-call coin flip drifts; counting what
 * already shipped today and filling the gap keeps the share honest even when
 * safety forces NONE for a stretch.
 */
import {
  getBaitTuningSnapshot,
  type TopPerformingPost,
} from '../storage/engagement_performance.js';
import { getIntSetting, getSetting } from '../storage/settings.js';
import { getBaitStyle, type BaitStyle, type ContentStructure } from './human_likeness.js';

export type EngagementMode = 'NONE' | 'CLICKBAIT' | 'RAGEBAIT';

export interface BaitCounts {
  bait: number;
  normal: number;
}

export interface DecideBaitOptions {
  /** Target share of bait posts/replies, 0-100. */
  targetPct: number;
  /** Absolute veto — grief, hard news, harassment, etc. */
  blocked: boolean;
  counts?: BaitCounts;
  /** Injectable RNG for the CLICKBAIT vs RAGEBAIT split. */
  rng?: () => number;
  /** Override live performance-based CLICKBAIT probability (tests). */
  subtypeClickProb?: number;
}

export interface BaitDecision {
  mode: EngagementMode;
  reason: string;
}

export type BaitStructure = ContentStructure;

const STRUCTURE_WEIGHTS: Array<{ structure: BaitStructure; weight: number }> = [
  { structure: 'one_liner', weight: 30 },
  { structure: 'setup_punch', weight: 30 },
  { structure: 'rant_fragment', weight: 25 },
  { structure: 'question_hook', weight: 15 },
];

/**
 * Heuristic: content that must never get a bait frame.
 *
 * Conservative on purpose — a false positive just posts a normal take; a false
 * negative on a death announcement is an account-ending mistake.
 */
const BAIT_BLOCK_RE = new RegExp(
  [
    // Grief / health / safety
    String.raw`\b(rip|rest in peace|passed away|condolence|funeral|died|dies|dying|killed|murder|suicide|cancer|hospitali[sz]ed|icu)\b`,
    // Abuse / harassment
    String.raw`\b(harass|assault|rape|molest|abuse|traffick)\b`,
    // Identity third rails — never bait these
    String.raw`\b(caste|dalit|brahmin|muslim|hindu|christian|sikh|jew|jewish|islam|temple|mosque|church|reservation)\b`,
    // Active disaster / emergency
    String.raw`\b(earthquake|flood victims?|building collapse|stampede|mass shooting)\b`,
  ].join('|'),
  'i',
);

export function isBlockedForBait(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return BAIT_BLOCK_RE.test(trimmed);
}

export function getEngagementBaitPct(): number {
  return getIntSetting('engagement_bait_pct', 30, 0, 100);
}

/**
 * Picks NONE / CLICKBAIT / RAGEBAIT for the next outbound item.
 *
 * Safety is absolute. Within the bait budget, subtypes split ~50/50 so the
 * feed doesn't become one flavour of provocation.
 */
export function decideEngagementBait(opts: DecideBaitOptions): BaitDecision {
  if (opts.blocked) {
    return { mode: 'NONE', reason: 'blocked by safety heuristic' };
  }

  const target = Math.min(100, Math.max(0, opts.targetPct));
  if (target <= 0) return { mode: 'NONE', reason: 'bait disabled' };
  const clickProb = opts.subtypeClickProb ?? getLiveClickSubtypeProb();

  if (target >= 100) {
    const mode = pickBaitSubtype(opts.rng, clickProb);
    return { mode, reason: `bait forced (clickProb=${clickProb.toFixed(2)})` };
  }

  const counts = opts.counts ?? { bait: 0, normal: 0 };
  const total = counts.bait + counts.normal;
  const shareIfSkipped = counts.bait / (total + 1);

  if (shareIfSkipped < target / 100) {
    const mode = pickBaitSubtype(opts.rng, clickProb);
    return {
      mode,
      reason: `deficit ${(shareIfSkipped * 100).toFixed(0)}% < ${target}% → ${mode} (clickProb=${clickProb.toFixed(2)})`,
    };
  }

  return {
    mode: 'NONE',
    reason: `quota met ${(shareIfSkipped * 100).toFixed(0)}% >= ${target}%`,
  };
}

function getLiveClickSubtypeProb(): number {
  try {
    return getBaitTuningSnapshot().click_subtype_prob;
  } catch {
    return 0.5;
  }
}

function pickBaitSubtype(
  rng: (() => number) | undefined,
  clickProb = 0.5,
): EngagementMode {
  const roll = (rng ?? Math.random)();
  return roll < clickProb ? 'CLICKBAIT' : 'RAGEBAIT';
}

/** Weighted random structural mode for bait posts/replies. */
export function pickBaitStructure(rng: () => number = Math.random): BaitStructure {
  const total = STRUCTURE_WEIGHTS.reduce((sum, row) => sum + row.weight, 0);
  let roll = rng() * total;
  for (const row of STRUCTURE_WEIGHTS) {
    roll -= row.weight;
    if (roll <= 0) return row.structure;
  }
  return 'setup_punch';
}

function structureGuidance(structure: BaitStructure): string {
  switch (structure) {
    case 'one_liner':
      return 'STRUCTURE: ONE-LINER — single tight line under 140 chars. No preamble.';
    case 'setup_punch':
      return 'STRUCTURE: SETUP-PUNCH — two short lines; the second line lands the take.';
    case 'rant_fragment':
      return 'STRUCTURE: RANT-FRAGMENT — 2-3 breathless short clauses, slightly fed up, very specific.';
    case 'question_hook':
      return 'STRUCTURE: QUESTION-HOOK — build to one genuine question at the end (not a rhetorical pile-on).';
    default:
      return '';
  }
}

/** Few-shot examples from top bait performers — refreshed each generation. */
export function baitExamplesBlock(mode: EngagementMode): string {
  if (mode === 'NONE') return '';
  try {
    const snapshot = getBaitTuningSnapshot();
    const sameMode = snapshot.top_bait_posts.filter((p) => p.mode === mode);
    const fallback = snapshot.top_overall_posts.filter((p) => p.score > 0);
    const picks = (sameMode.length > 0 ? sameMode : fallback).slice(0, 3);
    if (picks.length === 0) return '';
    return formatExamplesBlock(mode, picks);
  } catch {
    return '';
  }
}

function formatExamplesBlock(mode: EngagementMode, picks: TopPerformingPost[]): string {
  const lines = picks.map((p, i) => {
    const snippet = p.text.replace(/\s+/g, ' ').trim().slice(0, 220);
    const replyRate = p.impressions > 0
      ? (p.replies / p.impressions * 100).toFixed(1)
      : '?';
    return `${i + 1}. [score ${p.score.toFixed(1)} · replyRate ${replyRate}% · ${p.kind}] ${snippet}`;
  });
  return [
    `RECENT HIGH-PERFORMING ${mode} EXAMPLES (match energy and structure, not exact words):`,
    ...lines,
  ].join('\n');
}

function implicitClickGuidance(examplesSuffix: string): string {
  return `ENGAGEMENT INTENT: curiosity (this reply/post is in the engagement quota).
Make the reader need the next line — but sound mid-conversation, not like a headline.
- State one specific, true partial fact and stop before the full payoff.
- Withhold one detail the reader wants (who, what changed, the number) without fabricating.
- Conversational incompleteness beats teaser copy: trailing thought, mid-story entry.
- No "nobody talks about", no "you won't believe", no colon-title hooks, no "The part about X:".
- If it reads like a YouTube thumbnail, rewrite it.
- Still no identity punches (caste/religion/gender/region/class/party). Situation and systems only.
- Still human — no all-caps spam, no engagement-farm emoji bait.${examplesSuffix}`;
}

function implicitRageGuidance(examplesSuffix: string): string {
  return `ENGAGEMENT INTENT: friction (this reply/post is in the engagement quota).
Take a confident position against a system, product, or civic failure — never a person or tribe.
- Lead with a blunt critique, not a labeled debate prompt.
- One concrete detail that proves you live this (a road, a salary, a delay, a product name).
- Invite disagreement naturally ("Surely I'm not the only one who…") — no "Change my mind:".
- NEVER rage about: caste, religion, gender, region-as-insult, disability, appearance, or a named private individual.
- NEVER celebrate harm, grief, or tragedy. If the topic is sensitive, write a normal take instead.
- Argue with systems and incentives, not tribes. No "everyone from X is…".${examplesSuffix}`;
}

function explicitClickGuidance(examplesSuffix: string): string {
  return `ENGAGEMENT MODE: CLICKBAIT (use sparingly — this reply/post is in the engagement quota).
Goal: maximize replies and profile clicks with a curiosity gap — not a lie.
- Open with a hook that withholds the full punchline ("The part about X nobody mentions:", "Wait until you hear what happened after…", "This is why Y keeps failing:").
- Make one SPECIFIC claim or observation that feels incomplete without a reply.
- End with a question or unfinished implication that begs a response.
- Never fabricate events, numbers, or quotes. Curiosity ≠ misinformation.
- Still no identity punches (caste/religion/gender/region/class/party). Situation and systems only.
- Still human — no "you won't BELIEVE", no all-caps spam, no engagement-farm emoji bait.${examplesSuffix}`;
}

function explicitRageGuidance(examplesSuffix: string): string {
  return `ENGAGEMENT MODE: RAGEBAIT (use sparingly — this reply/post is in the engagement quota).
Goal: a sharp, disagreeable take that makes people hit reply — debate the CLAIM, not a person.
- Take the strongest honest position on a SAFE topic: bureaucracy, product UX, traffic, weather, hiring, funding, metro delays, civic inefficiency, startup theatre.
- Be specific and confident. Soft takes get scrolled past; a clear "X is the real problem" gets argued with.
- Invite disagreement with an open question or a challenge ("Change my mind:", "What am I missing?").
- NEVER rage about: caste, religion, gender, region-as-insult, disability, appearance, or a named private individual.
- NEVER celebrate harm, grief, or tragedy. If the topic is sensitive, abandon this mode mentally and write a normal take.
- Argue with systems and incentives, not tribes. No "everyone from X is…".${examplesSuffix}`;
}

/**
 * Prompt overlay. Appended to the existing system prompt so anti-slop and
 * hard limits still apply.
 */
export function baitGuidanceFor(
  mode: EngagementMode,
  opts: { structure?: BaitStructure; baitStyle?: BaitStyle } = {},
): string {
  if (mode === 'NONE') return '';

  const baitStyle = opts.baitStyle ?? getBaitStyle();
  const examples = baitExamplesBlock(mode);
  const examplesSuffix = examples ? `\n\n${examples}` : '';
  const structureBlock = opts.structure ? structureGuidance(opts.structure) : '';

  const modeBlock = mode === 'CLICKBAIT'
    ? (baitStyle === 'explicit' ? explicitClickGuidance(examplesSuffix) : implicitClickGuidance(examplesSuffix))
    : (baitStyle === 'explicit' ? explicitRageGuidance(examplesSuffix) : implicitRageGuidance(examplesSuffix));

  return [modeBlock, structureBlock].filter(Boolean).join('\n\n');
}

/** Logged after metric sync so the activity feed shows live tuning weights. */
export function describeBaitTuning(): string {
  const snap = getBaitTuningSnapshot();
  const click = snap.mode_performance.find((r) => r.mode === 'CLICKBAIT');
  const rage = snap.mode_performance.find((r) => r.mode === 'RAGEBAIT');
  const none = snap.mode_performance.find((r) => r.mode === 'NONE');
  const parts = [
    `clickProb=${snap.click_subtype_prob.toFixed(2)}`,
    `baitStyle=${getSetting('bait_style', 'implicit')}`,
    click ? `CLICK n=${click.count} avg=${click.avg_score}` : 'CLICK n=0',
    rage ? `RAGE n=${rage.count} avg=${rage.avg_score}` : 'RAGE n=0',
    none ? `NONE n=${none.count} avg=${none.avg_score}` : 'NONE n=0',
  ];
  if (snap.top_bait_posts[0]) {
    parts.push(`topBaitScore=${snap.top_bait_posts[0].score.toFixed(1)}`);
  }
  return parts.join(' ');
}
