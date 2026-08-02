import { getRecentPosts, type Post, logEvent } from '../storage/queries.js';
import { enrichPrompt, isContextEnabled } from '../context/enrich.js';
import { recallNeuralMemory } from '../context/neural_memory.js';
import { detectTopics } from '../context/topics.js';
import { pickTopicAndCategory, type TopicCategory } from './topic_categories.js';
import { EmptyReplyError } from './errors.js';
import { logger } from '../utils/logger.js';
import { getGroqClient } from './groq_client.js';
import { logPromptToConsole } from './prompt_logger.js';
import { assertEnglishOnly, charLength, cleanModelText } from './text_constraints.js';
import { isClaudeAvailable, claudeGeneratorModel, generateWithClaude } from './claude_generator.js';
import { AGENTIC_MAX_ATTEMPTS, getAgenticModel, isAgenticGenerationEnabled, runGenerationAgent, type ValidationResult } from './agentic_generator.js';
import { getGroqModel } from '../config.js';
import {
  baitGuidanceFor, decideEngagementBait, getEngagementBaitPct, isBlockedForBait,
  type EngagementMode,
} from './engagement_bait.js';
import { getOriginalBaitCountsToday } from '../storage/original_posts.js';

const MAX_ORIGINAL_CHARS = 280;
const MAX_THREAD_PARTS = 3;
const MAX_THREAD_CHARS = MAX_ORIGINAL_CHARS * MAX_THREAD_PARTS;
const MAX_QUOTE_COMMENTARY_CHARS = 250;
const MAX_REPAIR_ATTEMPTS = 2;

export type PostLanguage = 'english';

export interface GeneratedOriginalPost {
  content: string;
  parts: string[];
  language: PostLanguage;
  topic: string;
  category: TopicCategory;
  researchContext: string;
  engagementMode?: EngagementMode;
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

  if (isContextEnabled()) {
    try {
      const enriched = await enrichPrompt({ text: topic, maxItems: 5, maxTokens: 600 });
      if (enriched) sections.push(enriched);
    } catch (err) {
      logger.warn('Context enrichment for original post failed; continuing', { err: String(err), topic });
    }
  }

  const memory = recallNeuralMemory(topic, { maxItems: 4, maxChars: 1100 });
  if (memory) sections.push(memory);

  if (sections.length === 0) {
    return { context: `No recent context available for "${topic}".`, snippets };
  }
  return { context: sections.join('\n\n'), snippets };
}

// ── Quality gate ──────────────────────────────────────────────────────────────

function qualityCheck(content: string): string | null {
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
  return category === 'local-pune' ? SYSTEM_BASE_PUNE : SYSTEM_BASE_GENERAL;
}

// ── Engagement farm ───────────────────────────────────────────────────────────

const ENGAGEMENT_FARM_SYSTEM = `You are a sharp-tongued Punekar with strong opinions posting on X (Twitter). You have hot takes and love a good debate. NOT a bot, NOT a brand — a real person who says what others are afraid to say about systems, incentives, and civic absurdity — never about identity.`;

const ENGAGEMENT_FARM_USER = `Write a single short X (Twitter) post that:
- Makes a provocative hot take on ONE safe topic: business/money, Pune civic life, traffic/metro, education/hiring, tech/startup theatre, housing costs
- Use either a CLICKBAIT curiosity gap ("The part about Hinjewadi salaries nobody says out loud:") OR a RAGEBAIT challenge ("Change my mind: X is the real reason Y is broken")
- The take can be edgy — controversial but not hateful, not about caste/religion/gender/region-as-insult
- Ends with an open question that invites people to reply and debate
- Write entirely in sharp, polished English. No Marathi, no Hindi, no Devanagari.
- Include 0-1 relevant hashtags
- Under 280 characters total
- NO "💯", NO motivational openers like "In today's world", NO "food for thought"
- Sound like a real Punekar venting, not an AI

Reply with ONLY the tweet text, nothing else.`;

const ENGAGEMENT_FARM_STRATEGIC_USER = `Write a single short X (Twitter) post that:
- Makes a provocative but fair hot take about how AI, automation, startup funding, hiring, or macro economy shifts are affecting Pune/Maharashtra
- Connects the take to a concrete local signal: Hinjewadi, Pune IT services, GCCs, founders, campus placements, salaries, housing, MSMEs, Chakan/MIDC, or Maharashtra policy
- Frame it as either a curiosity gap or a "change my mind" challenge so people reply
- Ends with an open question that invites people to reply and debate
- Write entirely in sharp, polished English. No Marathi, no Hindi, no Devanagari.
- Include zero or one relevant hashtag
- Under 280 characters total
- NO "💯", NO motivational openers like "In today's world", NO "food for thought"
- Sound like a real Punekar close to the tech ecosystem, not an AI
- Never punch on caste, religion, gender, or region-as-insult

Reply with ONLY the tweet text, nothing else.`;

