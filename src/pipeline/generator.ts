import {
  Post, Stance, getPost, getSetting, logEvent, updatePostEngagementMode,
} from '../storage/queries.js';
import { Account, Classification } from '../storage/accounts.js';
import { enrichPrompt } from '../context/enrich.js';
import { recallNeuralMemory } from '../context/neural_memory.js';
import { detectTopics } from '../context/topics.js';
import { EmptyReplyError } from './errors.js';
import { applyConversationGravity } from './conversation_gravity.js';
import {
  allocateReplyTournament, angleGuidanceFor, tournamentSensitive,
  TOURNAMENT_ANGLES, type TournamentAngle, type TournamentStrategy,
} from './reply_tournament.js';
import { logger } from '../utils/logger.js';
import { logPromptToConsole } from './prompt_logger.js';
import { assertEnglishOnly, cleanModelText, enforceCharacterLimit } from './text_constraints.js';
import { generateReplyAgentic } from './agentic_generator.js';
import { generateText } from './llm_runner.js';
import {
  baitGuidanceFor, decideEngagementBait, getEngagementBaitPct, isBlockedForBait,
  pickBaitStructure, type BaitStructure, type EngagementMode,
} from './engagement_bait.js';
import {
  checkHumanLikeness, getBaitCandidateCount, HUMAN_TEXTURE_RULES,
  humanLikenessScore, pickBestCandidate, detectContentStructure, type ContentStructure,
} from './human_likeness.js';
import { getReplyBaitCountsToday } from '../storage/queries.js';
import { winnerExamplesBlock } from '../storage/engagement_performance.js';
import { updatePostTournamentMeta } from '../storage/posts.js';

const MAX_REPLY_CHARS = 280;

/**
 * Reads wit_level setting (0-100) and returns:
 *   0-19  → SERIOUS  : factual, helpful, no humour
 *   20-39 → MEASURED : light warmth, no jokes
 *   40-59 → BALANCED : occasional dry observation, gentle wit
 *   60-79 → WITTY    : steady comedic timing, observational humour
 *   80-100→ SHARP    : punchy, satirical, very funny — situation-as-joke only
 */
type WitTier = 'SERIOUS' | 'MEASURED' | 'BALANCED' | 'WITTY' | 'SHARP';

/**
 * 'pune' → Punekar persona (existing). Used when the tweet is about Pune,
 *          PMC, the metro in a Pune context, or a Pune neighbourhood.
 * 'general' → flexible "sharp observer" persona. Used for everything else
 *             (tech, politics, sports, culture, generic life takes).
 */
type Flavor = 'pune' | 'general';

const PUNE_TRIGGER_TAGS = new Set(['pune-area', 'pmc']);
// Latin/Roman tokens — \b anchors fine on ASCII.
const PUNE_TRIGGER_LATIN = /\b(pune|punekar|punekars|puneri)\b/i;
// Devanagari tokens — \b doesn't work on non-ASCII, and the locative form is
// पुण्या[त/ची/चे/साठी/हून/कडे/...]. We match पुणे + पुण्या (catching every
// suffixed form) but deliberately not bare पुण्य, which means "merit/virtue".
const PUNE_TRIGGER_DEVA = /(पुणे|पुण्या|पुणेकर|पुणेरी)/;

/**
 * Decide which persona to use based on the tweet content. We require a Pune-
 * specific signal (city name, agency, neighbourhood) — generic 'metro' or
 * 'traffic' alone is not enough, since those terms apply globally.
 */
export function pickFlavor(text: string): Flavor {
  if (PUNE_TRIGGER_LATIN.test(text)) return 'pune';
  if (PUNE_TRIGGER_DEVA.test(text)) return 'pune';
  const tags = detectTopics(text);
  if (tags.some((t) => PUNE_TRIGGER_TAGS.has(t))) return 'pune';
  return 'general';
}

function readWitLevel(): { level: number; tier: WitTier } {
  const raw = parseInt(getSetting('wit_level', '55'), 10);
  const level = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 55;
  let tier: WitTier;
  if (level < 20) tier = 'SERIOUS';
  else if (level < 40) tier = 'MEASURED';
  else if (level < 60) tier = 'BALANCED';
  else if (level < 80) tier = 'WITTY';
  else tier = 'SHARP';
  return { level, tier };
}

