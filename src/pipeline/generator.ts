import { Post, getSetting, logEvent } from '../storage/queries.js';
import { Account, Classification } from '../storage/accounts.js';
import { enrichPrompt, isContextEnabled } from '../context/enrich.js';
import { recallNeuralMemory } from '../context/neural_memory.js';
import { detectTopics } from '../context/topics.js';
import { EmptyReplyError } from './errors.js';
import { logger } from '../utils/logger.js';
import { getGroqClient } from './groq_client.js';
import { logPromptToConsole } from './prompt_logger.js';
import { assertEnglishOnly, cleanModelText, enforceCharacterLimit } from './text_constraints.js';
import { isClaudeAvailable, claudeGeneratorModel, generateWithClaude } from './claude_generator.js';

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

LANGUAGE: Reply in sharp, polished English only. Do NOT reply in Marathi, Hindi, or any other language. Do NOT use Devanagari script or Roman-script Marathi — even if the original tweet is in another language, your reply is English.

OUTPUT: Return ONLY the reply text. No quotes around it, no "Here's a reply:", no explanation, no "Mode A" / "Mode B" label. Just the reply, exactly as it would appear on X.`;

function systemPrompt(tier: WitTier, classification: Classification | null, flavor: Flavor): string {
  const base = flavor === 'pune' ? SYSTEM_PROMPT_PUNE : SYSTEM_PROMPT_GENERAL;
  const classificationGuidance = classificationGuidanceFor(classification);
  return [
    base,
    witInstructions(tier, flavor),
    classificationGuidance,
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
  options: { avoidTexts?: string[] } = {},
): Promise<string> {
  const { level, tier } = readWitLevel();
  const classification = (authorAccount?.classification as Classification | null) ?? null;
  const flavor = pickFlavor(post.text);

  const contextBlock = isContextEnabled()
    ? await enrichPrompt({ text: post.text, language: post.language, maxItems: 4, maxTokens: 500 })
    : '';
  const memoryBlock = recallNeuralMemory(post.text, { maxItems: 3, maxChars: 900 });
  const userPrompt = buildUserPrompt(
    post,
    authorAccount,
    [contextBlock, memoryBlock].filter(Boolean).join('\n\n'),
    options.avoidTexts,
  );

  // Slightly higher temperature in WITTY/SHARP tiers to encourage variety
  const temp = tier === 'SHARP' ? 0.95 : tier === 'WITTY' ? 0.9 : 0.8;

  const sysPrompt = systemPrompt(tier, classification, flavor);
  logPromptToConsole('REPLY', `${post.id} flavor=${flavor}`, sysPrompt, userPrompt);

  let rawReply = '';

  // ── Claude (primary) ─────────────────────────────────────────────────────────
  if (isClaudeAvailable()) {
    const claudeModel = claudeGeneratorModel();
    logger.info('Trying Claude for reply generation', {
      postId: post.id, model: claudeModel, witLevel: level, witTier: tier, flavor,
      classification: classification ?? 'unknown',
      contextChars: contextBlock.length, memoryChars: memoryBlock.length,
    });
    logEvent('CLAUDE_GENERATION_START', `model=${claudeModel} witTier=${tier} flavor=${flavor} postId=${post.id}`, post.id);
    try {
      const result = await generateWithClaude(sysPrompt, userPrompt);
      const text = result.text.trim();
      if (text.length >= 10) {
        logEvent('CLAUDE_GENERATION_SUCCESS', `model=${claudeModel} in=${result.inputTokens} out=${result.outputTokens} chars=${text.length}`, post.id);
        logger.info('Claude reply generation succeeded', {
          postId: post.id, inputTokens: result.inputTokens, outputTokens: result.outputTokens, chars: text.length,
        });
        rawReply = text;
      } else {
        logEvent('CLAUDE_GENERATION_FAILED', `response too short (${text.length} chars) — triggering Groq fallback`, post.id);
        logger.warn('Claude returned short/empty reply, falling back to Groq', { postId: post.id, textLen: text.length });
      }
    } catch (err) {
      logEvent('CLAUDE_GENERATION_FAILED', `error: ${String(err)} — triggering Groq fallback`, post.id);
      logger.warn('Claude threw error for reply generation, falling back to Groq', { postId: post.id, err: String(err) });
    }
  }

  // ── Groq (fallback) ──────────────────────────────────────────────────────────
  if (!rawReply) {
    const groqModel = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';
    const client = getGroqClient();
    logger.info('Calling Groq for reply generation', {
      postId: post.id, model: groqModel, witLevel: level, witTier: tier, flavor,
      classification: classification ?? 'unknown',
      contextChars: contextBlock.length, memoryChars: memoryBlock.length,
    });
    logEvent('GROQ_FALLBACK_START', `model=${groqModel} witTier=${tier} flavor=${flavor}`, post.id);
    try {
      const completion = await client.chat.completions.create({
        model: groqModel,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 400,
        temperature: temp,
        top_p: 0.95,
      });
      rawReply = completion.choices[0]?.message?.content?.trim() ?? '';
      logEvent('GROQ_FALLBACK_SUCCESS', `model=${groqModel} chars=${rawReply.length}`, post.id);
      logger.info('Groq reply generation succeeded', { postId: post.id, chars: rawReply.length });
    } catch (err) {
      logEvent('GROQ_FALLBACK_FAILED', `error: ${String(err)}`, post.id);
      throw err;
    }
  }

  if (!rawReply) throw new EmptyReplyError();

  // Sanitize: strip any surrounding quotes the model might add
  let cleaned = cleanModelText(rawReply);
  cleaned = enforceCharacterLimit(cleaned, MAX_REPLY_CHARS);
  assertEnglishOnly(cleaned, 'Reply generation');

  logger.info('Reply generated', { postId: post.id, reply: cleaned, flavor });
  return cleaned;
}

function buildUserPrompt(
  post: Post,
  account: Account | null,
  contextBlock = '',
  avoidTexts: string[] = [],
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
  if (avoidTexts.length > 0) {
    lines.push(
      '',
      'VARIETY REQUIREMENT: The previous draft was too similar to a recent reply.',
      'Use a genuinely different angle, sentence structure, and opening. Do not paraphrase these:',
      ...avoidTexts.slice(0, 8).map((text, i) => `${i + 1}. ${truncateForPrompt(text, 180)}`),
    );
  }
  lines.push('', 'Tweet:', post.text);

  return lines.join('\n');
}

function truncateForPrompt(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
