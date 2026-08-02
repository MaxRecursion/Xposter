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
import { getIntSetting } from '../storage/settings.js';

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
}

export interface BaitDecision {
  mode: EngagementMode;
  reason: string;
}

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
  if (target >= 100) {
    return { mode: pickBaitSubtype(opts.rng), reason: 'bait forced' };
  }

  const counts = opts.counts ?? { bait: 0, normal: 0 };
  const total = counts.bait + counts.normal;
  const shareIfSkipped = counts.bait / (total + 1);

  if (shareIfSkipped < target / 100) {
    const mode = pickBaitSubtype(opts.rng);
    return {
      mode,
      reason: `deficit ${(shareIfSkipped * 100).toFixed(0)}% < ${target}% → ${mode}`,
    };
  }

  return {
    mode: 'NONE',
    reason: `quota met ${(shareIfSkipped * 100).toFixed(0)}% >= ${target}%`,
  };
}

function pickBaitSubtype(rng: (() => number) | undefined): EngagementMode {
  const roll = (rng ?? Math.random)();
  return roll < 0.5 ? 'CLICKBAIT' : 'RAGEBAIT';
}

/**
 * Prompt overlay. Appended to the existing system prompt so anti-slop and
 * hard limits still apply.
 */
export function baitGuidanceFor(mode: EngagementMode): string {
  if (mode === 'CLICKBAIT') {
    return `ENGAGEMENT MODE: CLICKBAIT (use sparingly — this reply/post is in the engagement quota).
Goal: maximize replies and profile clicks with a curiosity gap — not a lie.
- Open with a hook that withholds the full punchline ("The part about X nobody mentions:", "Wait until you hear what happened after…", "This is why Y keeps failing:").
- Make one SPECIFIC claim or observation that feels incomplete without a reply.
- End with a question or unfinished implication that begs a response.
- Never fabricate events, numbers, or quotes. Curiosity ≠ misinformation.
- Still no identity punches (caste/religion/gender/region/class/party). Situation and systems only.
- Still human — no "you won't BELIEVE", no all-caps spam, no engagement-farm emoji bait.`;
  }

  if (mode === 'RAGEBAIT') {
    return `ENGAGEMENT MODE: RAGEBAIT (use sparingly — this reply/post is in the engagement quota).
Goal: a sharp, disagreeable take that makes people hit reply — debate the CLAIM, not a person.
- Take the strongest honest position on a SAFE topic: bureaucracy, product UX, traffic, weather, hiring, funding, metro delays, civic inefficiency, startup theatre.
- Be specific and confident. Soft takes get scrolled past; a clear "X is the real problem" gets argued with.
- Invite disagreement with an open question or a challenge ("Change my mind:", "What am I missing?").
- NEVER rage about: caste, religion, gender, region-as-insult, disability, appearance, or a named private individual.
- NEVER celebrate harm, grief, or tragedy. If the topic is sensitive, abandon this mode mentally and write a normal take.
- Argue with systems and incentives, not tribes. No "everyone from X is…".`;
  }

  return '';
}