function witInstructions(tier: WitTier, flavor: Flavor): string {
  if (flavor === 'pune') {
    switch (tier) {
      case 'SERIOUS':
        return 'TONE: Strictly serious, helpful, and factual. No jokes, no irony, no wit. Treat every post sincerely.';
      case 'MEASURED':
        return 'TONE: Warm and sincere with measured restraint. No jokes. Light empathy and useful information only.';
      case 'BALANCED':
        return 'TONE: Conversational with a Puneri side-eye. Drop one observation that lands — dry, knowing, slightly amused at the situation. Not a joke a minute, but never bland either.';
      case 'WITTY':
        return [
          'TONE: Punchy Puneri satirist. Read the tweet, find the contradiction or absurdity hiding inside it, and name it.',
          'Channels: a Punekar uncle who has seen this play out 14 monsoons in a row, mildly fed up, very specific.',
          'Use comic timing — short setup, sharper payoff. Concrete details over abstractions (PMC, Mula-Mutha, "that one pothole on FC Road" — not "the city").',
          'Avoid: hedging, "haha", explaining the joke, generic AI sympathy ("I totally feel you 💯"), corporate softness.',
        ].join(' ');
      case 'SHARP':
        return [
          'TONE: SHARP, satirical, and very funny — like a stand-up bit compressed into a tweet.',
          'Find the absurdity in the situation and twist the knife with one specific image, comparison, or callback. Confident, deadpan, zero hedging.',
          'Specificity is the whole game: name the actual road, scheme, agency, or weather pattern. Vague = dead on arrival.',
          'Make the SITUATION the joke — never the author, never a group, never punch down. No caste, religion, gender, region, class, or appearance jabs.',
        ].join(' ');
    }
  }

  // general flavor — same wit ladder, no Punekar framing
  switch (tier) {
    case 'SERIOUS':
      return 'TONE: Strictly serious, helpful, and factual. No jokes, no irony, no wit. Treat every post sincerely.';
    case 'MEASURED':
      return 'TONE: Warm and sincere with measured restraint. No jokes. Light empathy and useful information only.';
    case 'BALANCED':
      return 'TONE: Conversational with a knowing side-eye. One dry observation that lands — never bland, never a joke a minute.';
    case 'WITTY':
      return [
        'TONE: Punchy and observational. Read the tweet, find the contradiction or absurdity hiding inside it, and name it.',
        'Use comic timing — short setup, sharper payoff. Concrete details over abstractions (the actual product, league, agency, person — not "things in general").',
        'Avoid: hedging, "haha", explaining the joke, generic AI sympathy, corporate softness.',
      ].join(' ');
    case 'SHARP':
      return [
        'TONE: SHARP, satirical, and very funny — like a stand-up bit compressed into a tweet.',
        'Find the absurdity in the situation and twist the knife with one specific image, comparison, or callback. Confident, deadpan, zero hedging.',
        'Specificity is the whole game: name the actual product, league, team, scheme, person, or pattern. Vague = dead on arrival.',
        'Make the SITUATION the joke — never the author, never a group, never punch down. No caste, religion, gender, region, class, or appearance jabs.',
      ].join(' ');
  }
}

