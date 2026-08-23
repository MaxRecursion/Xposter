import { getRecentPosts, type Post, logEvent } from '../storage/queries.js';
import { enrichPrompt } from '../context/enrich.js';
import { recallNeuralMemory } from '../context/neural_memory.js';
import { detectTopics } from '../context/topics.js';
import { pickTopicAndCategory, type TopicCategory } from './topic_categories.js';
import { EmptyReplyError } from './errors.js';
import { applyConversationGravity } from './conversation_gravity.js';
import { logger } from '../utils/logger.js';
import { logPromptToConsole } from './prompt_logger.js';
import { assertEnglishOnly, charLength, cleanModelText, fitToCharBudget } from './text_constraints.js';
import { type ValidationResult } from './agentic_generator.js';
import {
  baitGuidanceFor, decideEngagementBait, getEngagementBaitPct, isBlockedForBait,
  pickBaitStructure, type EngagementMode,
} from './engagement_bait.js';
import {
  checkHumanLikeness, getBaitCandidateCount, HUMAN_TEXTURE_RULES,
  humanLikenessScore, pickBestCandidate, detectContentStructure, type ContentStructure,
} from './human_likeness.js';
import { getOriginalBaitCountsToday } from '../storage/original_posts.js';
import { winnerExamplesBlock } from '../storage/engagement_performance.js';
import { generateText, type GroqCallOptions } from './llm_runner.js';

const MAX_ORIGINAL_CHARS = 280;
const MAX_THREAD_PARTS = 3;
const MAX_THREAD_CHARS = MAX_ORIGINAL_CHARS * MAX_THREAD_PARTS;
const MAX_QUOTE_COMMENTARY_CHARS = 250;
const MAX_REPAIR_ATTEMPTS = 2;
/**
 * A draft this far past its budget means the model answered a different
 * question — an essay, a preamble, a numbered list. Trimming that produces a
 * fragment, not a post, so those still fail.
 */
const MAX_SALVAGE_RATIO = 3;

export type PostLanguage = 'english';

export interface GeneratedOriginalPost {
  content: string;
  parts: string[];
  language: PostLanguage;
  topic: string;
  category: TopicCategory;
  researchContext: string;
  engagementMode?: EngagementMode;
  contentStructure?: ContentStructure;
}

export interface OriginalGenerationOptions {
  avoidTexts?: string[];
  /** Force a bait mode (used so retries don't flip the quota decision). */
  engagementMode?: EngagementMode;
}

function allocateOriginalBait(opts: {
  topicText: string;
  /** Engagement farms always count as bait. */
  forceBait?: boolean;
  forcedMode?: EngagementMode;
}): EngagementMode {
  if (opts.forcedMode) return opts.forcedMode;
  if (opts.forceBait) {
    const decision = decideEngagementBait({
      targetPct: 100,
      blocked: isBlockedForBait(opts.topicText),
      counts: { bait: 0, normal: 0 },
    });
    return decision.mode === 'NONE' ? 'RAGEBAIT' : decision.mode;
  }
  const decision = decideEngagementBait({
    targetPct: getEngagementBaitPct(),
    blocked: isBlockedForBait(opts.topicText),
    counts: getOriginalBaitCountsToday(),
  });
  logEvent('ENGAGEMENT_BAIT_DECISION', `kind=original mode=${decision.mode} reason=${decision.reason}`);
  return decision.mode;
}

// ── Research step ─────────────────────────────────────────────────────────────

/**
 * Gathers recent context for the topic from two sources:
 *   1. Timeline tweets ingested in the last 48h matching the topic substring.
 *   2. The real-time context store (RSS/Reddit/weather), if enabled — semantic
 *      retrieval against the topic phrase, ranked by recency × credibility.
 */
