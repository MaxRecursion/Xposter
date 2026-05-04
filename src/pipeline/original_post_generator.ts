import Groq from 'groq-sdk';
import { getSetting, getRecentPosts, logEvent } from '../storage/queries.js';
import { enrichPrompt, isContextEnabled } from '../context/enrich.js';
import { pickTopicAndCategory, type TopicCategory } from './topic_categories.js';
import { EmptyReplyError } from './errors.js';
import { logger } from '../utils/logger.js';

let _groq: Groq | null = null;

function getGroqClient(): Groq {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set');
  if (!_groq) _groq = new Groq({ apiKey });
  return _groq;
}

export type PostLanguage = 'english' | 'marathi';

export interface GeneratedOriginalPost {
  content: string;
  language: PostLanguage;
  topic: string;
  category: TopicCategory;
  researchContext: string;
}

// ── Language selection ────────────────────────────────────────────────────────

/**
 * Marathi only fits well for local-pune and culture topics. Forcing Marathi on
 * a tech / politics / sports / observation tweet produces awkward bookish text
 * the bot's audience won't engage with.
 */
function pickLanguage(category: TopicCategory): PostLanguage {
  if (category !== 'local-pune' && category !== 'culture') return 'english';
  const ratio = parseInt(getSetting('original_post_marathi_ratio', '40'), 10);
  const safeRatio = Math.min(100, Math.max(0, Number.isFinite(ratio) ? ratio : 40));
  return Math.random() * 100 < safeRatio ? 'marathi' : 'english';
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

  if (sections.length === 0) {
    return { context: `No recent context available for "${topic}".`, snippets };
  }
  return { context: sections.join('\n\n'), snippets };
}

// ── Quality gate ──────────────────────────────────────────────────────────────

function logPromptToConsole(kind: string, id: string, system: string, user: string): void {
  if (process.env.LOG_PROMPTS === 'false') return;
  const line = '─'.repeat(72);
  process.stdout.write(
    `\n${line}\n┃ GROQ ${kind} PROMPT  ${id}\n${line}\n` +
    `── SYSTEM ──\n${system}\n` +
    `── USER ──\n${user}\n${line}\n\n`,
  );
  logEvent('GROQ_PROMPT', `[${kind}] ${id} | ${user.slice(0, 500)}`);
}

function qualityCheck(content: string, language: PostLanguage): string | null {
  const chars = Array.from(content).length;
  if (chars < 20) return `too short (${chars} chars)`;
  if (chars > 280) return `too long (${chars} chars)`;
  if (language === 'marathi' && !/[ऀ-ॿ]/.test(content)) return 'requested Marathi but no Devanagari found';
  const sentenceEnds = (content.match(/[.!?।॥]/g) ?? []).length;
  if (sentenceEnds < 1) return 'no sentence-ending punctuation found';
  return null;
}

// ── Prompts ───────────────────────────────────────────────────────────────────

const SHARED_RULES = `Hard limits:
- Maximum 280 characters total
- Zero or one hashtag only (prefer zero)
- No emojis unless the topic strongly calls for it
- Do NOT start with "Just", "Thread:", "Hot take:", or "Unpopular opinion:"
- No promotional language

RETURN ONLY THE TWEET TEXT. No quotes, no preamble, no explanation.`;

const SYSTEM_BASE_PUNE = `You are a real person from Pune, Maharashtra posting original thoughts on X (Twitter).

Write ONE original tweet (not a reply). The tweet must:
- Be 3-4 sentences long
- End with a thought-provoking question OR an intriguing open statement that makes readers want to engage
- Be specific, opinionated, and local — mention Pune/Maharashtra details where natural
- Sound like a real, thinking Punekar, not a journalist or corporate bot
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

const MARATHI_LANG = `
LANGUAGE: Write entirely in Marathi using Devanagari script (देवनागरी).
Use natural, colloquial Puneri Marathi — conversational, not bookish.
Do NOT write in English or Roman/Latin script.`;

const ENGLISH_LANG = `
LANGUAGE: Write in natural, conversational English.`;

function buildSystemPrompt(category: TopicCategory, language: PostLanguage): string {
  const base = category === 'local-pune' ? SYSTEM_BASE_PUNE : SYSTEM_BASE_GENERAL;
  return base + (language === 'marathi' ? MARATHI_LANG : ENGLISH_LANG);
}

// ── Engagement farm ───────────────────────────────────────────────────────────

const ENGAGEMENT_FARM_SYSTEM = `You are a sharp-tongued Punekar with strong opinions posting on X (Twitter). You have hot takes and love a good debate. NOT a bot, NOT a brand — a real person who says what others are afraid to say.`;

const ENGAGEMENT_FARM_USER = `Write a single short X (Twitter) post that:
- Makes a provocative hot take on ONE of these topics: business/money, politics, Pune life, social norms, education, tech/startup
- The "fact" can be edgy or grey-area (controversial but not hateful)
- Ends with an open question that invites people to reply and debate
- 60% chance: write entirely in Marathi (Devanagari script). 40% chance: write in English.
- Include 1-2 relevant hashtags
- Under 280 characters total
- NO "💯", NO motivational openers like "In today's world", NO "food for thought"
- Sound like a real Punekar venting, not an AI