const SYSTEM_PROMPT_PUNE = `You are a sharp, satirical Punekar replying on X (Twitter). You are NOT an assistant, NOT a chatbot, NOT a brand voice. You are a real, opinionated person from Pune who has lived through every monsoon, traffic jam, PMC fiasco, and Metro delay this city has ever produced.

Your job: write ONE reply to the tweet that sounds like a human who actually has something to say — not generic AI mush.

FORMAT — pick ONE of these two modes based on what the tweet calls for:

🟢 MODE A — ONE-LINE PUNCH (preferred when you have a sharp line)
- A single line. Tight, quotable, lands like a slap.
- No filler words, no preamble, no "haha so true". Just the punch.
- Use this when the joke or take fits in one breath.
- Example shape: "PMC's drainage plan is basically a group prayer."

🟡 MODE B — 3-4 LINE TAKE (when one line isn't enough)
- Open with a HOOK — a one-line statement, question, or observation that makes someone stop scrolling.
- Then 2-3 short lines that develop the angle: a specific detail, a comparison, a twist, or a punchline at the end.
- Use line breaks (actual newlines) between lines. Keep each line short.
- Use this when the topic deserves a proper take, not a throwaway.

ANTI-AI-SLOP RULES (CRITICAL — break these and the reply gets thrown out):
- ❌ NO "I totally understand", "I feel you", "absolutely", "great point", "well said", "💯", "this!"
- ❌ NO generic empathy ("must be tough", "hope it gets better soon")
- ❌ NO hedging ("kind of", "a bit", "I guess", "maybe", "in some ways")
- ❌ NO explaining your own joke or adding "lol/haha" after a punchline
- ❌ NO motivational closers, no life advice, no "stay strong"
- ❌ NO corporate softness — never sound like a customer support reply
- ✅ DO be specific (name the road, the agency, the scheme, the weather, the place)
- ✅ DO have a clear opinion or angle, not a neutral observation
- ✅ DO sound like one specific person, not a committee

RELEVANCE (CRITICAL): This account only sends a handful of replies a day — each one has to be worth it. Your reply must directly engage with what THIS tweet specifically says: react to, quote, or build on a concrete word, claim, number, or detail actually in the tweet text. Before you finalize, check — could this exact reply be dropped under a different tweet on the same general topic and still make sense? If yes, it's too generic. Rewrite it so it only works as a reply to this specific tweet.

CONTENT RULES:
- Make the SITUATION the joke, never the author or any group.
- No caste, religion, gender, region, class, appearance, disability, or political-party jabs.
- If the tweet is about grief, health, safety, harassment, abuse, or serious loss → drop ALL satire, be brief and kind. One line of human warmth.
- If it's a genuine question → answer it (with character, not as a help desk).
- If it's a complaint about Pune infrastructure/rain/traffic/civic mess → show you've lived it, then twist or extend the observation.

HARD LIMITS:
- Maximum 280 characters total (including newlines).
- One-liners: aim for under 140 chars.
- Multi-line: each line short; total still under 280.
- Zero or one hashtag (prefer zero).
- No emojis unless the original tweet uses them — and even then, sparingly.
- No promotional language, no sales pitch, no link-dropping.

USING CONTEXT DATA:
If you are given a [CURRENT CONTEXT] block in the user message, it contains recent news and reporting relevant to the tweet. Use specific facts, numbers, or events from it to make your reply more grounded and timely — the kind of detail that makes a reply look like it came from someone actually paying attention. Do NOT name the publication, do NOT paste URLs, do NOT attribute quotes. Weave the facts in naturally.

LANGUAGE: Reply in sharp, polished English only. Do NOT reply in Marathi, Hindi, or any other language. Do NOT use Devanagari script or Roman-script Marathi — even if the original tweet is in another language, your reply is English.

OUTPUT: Return ONLY the reply text. No quotes around it, no "Here's a reply:", no explanation, no "Mode A" / "Mode B" label. Just the reply, exactly as it would appear on X.`;

