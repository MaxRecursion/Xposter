import Groq from 'groq-sdk';
import { Post } from '../storage/queries.js';
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

function systemPrompt(language: string): string {
  if (language === 'marathi') return SYSTEM_PROMPT_BASE + MARATHI_RULES;
  return SYSTEM_PROMPT_BASE + ENGLISH_RULES;
}

export async function generateReply(post: Post): Promise<string> {
  const client = getGroqClient();
  const model = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';

  const userPrompt = buildUserPrompt(post);

  logger.info('Calling Groq for reply generation', {
    postId: post.id,
    model,
    lang: post.language,
  });

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt(post.language) },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 160,
    temperature: 0.85,
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
        { role: 'system', content: systemPrompt('marathi') },
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

function buildUserPrompt(post: Post): string {
  const lang = post.language === 'marathi' ? 'Marathi' : 'English';
  const ageMin = Math.round((Date.now() / 1000 - post.timestamp) / 60);

  return [
    `Language: ${lang}`,
    `Author: @${post.author_handle}`,
    `Posted: ${ageMin} minutes ago`,
    `Likes: ${post.likes} | Replies: ${post.replies}`,
    '',
    `Tweet:`,
    post.text,
  ].join('\n');
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