Reply with ONLY the tweet text, nothing else.`;

export async function generateEngagementFarmPost(): Promise<GeneratedOriginalPost> {
  const model = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';
  const client = getGroqClient();

  logger.info('Generating engagement farm post', { model });

  let content = '';
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt === 1) logPromptToConsole('ENGAGEMENT_FARM', 'hot-take', ENGAGEMENT_FARM_SYSTEM, ENGAGEMENT_FARM_USER);
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: ENGAGEMENT_FARM_SYSTEM },
        { role: 'user', content: ENGAGEMENT_FARM_USER },
      ],
      max_completion_tokens: 6000,
      temperature: 0.95,
      top_p: 0.95,
      reasoning_effort: 'high',
    } as any);

    const raw = (completion.choices[0]?.message?.content ?? '').trim();
    const cleaned = raw.replace(/^["']|["']$/g, '').trim();
    const chars = Array.from(cleaned).length;

    if (chars === 0) {
      logger.warn('Engagement farm: empty response, skipping this run', { attempt });
      throw new EmptyReplyError('Engagement farm returned empty reply');
    }

    if (chars >= 30 && chars <= 280) {
      content = cleaned;
      break;
    }
    lastError = `length check failed: ${chars} chars`;
    logger.warn('Engagement farm quality check failed', { attempt, chars });
  }

  if (!content) {
    throw new Error(`Could not generate engagement farm post after 3 attempts. Last error: ${lastError}`);
  }

  const hasDevanagari = /[ऀ-ॿ]/.test(content);
  const language: PostLanguage = hasDevanagari ? 'marathi' : 'english';

  logger.info('Engagement farm post generated', {
    language, chars: Array.from(content).length, preview: content.slice(0, 60),
  });

  return { content, language, topic: 'engagement-farm', category: 'observation', researchContext: '' };
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateOriginalPost(): Promise<GeneratedOriginalPost> {
  const { topic, category } = pickTopicAndCategory();
  const language = pickLanguage(category);
  const { context, snippets } = await gatherResearchContext(topic);

  const systemPrompt = buildSystemPrompt(category, language);

  const userPrompt = [
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
  ].filter((l) => l !== undefined).join('\n');

  const model = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';
  const client = getGroqClient();

  logger.info('Generating original post', { topic, category, language, model });

  let content = '';
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt === 1) logPromptToConsole('ORIGINAL', `topic=${topic} cat=${category}`, systemPrompt, userPrompt);
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_completion_tokens: 6000,
      temperature: 0.85,
      top_p: 0.95,
      reasoning_effort: 'high',
    } as any);

    const raw = (completion.choices[0]?.message?.content ?? '').trim();
    const cleaned = raw.replace(/^["']|["']$/g, '').trim();

    if (cleaned.length === 0) {
      logger.warn('Original post: empty response, skipping this run', { attempt, topic, category });
      throw new EmptyReplyError('Original post returned empty reply');
    }

    const qError = qualityCheck(cleaned, language);
    if (!qError) {
      content = cleaned;
      break;
    }

    logger.warn('Quality check failed on attempt', { attempt, qError, preview: cleaned.slice(0, 80) });
    lastError = qError;

    // If Marathi came back without Devanagari, add an explicit retry instruction
    if (language === 'marathi' && !/[ऀ-ॿ]/.test(cleaned) && attempt < 3) {
      await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
          { role: 'assistant', content: cleaned },
          {
            role: 'user',
            content: 'देवनागरी लिपीत मराठीत लिहा. फक्त मराठी, इंग्रजी नको.',
          },
        ],
        max_completion_tokens: 6000,
        temperature: 0.8,
        top_p: 0.95,
        reasoning_effort: 'high',
      } as any).then((r) => {
        const retry = (r.choices[0]?.message?.content ?? '').trim().replace(/^["']|["']$/g, '');
        if (!qualityCheck(retry, language)) content = retry;
      }).catch(() => undefined);

      if (content) break;
    }
  }

  if (!content) {
    throw new Error(`Could not generate a passing original post after 3 attempts. Last error: ${lastError}`);
  }

  logger.info('Original post generated', {
    topic, category, language, chars: Array.from(content).length, preview: content.slice(0, 60),
  });

  return { content, language, topic, category, researchContext: context };
}