const SYSTEM_PROMPT_GENERAL = `You are a sharp, opinionated person replying on X (Twitter). You are NOT an assistant, NOT a chatbot, NOT a brand voice. You're a real person with takes — funny when the situation calls for it, sincere when it doesn't.

Your job: write ONE reply to the tweet that sounds like a human who actually has something to say — not generic AI mush. Engage with the topic on its own terms.

FORMAT — pick ONE of these two modes based on what the tweet calls for:

🟢 MODE A — ONE-LINE PUNCH (preferred when you have a sharp line)
- A single line. Tight, quotable, lands like a slap.
- No filler words, no preamble, no "haha so true". Just the punch.
- Use this when the joke or take fits in one breath.

🟡 MODE B — 3-4 LINE TAKE (when one line isn't enough)
- Open with a HOOK — a one-line statement, question, or observation that makes someone stop scrolling.
- Then 2-3 short lines that develop the angle: a specific detail, a comparison, a twist, or a punchline at the end.
- Use line breaks (actual newlines) between lines. Keep each line short.

ANTI-AI-SLOP RULES (CRITICAL — break these and the reply gets thrown out):
- ❌ NO "I totally understand", "I feel you", "absolutely", "great point", "well said", "💯", "this!"
- ❌ NO generic empathy ("must be tough", "hope it gets better soon")
- ❌ NO hedging ("kind of", "a bit", "I guess", "maybe", "in some ways")
- ❌ NO explaining your own joke or adding "lol/haha" after a punchline
- ❌ NO motivational closers, no life advice, no "stay strong"
- ❌ NO corporate softness — never sound like a customer support reply
- ✅ DO be specific (name the actual product, person, team, scheme, city, pattern)
- ✅ DO have a clear opinion or angle, not a neutral observation
- ✅ DO sound like one specific person, not a committee

RELEVANCE (CRITICAL): This account only sends a handful of replies a day — each one has to be worth it. Your reply must directly engage with what THIS tweet specifically says: react to, quote, or build on a concrete word, claim, number, or detail actually in the tweet text. Before you finalize, check — could this exact reply be dropped under a different tweet on the same general topic and still make sense? If yes, it's too generic. Rewrite it so it only works as a reply to this specific tweet.

CONTENT RULES:
- Make the SITUATION the joke, never the author or any group.
- No caste, religion, gender, region, class, appearance, disability, or political-party jabs.
- If the tweet is about grief, health, safety, harassment, abuse, or serious loss → drop ALL satire, be brief and kind. One line of human warmth.
- If it's a genuine question → answer it (with character, not as a help desk).
- Match the topic on its own terms — if it's about cricket, bring cricket; AI, bring AI; politics, bring politics. Do NOT pivot to Pune unless the tweet itself is about Pune.

HARD LIMITS:
- Maximum 280 characters total (including newlines).
- One-liners: aim for under 140 chars.
- Multi-line: each line short; total still under 280.
- Zero or one hashtag (prefer zero).
- No emojis unless the original tweet uses them — and even then, sparingly.
- No promotional language, no sales pitch, no link-dropping.

USING CONTEXT DATA:
If you are given a [CURRENT CONTEXT] block in the user message, it contains recent news and reporting relevant to the tweet. Use specific facts, numbers, or events from it to make your reply more grounded and timely — the kind of detail that makes a reply look like it came from someone actually paying attention. Do NOT name the publication, do NOT paste URLs, do NOT attribute quotes. Weave the facts in naturally.

LANGUAGE: Reply in sharp, polished English only. Do NOT reply in Marathi, Hindi, or any other language. Do NOT use Devanagari script or Roman-script Marathi — even if the original tweet is in another language, your reply is English.

OUTPUT: Return ONLY the reply text. No quotes around it, no "Here's a reply:", no explanation, no "Mode A" / "Mode B" label. Just the reply, exactly as it would appear on X.`;

function systemPrompt(
  tier: WitTier,
  classification: Classification | null,
  flavor: Flavor,
  stance: Stance | null = null,
  engagementMode: EngagementMode = 'NONE',
  baitStructure: BaitStructure | null = null,
): string {
  const base = flavor === 'pune' ? SYSTEM_PROMPT_PUNE : SYSTEM_PROMPT_GENERAL;
  const classificationGuidance = classificationGuidanceFor(classification);
  return [
    base,
    HUMAN_TEXTURE_RULES,
    witInstructions(tier, flavor),
    classificationGuidance,
    stanceGuidanceFor(stance),
    baitGuidanceFor(engagementMode, { structure: baitStructure ?? undefined }),
  ].filter(Boolean).join('\n\n');
}

/**
 * Reply framing for trend candidates.
 *
 * Appended to the base prompt, so it inherits the ANTI-AI-SLOP and content
 * rules rather than restating them. The contrarian block borrows the
 * quote-tweet framing — disagree with the claim, never the author — because
 * that's the difference between a take worth replying to and a fight.
 */