async function gatherResearchContext(topic: string): Promise<{ context: string; snippets: string[] }> {
  const recent = getRecentPosts(48);
  const topicLower = topic.toLowerCase();

  const matched = recent
    .filter((p) => p.text.toLowerCase().includes(topicLower))
    .sort((a, b) => (b.likes + b.replies * 2) - (a.likes + a.replies * 2))
    .slice(0, 6);

  const snippets = matched.map((p) => p.text.slice(0, 200));
  const sections: string[] = [];

  if (snippets.length > 0) {
    sections.push([
      `Recent tweets about "${topic}" (last 48h, sorted by engagement):`,
      ...snippets.map((s, i) => `${i + 1}. ${s}`),
    ].join('\n'));
  }

  try {
    const enriched = await enrichPrompt({ text: topic, maxItems: 5, maxTokens: 600 });
    if (enriched) sections.push(enriched);
  } catch (err) {
    logger.warn('Context enrichment for original post failed; continuing', { err: String(err), topic });
  }

  const memory = recallNeuralMemory(topic, { maxItems: 4, maxChars: 1100 });
  if (memory) sections.push(memory);

  if (sections.length === 0) {
    return { context: `No recent context available for "${topic}".`, snippets };
  }
  return { context: sections.join('\n\n'), snippets };
}

// ── Quality gate ──────────────────────────────────────────────────────────────

function qualityCheck(content: string, opts: { avoidTexts?: string[] } = {}): string | null {
  const chars = charLength(content);
  if (chars < 20) return `too short (${chars} chars)`;
  if (chars > MAX_THREAD_CHARS) return `too long for a 3-post thread (${chars} chars)`;
  if (/[ऀ-ॿ]/.test(content)) return 'contains Devanagari script despite English-only policy';
  const sentenceEnds = (content.match(/[.!?]/g) ?? []).length;
  if (sentenceEnds < 1) return 'no sentence-ending punctuation found';
  const parts = splitOriginalPostThread(content);
  if (parts.length > MAX_THREAD_PARTS) {
    return `needs ${parts.length} thread parts (maximum ${MAX_THREAD_PARTS})`;
  }
  if (parts.some((part) => charLength(part) > MAX_ORIGINAL_CHARS)) {
    return 'contains a thread part over 280 characters';
  }
  const humanIssue = checkHumanLikeness(content, { avoidTexts: opts.avoidTexts });
  if (humanIssue) return humanIssue;
  return null;
}

export function splitOriginalPostThread(content: string): string[] {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (charLength(normalized) <= MAX_ORIGINAL_CHARS) return [normalized];

  const sentences = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) ?? [normalized];
  const parts: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (charLength(candidate) <= MAX_ORIGINAL_CHARS) {
      current = candidate;
      continue;
    }

    if (current) {
      parts.push(current);
      current = '';
    }

    const chunks = splitAtWordBoundaries(sentence, MAX_ORIGINAL_CHARS);
    parts.push(...chunks.slice(0, -1));
    current = chunks.at(-1) ?? '';
  }

  if (current) parts.push(current);
  return parts;
}

