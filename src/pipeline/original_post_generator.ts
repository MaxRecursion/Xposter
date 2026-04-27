import Groq from 'groq-sdk';
import { getSetting, getRecentPosts } from '../storage/queries.js';
import { getTopicPerformance } from '../storage/original_posts.js';
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
  researchContext: string;
}

// ── Topic selection ───────────────────────────────────────────────────────────

/** All candidate topics (merged from settings + built-in defaults). */
function getTopics(): string[] {
  const raw = getSetting('topic_keywords', 'pune,rain,traffic,flooding,waterlogging,pothole,event');
  const fromSettings = raw.split(',').map((k) => k.trim()).filter(Boolean);
  const defaults = [
    'pune', 'rain', 'traffic', 'flooding', 'waterlogging', 'pothole',
    'local', 'event', 'weather', 'road', 'pmc', 'metro',
  ];
  return Array.from(new Set([...fromSettings, ...defaults]));
}

/**
 * Picks a topic using weighted random selection.
 * Topics that have previously generated high engagement get higher weight.
 * Brand-new topics get a baseline weight of 1.0 to ensure variety.
 */
function pickTopic(topics: string[]): string {
  const performance = getTopicPerformance();
  const perfMap = new Map(performance.map((p) => [p.topic, p.engagement_score]));

  const weights = topics.map((t) => {
    const score = perfMap.get(t) ?? 0;
    return 1.0 + score * 0.1; // baseline 1, scaled by engagement
  });

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let rand = Math.random() * totalWeight;
  for (let i = 0; i < topics.length; i++) {
    rand -= weights[i];
    if (rand <= 0) return topics[i];
  }
  return topics[topics.length - 1];
}

// ── Language selection ────────────────────────────────────────────────────────

function pickLanguage(): PostLanguage {
  const ratio = parseInt(getSetting('original_post_marathi_ratio', '40'), 10);
  const safeRatio = Math.min(100, Math.max(0, Number.isFinite(ratio) ? ratio : 40));
  return Math.random() * 100 < safeRatio ? 'marathi' : 'english';
}

// ── Research step ─────────────────────────────────────────────────────────────

/**
 * Gathers recent context for the topic from already-ingested timeline tweets.
 * Returns formatted context string + raw tweet snippets for dedup avoidance.
 */
function gatherResearchContext(topic: string): { context: string; snippets: string[] } {
  const recent = getRecentPosts(48); // last 48h
  const topicLower = topic.toLowerCase();

  const matched = recent
    .filter((p) => p.text.toLowerCase().includes(topicLower))
    .sort((a, b) => (b.likes + b.replies * 2) - (a.likes + a.replies * 2))
    .slice(0, 6);

  if (matched.length === 0) {
    return { context: `No recent context available for "${topic}".`, snippets: [] };
  }

  const snippets = matched.map((p) => p.text.slice(0, 200));
  const context = [
    `Recent tweets about "${topic}" (last 48h, sorted by engagement):`,
    ...snippets.map((s, i) => `${i + 1}. ${s}`),
  ].join('\n');

  return { context, snippets };
}

// ── Quality gate ──────────────────────────────────────────────────────────────

function qualityCheck(content: string, language: PostLanguage): string | null {
  const chars = Array.from(content).length;
  if (chars < 60) return `too short (${chars} chars)`;
  if (chars > 280) return `too long (${chars} chars)`;
  if (language === 'marathi' && !/[ऀ-ॿ]/.test(content)) return 'requested Marathi but no Devanagari found';

  // Must have at least 1 sentence-ending mark (period, !, ?, Marathi danda, etc.)
  const sentenceEnds = (content.match(/[.!?।॥]/g) ?? []).length;
  if (sentenceEnds < 1) return 'no sentence-ending punctuation found';

  return null; // OK
}

// ── Prompts ───────────────────────────────────────────────────────────────────

const SYSTEM_BASE = `You are a real person from Pune, Maharashtra posting original thoughts on X (Twitter).

Write ONE original tweet (not a reply). The tweet must:
- Be 3-4 sentences long
- End with a thought-provoking question OR an intriguing open statement that makes readers want to engage
- Be specific, opinionated, and local — mention Pune/Maharashtra details where natural
- Sound like a real, thinking Punekar, not a journalist or corporate bot
- Have a clear perspective or take, not neutral reporting

Hard limits:
- Maximum 280 characters total
- Zero or one hashtag only (prefer zero)
- No emojis unless the topic strongly calls for it
- Do NOT start with "Just", "Thread:", "Hot take:", or "Unpopular opinion:"
- No promotional language

RETURN ONLY THE TWEET TEXT. No quotes, no preamble, no explanation.`;

const MARATHI_LANG = `
LANGUAGE: Write entirely in Marathi using Devanagari script (देवनागरी).
Use natural, colloquial Puneri Marathi — conversational, not bookish.
Do NOT write in English or Roman/Latin script.`;

const ENGLISH_LANG = `
LANGUAGE: Write in natural, conversational English.`;

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateOriginalPost(): Promise<GeneratedOriginalPost> {
  const topics = getTopics();
  const topic = pickTopic(topics);
  const language = pickLanguage();
  const { context, snippets } = gatherResearchContext(topic);

  const systemPrompt = SYSTEM_BASE + (language === 'marathi' ? MARATHI_LANG : ENGLISH_LANG);

  const userPrompt = [
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

  logger.info('Generating original post', { topic, language, model });

  let content = '';
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 300,
      temperature: 0.85,
      top_p: 0.95,
    });

    const raw = (completion.choices[0]?.message?.content ?? '').trim();
    const cleaned = raw.replace(/^["']|["']$/g, '').trim();

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
        max_tokens: 300,
        temperature: 0.8,
        top_p: 0.95,
      }).then((r) => {
        const retry = (r.choices[0]?.message?.content ?? '').trim().replace(/^["']|["']$/g, '');
        if (!qualityCheck(retry, language)) content = retry;
      }).catch(() => undefined);

      if (content) break;
    }
  }

  if (!content) {
    throw new Error(`Could not generate a passing original post after 3 attempts. Last error: ${lastError}`);
  }

  logger.info('Original post generated', { topic, language, chars: Array.from(content).length, preview: content.slice(0, 60) });

  return { content, language, topic, researchContext: context };
}