const QUOTE_TWEET_SYSTEM = `You are a sharp, opinionated person quote-tweeting a post on X. Add a fresh angle, useful context, or a concise counterpoint. Do not merely agree, summarize, or restate the source. Never attack the author. Write polished English only and return only your commentary.`;

export async function generateQuoteTweetPost(
  source: Post,
  options: OriginalGenerationOptions = {},
): Promise<GeneratedOriginalPost> {
  const engagementMode = allocateOriginalBait({
    topicText: source.text,
    forcedMode: options.engagementMode,
  });
  const system = [QUOTE_TWEET_SYSTEM, baitGuidanceFor(engagementMode)].filter(Boolean).join('\n\n');
  const groqModel = getGroqModel();
  const client = getGroqClient();
  const basePrompt = [
    `Source author: @${source.author_handle}`,
    `Source engagement: ${source.likes} likes, ${source.replies} replies, ${source.retweets} reposts`,
    '',
    'Source post:',
    source.text,
    '',
    `Write quote-tweet commentary under ${MAX_QUOTE_COMMENTARY_CHARS} characters.`,
    'Do not include the source URL; X will attach the quoted post automatically.',
  ].join('\n');
  const userPrompt = appendAvoidancePrompt(basePrompt, options.avoidTexts);

  logPromptToConsole('QUOTE_TWEET', `${source.tweet_id} bait=${engagementMode}`, system, userPrompt);

  let raw = '';

  // ── Claude (primary) ─────────────────────────────────────────────────────────
  if (isClaudeAvailable()) {
    const claudeModel = claudeGeneratorModel();
    logEvent('CLAUDE_GENERATION_START', `model=${claudeModel} fn=generateQuoteTweetPost tweetId=${source.tweet_id}`);
    logger.info('Trying Claude for quote tweet generation', { model: claudeModel, tweetId: source.tweet_id, engagementMode });
    try {
      const result = await generateWithClaude(system, userPrompt);
      const text = result.text.trim();
      if (text.length >= 10) {
        logEvent('CLAUDE_GENERATION_SUCCESS', `model=${claudeModel} in=${result.inputTokens} out=${result.outputTokens} chars=${text.length}`);
        logger.info('Claude quote tweet generated', { inputTokens: result.inputTokens, outputTokens: result.outputTokens });
        raw = text;
      } else {
        logEvent('CLAUDE_GENERATION_FAILED', `response too short (${text.length} chars) — triggering Groq fallback fn=generateQuoteTweetPost`);
        logger.warn('Claude returned short/empty for quote tweet, falling back to Groq', { textLen: text.length });
      }
    } catch (err) {
      logEvent('CLAUDE_GENERATION_FAILED', `error: ${String(err)} — triggering Groq fallback fn=generateQuoteTweetPost`);
      logger.warn('Claude threw for quote tweet, falling back to Groq', { err: String(err) });
    }
  }

  // ── Groq (fallback) ──────────────────────────────────────────────────────────
  if (!raw) {
    logEvent('GROQ_FALLBACK_START', `model=${groqModel} fn=generateQuoteTweetPost tweetId=${source.tweet_id}`);
    logger.info('Calling Groq for quote tweet generation', { model: groqModel, tweetId: source.tweet_id });
    try {
      const completion = await client.chat.completions.create({
        model: groqModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userPrompt },
        ],
        max_completion_tokens: 1000,
        temperature: engagementMode === 'NONE' ? 0.85 : 0.95,
        top_p: 0.95,
      } as any);
      raw = (completion.choices[0]?.message?.content ?? '').trim();
      logEvent('GROQ_FALLBACK_SUCCESS', `model=${groqModel} chars=${raw.length}`);
      logger.info('Groq quote tweet generated', { chars: raw.length });
    } catch (err) {
      logEvent('GROQ_FALLBACK_FAILED', `error: ${String(err)} fn=generateQuoteTweetPost`);
      throw err;
    }
  }

  const cleaned = cleanModelText(raw);
  const chars = charLength(cleaned);
  if (chars === 0) throw new EmptyReplyError('Quote tweet returned empty reply');
  if (chars < 15 || chars > MAX_QUOTE_COMMENTARY_CHARS) {
    throw new Error(`Quote tweet commentary failed length check: ${chars} chars`);
  }
  assertEnglishOnly(cleaned, 'Quote tweet');

  return {
    content: cleaned,
    parts: [cleaned],
    language: 'english',
    topic: `quote:${detectTopicsForQuote(source.text)}`,
    category: 'observation',
    researchContext: source.text,
    engagementMode,
  };
}