function splitAtWordBoundaries(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  for (const word of words) {
    if (charLength(word) > maxChars) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      const chars = Array.from(word);
      while (chars.length > maxChars) {
        chunks.push(chars.splice(0, maxChars).join(''));
      }
      current = chars.join('');
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (charLength(candidate) <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    current = word;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function compactOriginalPostForX(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (charLength(normalized) <= MAX_ORIGINAL_CHARS) return normalized;

  const clipped = Array.from(normalized).slice(0, MAX_ORIGINAL_CHARS).join('');
  const lastSpace = clipped.lastIndexOf(' ');
  let out = lastSpace > 80 ? clipped.slice(0, lastSpace) : clipped;
  out = out.replace(/[\s,;:.-]+$/g, '').trim();

  out = ensureTerminalPunctuation(out);
  while (charLength(out) > MAX_ORIGINAL_CHARS) {
    const withoutPunctuation = out.replace(/[.!?]$/, '');
    const space = withoutPunctuation.lastIndexOf(' ');
    out = (space > 80 ? withoutPunctuation.slice(0, space) : withoutPunctuation)
      .replace(/[\s,;:.-]+$/g, '')
      .trim();
    out = ensureTerminalPunctuation(out);
  }

  return out;
}

function ensureTerminalPunctuation(text: string): string {
  if (/[.!?]$/.test(text)) return text;
  let out = text;
  if (charLength(out) >= MAX_ORIGINAL_CHARS) {
    out = Array.from(out)
      .slice(0, MAX_ORIGINAL_CHARS - 1)
      .join('')
      .replace(/[\s,;:.-]+$/g, '')
      .trim();
  }
  return `${out}.`;
}

// ── Prompts ───────────────────────────────────────────────────────────────────

const SHARED_RULES = `Hard limits:
- Return either one tweet (maximum 280 characters) or a 2-3 tweet thread
- For a thread, write continuous prose with sentence breaks; do not number the tweets
- Maximum 280 characters per tweet and 840 characters total
- Zero or one hashtag only (prefer zero)
- No emojis unless the topic strongly calls for it
- Do NOT start with "Just", "Thread:", "Hot take:", or "Unpopular opinion:"
- No promotional language

LANGUAGE: Write in sharp, polished English only. Do NOT write in Marathi, Hindi, or any other language. Do NOT use Devanagari script.

QUALITY BAR (CRITICAL): This account posts only twice a day — every post has to earn its place. Only write the tweet if you have a genuinely specific, non-obvious observation, argument, or piece of information about this exact topic. A post that could be written about the topic by anyone, at any time, with no research, is filler — do not write it. If you don't have something that clears that bar, reply with the single word SKIP instead of a mediocre post. SKIP is a better outcome than filler.

RETURN ONLY THE TWEET TEXT. No quotes, no preamble, no explanation.`;

const SYSTEM_BASE_PUNE = `You are a real person from Pune, Maharashtra posting original thoughts on X (Twitter).

Write ONE original tweet (not a reply). The tweet must:
- Be 3-4 sentences long
- End with a thought-provoking question OR an intriguing open statement that makes readers want to engage
- Be specific, opinionated, and local — mention Pune/Maharashtra details where natural
- Sound like a real, thinking Punekar, not a journalist or corporate bot
- Have a clear perspective or take, not neutral reporting

${SHARED_RULES}`;

const SYSTEM_BASE_PUNE_TECH_ECONOMY = `You are a real person from Pune, Maharashtra posting original thoughts on X (Twitter).

Write ONE original tweet (not a reply) about how technology, AI, startups, hiring, and the macro economy are changing life in Pune and Maharashtra. The tweet must:
- Be 3-4 sentences long
- Connect at least TWO layers: local Pune/Maharashtra signals, tech/AI/startups/jobs, and broader Indian macro economy
- End with a thought-provoking question OR an intriguing open statement that makes readers want to engage
- Sound like a real, thinking Punekar close to the tech ecosystem, not a journalist or corporate bot
- Have a clear perspective or take, not neutral reporting

${SHARED_RULES}`;

const SYSTEM_BASE_GENERAL = `You are a sharp, opinionated person posting original thoughts on X (Twitter). You are NOT an assistant, NOT a chatbot, NOT a brand voice. You're a real person with takes — funny when the situation calls for it, sincere when it doesn't.

Write ONE original tweet (not a reply). The tweet must:
- Be 3-4 sentences long
- End with a thought-provoking question OR an intriguing open statement that makes readers want to engage
- Have a clear perspective or take, not neutral reporting
- Sound like a real, thinking person, not a journalist or corporate bot
- Engage with the topic on its own terms (do NOT pivot to Pune unless the topic itself is local)

${SHARED_RULES}`;

function buildSystemPrompt(category: TopicCategory): string {
  if (category === 'pune-tech-economy') return SYSTEM_BASE_PUNE_TECH_ECONOMY;
  const base = category === 'local-pune' ? SYSTEM_BASE_PUNE : SYSTEM_BASE_GENERAL;
  return [base, HUMAN_TEXTURE_RULES].join('\n\n');
}

async function generateRankedBaitDraft(opts: {
  taskName: string;
  label: string;
  system: string;
  userPrompt: string;
  budget: CharBudget;
  groq: GroqCallOptions;
  engagementMode: EngagementMode;
  flavor?: 'pune' | 'general';
  avoidTexts?: string[];
  logContext?: Record<string, unknown>;
  onAttempt?: (attempt: number, prompt: string) => void;
  parentText: string;
}): Promise<{ text: string; contentStructure: ContentStructure }> {
  const candidateCount = opts.engagementMode !== 'NONE'
    ? Math.max(1, getBaitCandidateCount())
    : 1;
  const likenessOpts = {
    engagementMode: opts.engagementMode,
    flavor: opts.flavor ?? 'pune',
    avoidTexts: opts.avoidTexts ?? [],
  };
  const candidates: string[] = [];

  for (let i = 0; i < candidateCount; i++) {
    const temp = (opts.groq.temperature ?? 0.9) + i * 0.04;
    const text = await generateWithinBudget({
      ...opts,
      groq: { ...opts.groq, temperature: Math.min(temp, 0.98) },
      logContext: { ...opts.logContext, candidate: i + 1, candidateCount },
    });
    candidates.push(text);
  }

  let picked = pickBestCandidate(candidates, likenessOpts);
  let humanIssue = checkHumanLikeness(picked.text, likenessOpts);

  if (humanIssue) {
    const retry = await generateWithinBudget({
      ...opts,
      userPrompt: [
        opts.userPrompt,
        '',
        `Previous draft failed human-likeness check (${humanIssue}). Rewrite with a more natural voice.`,
        'Avoid engagement-farm openers and AI-slop phrases.',
      ].join('\n'),
      groq: { ...opts.groq, temperature: Math.min((opts.groq.temperature ?? 0.9) + 0.06, 0.98) },
      logContext: { ...opts.logContext, humanRetry: true },
    });
    const retryPicked = pickBestCandidate([picked.text, retry], likenessOpts);
    if (!checkHumanLikeness(retryPicked.text, likenessOpts)
      || humanLikenessScore(retryPicked.text, likenessOpts) > picked.score) {
      picked = retryPicked;
    }
  }

  const gravity = await applyConversationGravity({
    parentText: opts.parentText,
    drafts: [...new Set([picked.text, ...candidates])],
    rewrite: async (reasons) => generateWithinBudget({
      ...opts,
      userPrompt: [
        opts.userPrompt,
        '',
        `Previous draft scored low on conversation gravity (${reasons.slice(0, 3).join('; ')}).`,
        'Add one concrete receipt and a natural opening for someone to reply.',
      ].join('\n'),
      groq: { ...opts.groq, temperature: Math.min((opts.groq.temperature ?? 0.9) + 0.06, 0.98) },
      logContext: { ...opts.logContext, gravityRetry: true },
    }),
  });

  return {
    text: gravity.text,
    contentStructure: detectContentStructure(gravity.text),
  };
}

// ── Engagement farm ───────────────────────────────────────────────────────────

const ENGAGEMENT_FARM_SYSTEM = `You are a sharp-tongued Punekar with strong opinions posting on X (Twitter). You have hot takes and love a good debate. NOT a bot, NOT a brand — a real person who says what others are afraid to say about systems, incentives, and civic absurdity — never about identity.`;

const ENGAGEMENT_FARM_USER = `Write a single short X (Twitter) post that:
- Makes a provocative hot take on ONE safe topic: business/money, Pune civic life, traffic/metro, education/hiring, tech/startup theatre, housing costs
- Sound mid-conversation, not like a headline — curiosity or friction should feel organic, not labeled
- The take can be edgy — controversial but not hateful, not about caste/religion/gender/region-as-insult
- Ends with an open question or blunt statement that invites people to reply
- Write entirely in sharp, polished English. No Marathi, no Hindi, no Devanagari.
- Include 0-1 relevant hashtags
- Aim for 200-240 characters; 280 is a hard limit that must never be exceeded
- NO "💯", NO motivational openers like "In today's world", NO "food for thought", NO "Change my mind:", NO "The part about X:"
- Sound like a real Punekar venting, not an AI

Reply with ONLY the tweet text, nothing else.`;

const ENGAGEMENT_FARM_STRATEGIC_USER = `Write a single short X (Twitter) post that:
- Makes a provocative but fair hot take about how AI, automation, startup funding, hiring, or macro economy shifts are affecting Pune/Maharashtra
- Connects the take to a concrete local signal: Hinjewadi, Pune IT services, GCCs, founders, campus placements, salaries, housing, MSMEs, Chakan/MIDC, or Maharashtra policy
- Frame it as organic curiosity or blunt friction — no colon-title hooks, no "Change my mind:"
- Ends with an open question or statement that invites people to reply
- Write entirely in sharp, polished English. No Marathi, no Hindi, no Devanagari.
- Include zero or one relevant hashtag
- Aim for 200-240 characters; 280 is a hard limit that must never be exceeded
- NO "💯", NO motivational openers like "In today's world", NO "food for thought"
- Sound like a real Punekar close to the tech ecosystem, not an AI
- Never punch on caste, religion, gender, or region-as-insult

Reply with ONLY the tweet text, nothing else.`;

const QUOTE_TWEET_SYSTEM = `You are a sharp, opinionated person quote-tweeting a post on X. Add a fresh angle, useful context, or a concise counterpoint. Do not merely agree, summarize, or restate the source. Never attack the author. Write polished English only and return only your commentary.`;

async function generatePostText(opts: {
  taskName: string;
  system: string;
  userPrompt: string;
  groq: GroqCallOptions;
  agenticTask?: {
    validate: (raw: string) => ValidationResult;
  };
  logContext?: Record<string, unknown>;
}): Promise<string> {
  return generateText({
    taskName: opts.taskName,
    systemPrompt: opts.system,
    userPrompt: opts.userPrompt,
    groq: opts.groq,
    logContext: opts.logContext,
    agenticTask: opts.agenticTask
      ? {
          kind: 'post',
          systemPrompt: opts.system,
          userPrompt: opts.userPrompt,
          validate: opts.agenticTask.validate,
        }
      : undefined,
  });
}

interface CharBudget {
  min: number;
  max: number;
}

/**
 * Generates a single-tweet post, re-prompting when the draft misses its
 * character budget and trimming as a last resort.
 *
 * The original-post path has always re-prompted on a failed quality gate, but
 * farms and quote tweets took the first draft and threw — and an overshoot of
 * twenty characters burned the scheduled slot for the day (two reschedules,
 * then ERROR). Both now get told exactly how far over they went, and a draft
 * that survives the retries is trimmed rather than thrown away.
 */
async function generateWithinBudget(opts: {
  taskName: string;
  /** Prefixes the thrown error and log lines, e.g. "Engagement farm post". */
  label: string;
  system: string;
  userPrompt: string;
  budget: CharBudget;
  groq: GroqCallOptions;
  logContext?: Record<string, unknown>;
  onAttempt?: (attempt: number, prompt: string) => void;
}): Promise<string> {
  const { budget, label } = opts;

  // Also handed to the agentic runner so it self-corrects before we see the text.
  const validate = (raw: string): ValidationResult => {
    const text = cleanModelText(raw);
    const chars = charLength(text);
    if (chars === 0) return { ok: false, reason: 'empty text' };
    if (chars < budget.min) return { ok: false, reason: `too short (${chars} chars, minimum ${budget.min})` };
    if (chars > budget.max) return { ok: false, reason: `too long (${chars} chars, maximum ${budget.max})` };
    return { ok: true, text };
  };

  let lastDraft = '';
  let lastReason = '';

  for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    const prompt = attempt === 1
      ? opts.userPrompt
      : [
        opts.userPrompt,
        '',
        `Your previous draft was rejected: ${lastReason}.`,
        `Rewrite it as ONE post of at most ${budget.max} characters.`,
        'Keep the angle, the voice, and the closing question — cut the setup and the description, not the hook.',
      ].join('\n');

    opts.onAttempt?.(attempt, prompt);

    let cleaned: string;
    try {
      cleaned = cleanModelText(await generatePostText({
        taskName: opts.taskName,
        system: opts.system,
        userPrompt: prompt,
        groq: opts.groq,
        logContext: { ...opts.logContext, attempt },
        agenticTask: { validate },
      }));
    } catch (err) {
      // An empty provider response is worth one more roll, not an immediate skip.
      if (!(err instanceof EmptyReplyError)) throw err;
      lastReason = 'empty response';
      continue;
    }

    const verdict = validate(cleaned);
    if (verdict.ok) return verdict.text;

    lastDraft = cleaned;
    lastReason = verdict.reason;
    logger.warn(`${label} draft rejected`, {
      ...opts.logContext, attempt, reason: verdict.reason, chars: charLength(cleaned),
    });
  }

  if (!lastDraft) throw new EmptyReplyError(`${label} returned empty reply`);

  const chars = charLength(lastDraft);
  if (chars <= budget.max * MAX_SALVAGE_RATIO) {
    const salvaged = fitToCharBudget(lastDraft, budget.max, budget.min);
    if (salvaged) {
      logEvent('POST_LENGTH_SALVAGED', `${label}: ${chars} → ${charLength(salvaged)} chars (max ${budget.max})`);
      logger.warn(`${label} trimmed to fit after repair attempts`, {
        ...opts.logContext, from: chars, to: charLength(salvaged), max: budget.max,
      });
      return salvaged;
    }
  }

  throw new Error(`${label} failed length check: ${chars} chars`);
}

export async function generateQuoteTweetPost(
  source: Post,
  options: OriginalGenerationOptions = {},
): Promise<GeneratedOriginalPost> {
  const engagementMode = allocateOriginalBait({
    topicText: source.text,
    forcedMode: options.engagementMode,
  });
  const baitStructure = engagementMode !== 'NONE' ? pickBaitStructure() : undefined;
  const system = [
    QUOTE_TWEET_SYSTEM,
    HUMAN_TEXTURE_RULES,
    baitGuidanceFor(engagementMode, { structure: baitStructure }),
  ].filter(Boolean).join('\n\n');
  const basePrompt = [
    `Source author: @${source.author_handle}`,
    `Source engagement: ${source.likes} likes, ${source.replies} replies, ${source.retweets} reposts`,
    '',
    'Source post:',
    source.text,
    '',
    `Write quote-tweet commentary of about 180 characters — ${MAX_QUOTE_COMMENTARY_CHARS} is a hard limit, never exceed it.`,
    'Do not include the source URL; X will attach the quoted post automatically.',
  ].join('\n');
  const userPrompt = appendAvoidancePrompt(basePrompt, options.avoidTexts);

  const ranked = await generateRankedBaitDraft({
    taskName: 'generateQuoteTweetPost',
    label: 'Quote tweet commentary',
    system,
    userPrompt,
    budget: { min: 15, max: MAX_QUOTE_COMMENTARY_CHARS },
    groq: {
      maxCompletionTokens: 1000,
      temperature: engagementMode === 'NONE' ? 0.85 : 0.95,
    },
    engagementMode,
    flavor: 'general',
    avoidTexts: options.avoidTexts,
    logContext: { tweetId: source.tweet_id, engagementMode },
    onAttempt: (attempt, prompt) => logPromptToConsole(
      'QUOTE_TWEET',
      `${source.tweet_id} bait=${engagementMode} attempt=${attempt}`,
      system,
      prompt,
    ),
    parentText: source.text,
  });
  const cleaned = ranked.text;

  assertEnglishOnly(cleaned, 'Quote tweet');

  return {
    content: cleaned,
    parts: [cleaned],
    language: 'english',
    topic: `quote:${detectTopicsForQuote(source.text)}`,
    category: 'observation',
    researchContext: source.text,
    engagementMode,
    contentStructure: ranked.contentStructure,
  };
}

export async function generateEngagementFarmPost(
  options: OriginalGenerationOptions = {},
): Promise<GeneratedOriginalPost> {
  // Farms are the dedicated bait slots — always count toward the bait quota.
  const engagementMode = allocateOriginalBait({
    topicText: 'pune tech civic engagement farm',
    forceBait: true,
    forcedMode: options.engagementMode,
  });
  const baitStructure = pickBaitStructure();
  const system = [
    ENGAGEMENT_FARM_SYSTEM,
    HUMAN_TEXTURE_RULES,
    baitGuidanceFor(engagementMode, { structure: baitStructure }),
  ].filter(Boolean).join('\n\n');
  const strategic = Math.random() < 0.40;
  const baseUserPrompt = strategic ? ENGAGEMENT_FARM_STRATEGIC_USER : ENGAGEMENT_FARM_USER;
  const userPrompt = appendAvoidancePrompt(baseUserPrompt, options.avoidTexts);

  logger.info('Generating engagement farm post', { strategic, engagementMode });

  const ranked = await generateRankedBaitDraft({
    taskName: 'generateEngagementFarmPost',
    label: 'Engagement farm post',
    system,
    userPrompt,
    budget: { min: 30, max: MAX_ORIGINAL_CHARS },
    groq: { maxCompletionTokens: 6000, temperature: 0.95 },
    engagementMode,
    flavor: 'pune',
    avoidTexts: options.avoidTexts,
    logContext: { strategic, engagementMode },
    onAttempt: (attempt, prompt) => logPromptToConsole(
      'ENGAGEMENT_FARM',
      `${strategic ? 'strategic' : 'hot-take'} bait=${engagementMode} attempt=${attempt}`,
      system,
      prompt,
    ),
    parentText: baseUserPrompt,
  });
  const cleaned = ranked.text;

  assertEnglishOnly(cleaned, 'Engagement farm');

  logger.info('Engagement farm post generated', {
    chars: charLength(cleaned), preview: cleaned.slice(0, 60), engagementMode,
    contentStructure: ranked.contentStructure,
  });

  return {
    content: cleaned,
    parts: [cleaned],
    language: 'english',
    topic: strategic ? 'engagement-farm-pune-tech-economy' : 'engagement-farm',
    category: strategic ? 'pune-tech-economy' : 'observation',
    researchContext: '',
    engagementMode,
    contentStructure: ranked.contentStructure,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateOriginalPost(
  options: OriginalGenerationOptions = {},
): Promise<GeneratedOriginalPost> {
  const { topic, category } = pickTopicAndCategory();
  const { context, snippets } = await gatherResearchContext(topic);
  const engagementMode = allocateOriginalBait({
    topicText: `${topic} ${context.slice(0, 400)}`,
    forcedMode: options.engagementMode,
  });

  const baitStructure = engagementMode !== 'NONE' ? pickBaitStructure() : undefined;
  const systemPromptText = [
    buildSystemPrompt(category),
    baitGuidanceFor(engagementMode, { structure: baitStructure }),
  ].filter(Boolean).join('\n\n');

  const userPrompt = appendAvoidancePrompt([
    `Category: ${category}`,
    `Topic: ${topic}`,
    '',
    'Research context (recent conversation around this topic):',
    context,
    '',
    snippets.length > 0
      ? 'Important: Do NOT repeat ideas already in the context. Bring a fresh angle.'
      : '',
    winnerExamplesBlock(3),
    '',
    'Write the tweet now:',
  ].filter((l) => l !== undefined).join('\n'), options.avoidTexts);

  logger.info('Generating original post', { topic, category, engagementMode });

  const candidateCount = Math.max(
    2,
    engagementMode !== 'NONE' ? getBaitCandidateCount() : 2,
  );
  const likenessOpts = {
    engagementMode,
    flavor: category === 'local-pune' || category === 'pune-tech-economy' ? 'pune' as const : 'general' as const,
    avoidTexts: options.avoidTexts ?? [],
  };

  const callModel = async (sysPr: string, userPr: string, temp = 0.85): Promise<string> => generatePostText({
    taskName: 'generateOriginalPost',
    system: sysPr,
    userPrompt: userPr,
    groq: { maxCompletionTokens: 6000, temperature: temp },
    logContext: { topic, category },
    agenticTask: {
      validate: (raw: string): ValidationResult => {
        const text = cleanModelText(raw);
        if (charLength(text) === 0) return { ok: false, reason: 'empty text' };
        const qError = qualityCheck(text, { avoidTexts: likenessOpts.avoidTexts });
        return qError ? { ok: false, reason: qError } : { ok: true, text };
      },
    },
  });

  let cleaned = '';
  let lastQualityError: string | null = null;
  let contentStructure: ContentStructure = 'standard';

  for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    const attemptPrompt = attempt === 1
      ? userPrompt
      : [
        userPrompt,
        '',
        `Previous draft failed quality check: ${lastQualityError}.`,
        `Rewrite it as one tweet or a 2-3 tweet thread. Keep every part within ${MAX_ORIGINAL_CHARS} characters and preserve the angle.`,
      ].join('\n');

    const candidates: string[] = [];
    for (let c = 0; c < candidateCount; c++) {
      logPromptToConsole(
        'ORIGINAL',
        `topic=${topic} cat=${category} bait=${engagementMode} attempt=${attempt} candidate=${c + 1}`,
        systemPromptText,
        attemptPrompt,
      );
      const raw = await callModel(systemPromptText, attemptPrompt, 0.85 + c * 0.04);
      const draft = cleanModelText(raw);
      if (draft.length > 0 && !/^skip$/i.test(draft.trim())) candidates.push(draft);
    }

    if (candidates.length === 0) {
      lastQualityError = 'empty response';
      if (attempt < MAX_REPAIR_ATTEMPTS) continue;
      logger.info('Original post: model found nothing worth posting, skipping this slot', { topic, category });
      throw new EmptyReplyError('Original post returned empty reply');
    }

    const picked = pickBestCandidate(candidates, likenessOpts);
    cleaned = picked.text;
    contentStructure = picked.structure;

    const qError = qualityCheck(cleaned, { avoidTexts: likenessOpts.avoidTexts });
    if (!qError) {
      try {
        const gravity = await applyConversationGravity({
          parentText: `${topic}\n${context.slice(0, 400)}`,
          drafts: [cleaned, ...candidates],
          rewrite: async (reasons) => cleanModelText(await callModel(
            systemPromptText,
            [
              attemptPrompt,
              '',
              `Previous draft scored low on conversation gravity (${reasons.slice(0, 3).join('; ')}).`,
              'Add one concrete receipt and a natural opening for someone to reply.',
            ].join('\n'),
            0.9,
          )),
        });
        cleaned = gravity.text;
        contentStructure = detectContentStructure(cleaned);
        lastQualityError = null;
        break;
      } catch (err) {
        lastQualityError = err instanceof Error ? err.message : String(err);
        logger.warn('Original post failed conversation gravity', {
          topic, category, attempt, error: lastQualityError,
        });
        if (attempt < MAX_REPAIR_ATTEMPTS) continue;
        throw err;
      }
    }

    lastQualityError = qError;
    logger.warn('Original post draft failed quality check', {
      topic, category, attempt, qualityError: qError, chars: charLength(cleaned),
    });
  }

  if (lastQualityError) {
    throw new Error(`Original post failed quality check: ${lastQualityError}`);
  }

  logger.info('Original post generated', {
    topic, category, chars: charLength(cleaned), preview: cleaned.slice(0, 60),
    engagementMode, contentStructure,
  });

  assertEnglishOnly(cleaned, 'Original post');
  const parts = splitOriginalPostThread(cleaned);
  return {
    content: cleaned, parts, language: 'english', topic, category,
    researchContext: context, engagementMode, contentStructure,
  };
}

function appendAvoidancePrompt(prompt: string, avoidTexts: string[] = []): string {
  if (avoidTexts.length === 0) return prompt;
  return [
    prompt,
    '',
    'VARIETY REQUIREMENT: The previous draft was too similar to a recent post.',
    'Choose a different angle, opening, and sentence structure. Do not paraphrase these:',
    ...avoidTexts.slice(0, 8).map((text, i) => `${i + 1}. ${text.slice(0, 180)}`),
  ].join('\n');
}

function detectTopicsForQuote(text: string): string {
  return detectTopics(text).slice(0, 3).join('+') || 'trending';
}
