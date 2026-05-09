import Groq from 'groq-sdk';
import { Post, getSetting, logEvent } from '../storage/queries.js';
import { Account, Classification } from '../storage/accounts.js';
import { enrichPrompt, isContextEnabled } from '../context/enrich.js';
import { detectTopics } from '../context/topics.js';
import { EmptyReplyError } from './errors.js';
import { logger } from '../utils/logger.js';

let _groq: Groq | null = null;
const MAX_REPLY_CHARS = 280;

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

OUTPUT: Return ONLY the reply text. No quotes around it, no "Here's a reply:", no explanation, no "Mode A" / "Mode B" label. Just the reply, exactly as it would appear on X.`;

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

const MARATHI_ROMAN_RULES = `LANGUAGE RULE — ROMAN MARATHI:
The tweet is Marathi typed in Roman/Latin script (e.g. "majhya punyat khup paus aahe").
Reply in the same style: natural Marathi typed in Roman/Latin script.
- Match the casual code-mixed feel of the original.
- Do NOT switch to Devanagari unless the original used it.
- Do NOT switch to pure English.
- Use authentic Marathi-ish Roman spellings (ahe, nahi, khup, ka re, mhanaje).`;

function systemPrompt(language: string, tier: WitTier, classification: Classification | null, flavor: Flavor): string {
  const base = flavor === 'pune' ? SYSTEM_PROMPT_PUNE : SYSTEM_PROMPT_GENERAL;
  const langRules =
    language === 'marathi' ? MARATHI_RULES :
    language === 'marathi-roman' ? MARATHI_ROMAN_RULES :
    ENGLISH_RULES;

  const classificationGuidance = classificationGuidanceFor(classification);
  return [
    base,
    witInstructions(tier, flavor),
    classificationGuidance,
    langRules,
  ].filter(Boolean).join('\n\n');
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

export async function generateReply(
  post: Post,
  authorAccount: Account | null = null,
): Promise<string> {
  const client = getGroqClient();
  const model = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';

  const { level, tier } = readWitLevel();
  const classification = (authorAccount?.classification as Classification | null) ?? null;
  const flavor = pickFlavor(post.text);

  const contextBlock = isContextEnabled()
    ? await enrichPrompt({ text: post.text, language: post.language, maxItems: 4, maxTokens: 500 })
    : '';
  const userPrompt = buildUserPrompt(post, authorAccount, contextBlock);

  logger.info('Calling Groq for reply generation', {
    postId: post.id,
    model,
    lang: post.language,
    witLevel: level,
    witTier: tier,
    flavor,
    classification: classification ?? 'unknown',
    contextChars: contextBlock.length,
  });

  // Slightly higher temperature in WITTY/SHARP tiers to encourage variety
  const temp = tier === 'SHARP' ? 0.95 : tier === 'WITTY' ? 0.9 : 0.8;

  const sysPrompt = systemPrompt(post.language, tier, classification, flavor);
  logPromptToConsole('REPLY', `${post.id} flavor=${flavor}`, sysPrompt, userPrompt);

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 400,
    temperature: temp,
    top_p: 0.95,
  });

  let reply = completion.choices[0]?.message?.content?.trim() ?? '';
  if (!reply) throw new EmptyReplyError();

  // Sanitize: strip any surrounding quotes the model might add
  let cleaned = reply.replace(/^["']|["']$/g, '').trim();

  // Marathi enforcement: if the model didn't produce Devanagari, retry once with stricter prompt.
  if (post.language === 'marathi' && !/[ऀ-ॿ]/.test(cleaned)) {
    logger.warn('Marathi reply came back without Devanagari — retrying once', { postId: post.id });

    const retry = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt('marathi', tier, classification, flavor) },
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
      max_tokens: 400,
      temperature: 0.7,
      top_p: 0.95,
    });

    const retryText = retry.choices[0]?.message?.content?.trim() ?? '';
    if (retryText && /[ऀ-ॿ]/.test(retryText)) {
      cleaned = retryText.replace(/^["']|["']$/g, '').trim();
    }
  }

  cleaned = enforceReplyLimit(cleaned);

  logger.info('Reply generated', { postId: post.id, reply: cleaned, lang: post.language, flavor });
  return cleaned;
}

function logPromptToConsole(kind: string, id: string, system: string, user: string): void {
  if (process.env.LOG_PROMPTS === 'false') return;
  const line = '─'.repeat(72);
  process.stdout.write(
    `\n${line}\n┃ GROQ ${kind} PROMPT  id=${id}\n${line}\n` +
    `── SYSTEM ──\n${system}\n` +
    `── USER ──\n${user}\n${line}\n\n`,
  );
  logEvent('GROQ_PROMPT', `[${kind}] ${id} | ${user.slice(0, 500)}`);
}

function buildUserPrompt(post: Post, account: Account | null, contextBlock = ''): string {
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
  );
  if (contextBlock) {
    lines.push('', contextBlock);
  }
  lines.push('', 'Tweet:', post.text);

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
