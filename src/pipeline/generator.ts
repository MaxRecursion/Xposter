import Groq from 'groq-sdk';
import { Post, getSetting } from '../storage/queries.js';
import { Account, Classification } from '../storage/accounts.js';
import { logger } from '../utils/logger.js';

let _groq: Groq | null = null;
const MAX_REPLY_CHARS = 200;

function getGroqClient(): Groq {
  if (_groq) return _groq;
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set');
  _groq = new Groq({ apiKey });
  return _groq;
}

/**
 * Reads wit_level setting (0-100) and returns:
 *   0-19  → SERIOUS  : factual, helpful, no humour
 *   20-39 → MEASURED : light warmth, no jokes
 *   40-59 → BALANCED : occasional dry observation, gentle Puneri wit
 *   60-79 → WITTY    : steady comedic timing, observational humour
 *   80-100→ SHARP    : punchy, satirical, very funny — situation-as-joke only
 */
type WitTier = 'SERIOUS' | 'MEASURED' | 'BALANCED' | 'WITTY' | 'SHARP';

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

function witInstructions(tier: WitTier): string {
  switch (tier) {
    case 'SERIOUS':
      return 'TONE: Strictly serious, helpful, and factual. No jokes, no irony, no wit. Treat every post sincerely.';
    case 'MEASURED':
      return 'TONE: Warm and sincere with measured restraint. No jokes. Light empathy and useful information only.';
    case 'BALANCED':
      return 'TONE: Conversational with occasional gentle Puneri observation. Wit only if it genuinely fits — never forced.';
    case 'WITTY':
      return 'TONE: Steady Puneri wit. Dry, observational, lightly satirical. Make the SITUATION the joke (not the person). Comic timing matters — short setup, sharper payoff.';
    case 'SHARP':
      return 'TONE: SHARP and very funny. Confident comedic timing, satirical edge, punchy phrasing. Still: situation-as-joke only — never insult the author or any group. Never punch down.';
  }
}

const SYSTEM_PROMPT_BASE = `You are helping a real person from Pune, Maharashtra engage authentically on X (Twitter).

Your job: generate a single, short, natural reply to a tweet.

GENERAL RULES (STRICT):
- Be conversational and genuine - sound like a real local Punekar, not a bot.
- Use gentle Puneri wit: dry, observant, lightly satirical, with crisp comic timing.
- Make the situation the joke, not the person. Never insult the author or any group.
- Avoid caste, religion, gender, appearance, class, region, disability, or political jabs.
- If the tweet is about grief, health, safety, harassment, or serious loss, skip satire and be kind.
- Maximum 200 characters. Shorter is better (under 120 characters ideal).
- Do NOT use more than one hashtag. Prefer zero hashtags.
- No emojis unless the original post uses them.
- No promotional language, no spam phrases, no sales pitch.
- If the tweet is a question, answer it helpfully.
- If it's a complaint about Pune infrastructure/rain/traffic, show empathy or share experience.
- RETURN ONLY THE REPLY TEXT. No quotes, no preamble, no explanation.`;

const MARATHI_RULES = `

🔴 ABSOLUTE LANGUAGE RULE — MARATHI ONLY 🔴
The tweet is in MARATHI. Your reply MUST be entirely in Marathi using Devanagari script (देवनागरी).
- Do NOT reply in English.
- Do NOT reply in Hindi.
- Do NOT transliterate Marathi using Latin/Roman letters.
- Use natural, colloquial Marathi as spoken in Pune (पुणेरी मराठी).
- Common everyday Marathi words and phrases — not bookish/formal.
- Example acceptable replies: "हो ना, खूप त्रास होतो आहे आज", "पुण्यात नेहमीच असं होतं पावसात"
- Example UNACCEPTABLE replies: "Yes very bad", "Haan bahut kharab hai", "ho na khup tras"`;

const ENGLISH_RULES = `

LANGUAGE RULE: The tweet is in English. Reply in natural conversational English.`;