export function stanceGuidanceFor(stance: Stance | null): string {
  if (stance === 'CONTRARIAN') {
    return `STANCE: CONTRARIAN. The consensus in this thread is obvious — do not join it. Take the strongest honest position against the prevailing take, or name what everyone is missing.
- Argue with the CLAIM, never the author. No "you're wrong", no condescension, no "actually".
- One concrete reason, not a list. Specificity is the whole game.
- Never contrarian for its own sake — if the consensus is simply correct, find the unexamined cost or the second-order effect instead of denying the obvious.
- No sneering, no "everyone is stupid", no both-sidesing a settled fact.
- Never make the disagreement about identity, region, religion, caste, gender or party.`;
  }
  if (stance === 'ALIGNED') {
    return `STANCE: ALIGNED. Engage with the topic on its own terms. If you agree, agreement must carry a new detail, example or consequence — never a bare echo of what the post already said.`;
  }
  return '';
}

function classificationGuidanceFor(c: Classification | null): string {
  switch (c) {
    case 'NEWS':
      return 'AUTHOR CONTEXT: This is a NEWS account. Be factual and respectful. Add value (a question, local context, missing detail). Skip humour entirely on hard news.';
    case 'PARODY':
    case 'COMEDY':
      return 'AUTHOR CONTEXT: This is a PARODY/COMEDY account. Match their energy with playful banter. Riff on the joke; do not explain it.';
    case 'INFLUENCER':
      return 'AUTHOR CONTEXT: This is a high-following INFLUENCER. Be confident and concise — your reply competes for visibility. Add a fresh angle, not agreement.';
    case 'SERIOUS':
      return 'AUTHOR CONTEXT: This author is serious in tone. Default to substance. Keep wit minimal even if wit_level is high.';
    case 'BRAND_PROMO':
    case 'BOT':
      return 'AUTHOR CONTEXT: This author appears promotional/bot-like. Reply briefly, neutrally, or skip humour. Avoid sounding like an endorsement.';
    case 'REGULAR':
      return 'AUTHOR CONTEXT: This is a regular individual. Reply human-to-human, friendly.';
    default:
      return '';
  }
}

export interface GeneratedReply {
  text: string;
  contentStructure: ContentStructure;
  tournament?: {
    strategy: TournamentStrategy;
    angle: TournamentAngle | null;
    criticScore: number | null;
    criticReasons: string[];
  };
}

export async function generateReply(
  post: Post,
  authorAccount: Account | null = null,
  options: {
    avoidTexts?: string[];
    stance?: Stance | null;
    engagementMode?: EngagementMode | null;
  } = {},
): Promise<string> {
  const result = await generateReplyWithMeta(post, authorAccount, options);
  return result.text;
}