export async function generateEngagementFarmPost(
  options: OriginalGenerationOptions = {},
): Promise<GeneratedOriginalPost> {
  // Farms are the dedicated bait slots — always count toward the 30% quota.
  const engagementMode = allocateOriginalBait({
    topicText: 'pune tech civic engagement farm',
    forceBait: true,
    forcedMode: options.engagementMode,
  });
  const system = [ENGAGEMENT_FARM_SYSTEM, baitGuidanceFor(engagementMode)].filter(Boolean).join('\n\n');
  const groqModel = getGroqModel();
  const client = getGroqClient();
  const strategic = Math.random() < 0.40;
  const baseUserPrompt = strategic ? ENGAGEMENT_FARM_STRATEGIC_USER : ENGAGEMENT_FARM_USER;
  const userPrompt = appendAvoidancePrompt(baseUserPrompt, options.avoidTexts);

  logger.info('Generating engagement farm post', { strategic, engagementMode });
  logPromptToConsole('ENGAGEMENT_FARM', `${strategic ? 'strategic' : 'hot-take'} bait=${engagementMode}`, system, userPrompt);

  let raw = '';

  // ── Claude (primary) ─────────────────────────────────────────────────────────
  if (isClaudeAvailable()) {
    const claudeModel = claudeGeneratorModel();
    logEvent('CLAUDE_GENERATION_START', `model=${claudeModel} fn=generateEngagementFarmPost strategic=${strategic}`);
    logger.info('Trying Claude for engagement farm post', { model: claudeModel, strategic });
    try {
      const result = await generateWithClaude(system, userPrompt);
      const text = result.text.trim();
      if (text.length >= 10) {
        logEvent('CLAUDE_GENERATION_SUCCESS', `model=${claudeModel} in=${result.inputTokens} out=${result.outputTokens} chars=${text.length}`);
        logger.info('Claude engagement farm post generated', { inputTokens: result.inputTokens, outputTokens: result.outputTokens, strategic });
        raw = text;
      } else {
        logEvent('CLAUDE_GENERATION_FAILED', `response too short (${text.length} chars) — triggering Groq fallback fn=generateEngagementFarmPost`);
        logger.warn('Claude returned short/empty for engagement farm, falling back to Groq', { textLen: text.length });
      }
    } catch (err) {
      logEvent('CLAUDE_GENERATION_FAILED', `error: ${String(err)} — triggering Groq fallback fn=generateEngagementFarmPost`);
      logger.warn('Claude threw for engagement farm, falling back to Groq', { err: String(err) });
    }
  }

  // ── Groq (fallback) ──────────────────────────────────────────────────────────
  if (!raw) {
    logEvent('GROQ_FALLBACK_START', `model=${groqModel} fn=generateEngagementFarmPost strategic=${strategic}`);
    logger.info('Calling Groq for engagement farm post', { model: groqModel, strategic });
    try {
      const completion = await client.chat.completions.create({
        model: groqModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userPrompt },
        ],
        max_completion_tokens: 6000,
        temperature: 0.95,
        top_p: 0.95,
      } as any);
      raw = (completion.choices[0]?.message?.content ?? '').trim();
      logEvent('GROQ_FALLBACK_SUCCESS', `model=${groqModel} chars=${raw.length}`);
      logger.info('Groq engagement farm post generated', { chars: raw.length });
    } catch (err) {
      logEvent('GROQ_FALLBACK_FAILED', `error: ${String(err)} fn=generateEngagementFarmPost`);
      throw err;
    }
  }

  const cleaned = cleanModelText(raw);
  const chars = charLength(cleaned);

  if (chars === 0) {
    logger.warn('Engagement farm: empty response, skipping this run');
    throw new EmptyReplyError('Engagement farm returned empty reply');
  }
  assertEnglishOnly(cleaned, 'Engagement farm');

  if (chars < 30 || chars > 280) {
    throw new Error(`Engagement farm post failed length check: ${chars} chars`);
  }

  logger.info('Engagement farm post generated', { chars, preview: cleaned.slice(0, 60), engagementMode });

  return {
    content: cleaned,
    parts: [cleaned],
    language: 'english',
    topic: strategic ? 'engagement-farm-pune-tech-economy' : 'engagement-farm',
    category: strategic ? 'pune-tech-economy' : 'observation',
    researchContext: '',
    engagementMode,
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

  const systemPrompt = [
    buildSystemPrompt(category),
    baitGuidanceFor(engagementMode),
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
    '',
    'Write the tweet now:',
  ].filter((l) => l !== undefined).join('\n'), options.avoidTexts);

  const groqModel = getGroqModel();
  const client = getGroqClient();

  logger.info('Generating original post', { topic, category, engagementMode });

  // ── Model call helper: agentic loop first (opt-in), then Claude, then Groq ─
  const callModel = async (sysPr: string, userPr: string): Promise<string> => {
    if (isAgenticGenerationEnabled()) {
      const agenticTask = {
        kind: 'post' as const,
        systemPrompt: sysPr,
        userPrompt: userPr,
        validate: (raw: string): ValidationResult => {
          const text = cleanModelText(raw);
          if (charLength(text) === 0) return { ok: false, reason: 'empty text' };
          const qError = qualityCheck(text);
          return qError ? { ok: false, reason: qError } : { ok: true, text };
        },
      };
      // Retry on the same model, then fall through to single-shot.
      const agModel = getAgenticModel();
      for (let attempt = 1; attempt <= AGENTIC_MAX_ATTEMPTS; attempt++) {
        try {
          return await runGenerationAgent(agenticTask, agModel);
        } catch (err) {
          logger.warn(`Agentic original post attempt ${attempt}/${AGENTIC_MAX_ATTEMPTS} failed (model=${agModel})`, { topic, err: String(err).slice(0, 200) });
        }
      }
      logger.warn('Agentic generation exhausted; falling back to single-shot', { topic });
    }

    if (isClaudeAvailable()) {
      const claudeModel = claudeGeneratorModel();
      logEvent('CLAUDE_GENERATION_START', `model=${claudeModel} fn=generateOriginalPost topic=${topic}`);
      logger.info('Trying Claude for original post generation', { model: claudeModel, topic, category });
      try {
        const result = await generateWithClaude(sysPr, userPr);
        const text = result.text.trim();
        if (text.length >= 10) {
          logEvent('CLAUDE_GENERATION_SUCCESS', `model=${claudeModel} in=${result.inputTokens} out=${result.outputTokens} topic=${topic}`);
          logger.info('Claude original post generated', { inputTokens: result.inputTokens, outputTokens: result.outputTokens, topic });
          return text;
        }
        logEvent('CLAUDE_GENERATION_FAILED', `response too short (${text.length} chars) — triggering Groq fallback fn=generateOriginalPost`);
        logger.warn('Claude returned short/empty for original post, falling back to Groq', { topic, textLen: text.length });
      } catch (err) {
        logEvent('CLAUDE_GENERATION_FAILED', `error: ${String(err)} — triggering Groq fallback fn=generateOriginalPost`);
        logger.warn('Claude threw for original post, falling back to Groq', { topic, err: String(err) });
      }
    }

    logEvent('GROQ_FALLBACK_START', `model=${groqModel} fn=generateOriginalPost topic=${topic}`);
    logger.info('Calling Groq for original post generation', { model: groqModel, topic, category });
    try {
      const completion = await client.chat.completions.create({
        model: groqModel,
        messages: [
          { role: 'system', content: sysPr },
          { role: 'user', content: userPr },
        ],
        max_completion_tokens: 6000,
        temperature: 0.85,
        top_p: 0.95,
      } as any);
      const raw = (completion.choices[0]?.message?.content ?? '').trim();
      logEvent('GROQ_FALLBACK_SUCCESS', `model=${groqModel} chars=${raw.length} topic=${topic}`);
      logger.info('Groq original post generated', { chars: raw.length, topic });
      return raw;
    } catch (err) {
      logEvent('GROQ_FALLBACK_FAILED', `error: ${String(err)} fn=generateOriginalPost topic=${topic}`);
      throw err;
    }
  };

  let cleaned = '';
  let lastQualityError: string | null = null;

  for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    const attemptPrompt = attempt === 1
      ? userPrompt
      : [
        userPrompt,
        '',
        `Previous draft failed quality check: ${lastQualityError}.`,
        `Rewrite it as one tweet or a 2-3 tweet thread. Keep every part within ${MAX_ORIGINAL_CHARS} characters and preserve the angle.`,
      ].join('\n');

    logPromptToConsole('ORIGINAL', `topic=${topic} cat=${category} bait=${engagementMode} attempt=${attempt}`, systemPrompt, attemptPrompt);
    const raw = await callModel(systemPrompt, attemptPrompt);
    cleaned = cleanModelText(raw);

    if (cleaned.length === 0) {
      lastQualityError = 'empty response';
      if (attempt < MAX_REPAIR_ATTEMPTS) continue;
      logger.warn('Original post: empty response, skipping this run', { topic, category });
      throw new EmptyReplyError('Original post returned empty reply');
    }

    const qError = qualityCheck(cleaned);
    if (!qError) {
      lastQualityError = null;
      break;
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
    topic, category, chars: charLength(cleaned), preview: cleaned.slice(0, 60), engagementMode,
  });

  assertEnglishOnly(cleaned, 'Original post');
  const parts = splitOriginalPostThread(cleaned);
  return {
    content: cleaned, parts, language: 'english', topic, category,
    researchContext: context, engagementMode,
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