function systemPrompt(language: string, tier: WitTier, classification: Classification | null): string {
  const langRules =
    language === 'marathi' ? MARATHI_RULES :
    language === 'marathi-roman' ? MARATHI_ROMAN_RULES :
    ENGLISH_RULES;

  const classificationGuidance = classificationGuidanceFor(classification);
  return [
    SYSTEM_PROMPT_BASE,
    witInstructions(tier),
    classificationGuidance,
    langRules,
  ].filter(Boolean).join('\n\n');
}

const MARATHI_ROMAN_RULES = `LANGUAGE RULE — ROMAN MARATHI:
The tweet is Marathi typed in Roman/Latin script (e.g. "majhya punyat khup paus aahe").
Reply in the same style: natural Marathi typed in Roman/Latin script.
- Match the casual code-mixed feel of the original.
- Do NOT switch to Devanagari unless the original used it.
- Do NOT switch to pure English.
- Use authentic Marathi-ish Roman spellings (ahe, nahi, khup, ka re, mhanaje).`;

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

export async function generateReply(
  post: Post,
  authorAccount: Account | null = null,
): Promise<string> {
  const client = getGroqClient();
  const model = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';

  const { level, tier } = readWitLevel();
  const classification = (authorAccount?.classification as Classification | null) ?? null;
  const userPrompt = buildUserPrompt(post, authorAccount);

  logger.info('Calling Groq for reply generation', {
    postId: post.id,
    model,
    lang: post.language,
    witLevel: level,
    witTier: tier,
    classification: classification ?? 'unknown',
  });

  // Slightly higher temperature in WITTY/SHARP tiers to encourage variety
  const temp = tier === 'SHARP' ? 0.95 : tier === 'WITTY' ? 0.9 : 0.8;

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt(post.language, tier, classification) },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 200,
    temperature: temp,
    top_p: 0.95,
  });

  let reply = completion.choices[0]?.message?.content?.trim() ?? '';
  if (!reply) throw new Error('Groq returned empty reply');

  // Sanitize: strip any surrounding quotes the model might add
  let cleaned = reply.replace(/^["']|["']$/g, '').trim();

  // Marathi enforcement: if the model didn't produce Devanagari, retry once with stricter prompt.
  if (post.language === 'marathi' && !/[ऀ-ॿ]/.test(cleaned)) {
    logger.warn('Marathi reply came back without Devanagari — retrying once', { postId: post.id });

    const retry = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt('marathi', tier, classification) },
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: cleaned },
        {
          role: 'user',
          content:
            'तुमचा प्रतिसाद इंग्रजीत आला, हे चुकीचे आहे. ' +
            'फक्त मराठी (देवनागरी लिपी) मध्ये एक नवीन छोटा प्रतिसाद द्या. ' +
            'No English. Devanagari script only.',
        },
      ],
      max_tokens: 160,
      temperature: 0.7,
      top_p: 0.95,
    });

    const retryText = retry.choices[0]?.message?.content?.trim() ?? '';
    if (retryText && /[ऀ-ॿ]/.test(retryText)) {
      cleaned = retryText.replace(/^["']|["']$/g, '').trim();
    }
  }

  cleaned = enforceReplyLimit(cleaned);

  logger.info('Reply generated', { postId: post.id, reply: cleaned, lang: post.language });
  return cleaned;
}

function buildUserPrompt(post: Post, account: Account | null): string {
  const langLabel =
    post.language === 'marathi' ? 'Marathi (Devanagari)' :
    post.language === 'marathi-roman' ? 'Marathi (Roman script)' :
    'English';
  const ageMin = Math.round((Date.now() / 1000 - post.timestamp) / 60);

  const lines = [
    `Language: ${langLabel}`,
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
    '',
    'Tweet:',
    post.text,
  );

  return lines.join('\n');
}

function truncateForPrompt(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function enforceReplyLimit(reply: string): string {
  const trimmed = reply.trim();
  const chars = Array.from(trimmed);
  if (chars.length <= MAX_REPLY_CHARS) return trimmed;

  const clipped = chars.slice(0, MAX_REPLY_CHARS).join('');
  const lastSpace = clipped.lastIndexOf(' ');
  const safeClip = lastSpace > 80 ? clipped.slice(0, lastSpace) : clipped;

  return safeClip.replace(/[,.!?;:।-]+$/g, '').trim();
}