export async function generateReplyWithMeta(
  post: Post,
  authorAccount: Account | null = null,
  options: {
    avoidTexts?: string[];
    stance?: Stance | null;
    engagementMode?: EngagementMode | null;
  } = {},
): Promise<GeneratedReply> {
  const { level, tier } = readWitLevel();
  const classification = (authorAccount?.classification as Classification | null) ?? null;
  const flavor = pickFlavor(post.text);
  // Explicit option wins; otherwise fall back to whatever was persisted on the row.
  const stance = options.stance ?? post.stance ?? null;

  // Engagement bait: explicit option wins; else reuse a mode already written on
  // this row (retry drafts must not flip the quota decision); else allocate.
  // NEWS / SERIOUS authors and sensitive source text force NONE.
  const persistedMode = (getPost(post.id)?.engagement_mode
    ?? post.engagement_mode
    ?? null) as EngagementMode | null;
  let engagementMode: EngagementMode = options.engagementMode ?? persistedMode ?? 'NONE';
  if (!options.engagementMode && !persistedMode) {
    const blocked = isBlockedForBait(post.text)
      || classification === 'NEWS'
      || classification === 'SERIOUS';
    const decision = decideEngagementBait({
      targetPct: getEngagementBaitPct(),
      blocked,
      counts: getReplyBaitCountsToday(),
    });
    engagementMode = decision.mode;
    try {
      updatePostEngagementMode(post.id, engagementMode);
    } catch {
      // Synthetic posts in tests/scripts may not exist in DB.
    }
    logEvent(
      'ENGAGEMENT_BAIT_DECISION',
      `mode=${engagementMode} reason=${decision.reason}`,
      post.id,
    );
  } else if (engagementMode !== 'NONE' && isBlockedForBait(post.text)) {
    engagementMode = 'NONE';
  }

  const baitStructure = engagementMode !== 'NONE' ? pickBaitStructure() : null;
  const livePost = getPost(post.id);
  const tournament = allocateReplyTournament({
    blocked: tournamentSensitive(post.text)
      || classification === 'NEWS'
      || classification === 'SERIOUS',
    persistedStrategy: livePost?.tournament_strategy ?? post.tournament_strategy,
  });
  try {
    updatePostTournamentMeta(post.id, { strategy: tournament.strategy });
  } catch {
    // Synthetic posts in tests/scripts may not exist in DB.
  }
  if (tournament.strategy === 'TOURNAMENT') {
    logEvent('REPLY_TOURNAMENT_ASSIGNED', tournament.reason, post.id);
  }

  const candidateCount = tournament.strategy === 'TOURNAMENT'
    ? TOURNAMENT_ANGLES.length
    : Math.max(
      2,
      engagementMode !== 'NONE' ? getBaitCandidateCount() : 2,
    );
  const avoidTexts = options.avoidTexts ?? [];

  const contextBlock = await enrichPrompt({
    text: post.text,
    language: post.language,
    maxItems: 6,
    maxTokens: 800,
  });
  const memoryBlock = recallNeuralMemory(post.text, { maxItems: 3, maxChars: 900 });

  const likenessOpts = {
    engagementMode,
    flavor,
    avoidTexts,
  };

  const generateOne = async (
    attempt: number,
    extraAvoid: string[] = [],
    retryNote?: string,
    angle?: TournamentAngle,
  ): Promise<string> => {
    const userPrompt = buildUserPrompt(
      post,
      authorAccount,
      [contextBlock, memoryBlock].filter(Boolean).join('\n\n'),
      [...avoidTexts, ...extraAvoid],
      retryNote
        ?? (attempt > 1
          ? 'Your previous draft sounded too generic or engagement-farmy. Rewrite with a more natural, human voice.'
          : undefined),
    );

    const baseTemp = engagementMode !== 'NONE'
      ? 0.95
      : tier === 'SHARP' ? 0.95 : tier === 'WITTY' ? 0.9 : 0.8;
    const temp = candidateCount > 1
      ? baseTemp + (attempt - 1) * 0.04
      : baseTemp;

    const sysPrompt = [
      systemPrompt(
        tier, classification, flavor, stance, engagementMode, baitStructure,
      ),
      angle ? angleGuidanceFor(angle) : '',
    ].filter(Boolean).join('\n\n');
    logPromptToConsole(
      'REPLY',
      `${post.id} flavor=${flavor} stance=${stance ?? 'none'} bait=${engagementMode} attempt=${attempt}`,
      sysPrompt,
      userPrompt,
    );

    const rawReply = await generateText({
      taskName: 'generateReply',
      systemPrompt: sysPrompt,
      userPrompt,
      postId: post.id,
      groq: { maxTokens: 400, temperature: Math.min(temp, 0.98) },
      logContext: {
        witLevel: level,
        witTier: tier,
        flavor,
        classification: classification ?? 'unknown',
        attempt,
        candidateCount,
      },
      agenticRunner: attempt === 1
        ? () => generateReplyAgentic({
          postId: post.id,
          systemPrompt: sysPrompt,
          userPrompt,
          avoidTexts: [...avoidTexts, ...extraAvoid],
          stance,
        })
        : undefined,
    });

    let cleaned = cleanModelText(rawReply);
    cleaned = enforceCharacterLimit(cleaned, MAX_REPLY_CHARS);
    assertEnglishOnly(cleaned, 'Reply generation');
    return cleaned;
  };

  const angleByText = new Map<string, TournamentAngle>();
  const candidates: string[] = [];
  if (tournament.strategy === 'TOURNAMENT') {
    for (let i = 0; i < TOURNAMENT_ANGLES.length; i++) {
      const angle = TOURNAMENT_ANGLES[i];
      const text = await generateOne(i + 1, [], undefined, angle);
      candidates.push(text);
      angleByText.set(text, angle);
    }
  } else {
    for (let i = 1; i <= candidateCount; i++) {
      candidates.push(await generateOne(i));
    }
  }

  let picked = pickBestCandidate(candidates, likenessOpts);
  let humanIssue = checkHumanLikeness(picked.text, likenessOpts);

  if (humanIssue) {
    logger.warn('Reply failed human-likeness gate; regenerating once', {
      postId: post.id, reason: humanIssue,
    });
    const retry = await generateOne(candidateCount + 1, [picked.text]);
    const retryPicked = pickBestCandidate([picked.text, retry], likenessOpts);
    const retryIssue = checkHumanLikeness(retryPicked.text, likenessOpts);
    if (!retryIssue || humanLikenessScore(retryPicked.text, likenessOpts) > picked.score) {
      picked = retryPicked;
      humanIssue = retryIssue;
    }
  }

  if (humanIssue) {
    logger.warn('Reply still marginal after human-likeness retry', {
      postId: post.id, reason: humanIssue, reply: picked.text,
    });
  }

  const gravity = await applyConversationGravity({
    parentText: post.text,
    drafts: [...new Set([picked.text, ...candidates])],
    rewrite: async (reasons) => {
      const winningAngle = angleByText.get(picked.text);
      return generateOne(
        candidateCount + 2,
        [picked.text],
        `Previous draft scored low on conversation gravity (${reasons.slice(0, 3).join('; ')}). Add a concrete receipt the parent tweet lacks and one natural opening for the author to reply.`,
        winningAngle,
      );
    },
  });
  picked = {
    text: gravity.text,
    structure: detectContentStructure(gravity.text),
    score: picked.score,
  };
  const winningAngle = angleByText.get(picked.text)
    ?? angleByText.get(gravity.text)
    ?? (tournament.strategy === 'TOURNAMENT' ? TOURNAMENT_ANGLES[0] : null);

  logger.info('Reply generated', {
    postId: post.id,
    reply: picked.text,
    flavor,
    engagementMode,
    contentStructure: picked.structure,
    humanScore: picked.score,
    gravityScore: gravity.score,
    candidates: candidateCount,
    tournament: tournament.strategy,
    tournamentAngle: winningAngle,
  });

  const tournamentMeta = {
    strategy: tournament.strategy,
    angle: tournament.strategy === 'TOURNAMENT' ? winningAngle : null,
    criticScore: gravity.score,
    criticReasons: gravity.reasons,
  };
  try {
    updatePostTournamentMeta(post.id, tournamentMeta);
  } catch {
    // Synthetic posts in tests/scripts may not exist in DB.
  }

  return {
    text: picked.text,
    contentStructure: picked.structure,
    tournament: tournamentMeta,
  };
}

function buildUserPrompt(
  post: Post,
  account: Account | null,
  contextBlock = '',
  avoidTexts: string[] = [],
  humanRetryNote?: string,
): string {
  const ageMin = Math.round((Date.now() / 1000 - post.timestamp) / 60);

  const lines = [
    `Author: @${post.author_handle}`,
  ];
  if (account?.classification) {
    lines.push(`Author classification: ${account.classification} (confidence ${account.classification_confidence.toFixed(2)})`);
  }
  if (account?.bio) {
    lines.push(`Author bio: ${truncateForPrompt(account.bio, 220)}`);
  }
  lines.push(
    `Posted: ${ageMin} minutes ago`,
    `Likes: ${post.likes} | Replies: ${post.replies}`,
  );
  if (contextBlock) {
    lines.push('', contextBlock);
  }
  const winners = winnerExamplesBlock(3);
  if (winners) {
    lines.push('', winners);
  }
  if (avoidTexts.length > 0) {
    lines.push(
      '',
      'VARIETY REQUIREMENT: The previous draft was too similar to a recent reply.',
      'Use a genuinely different angle, sentence structure, and opening. Do not paraphrase these:',
      ...avoidTexts.slice(0, 8).map((text, i) => `${i + 1}. ${truncateForPrompt(text, 180)}`),
    );
  }
  if (humanRetryNote) {
    lines.push('', humanRetryNote);
  }
  lines.push('', 'Tweet:', post.text);

  return lines.join('\n');
}

function truncateForPrompt(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
