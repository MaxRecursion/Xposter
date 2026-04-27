import Groq from 'groq-sdk';
import {
  Account, Classification, ClassificationUpdate,
  classificationIsFresh, getAccount, setAccountClassification, upsertAccountSeen,
} from '../storage/accounts.js';
import { getSetting } from '../storage/queries.js';
import { logger } from '../utils/logger.js';
import { fetchProfile, AuthorProfile } from '../browser/profile.js';

let _groq: Groq | null = null;

function getGroqClient(): Groq | null {
  if (_groq) return _groq;
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  _groq = new Groq({ apiKey });
  return _groq;
}

const CLASSIFICATION_VALUES: Classification[] = [
  'SERIOUS', 'NEWS', 'PARODY', 'COMEDY', 'INFLUENCER',
  'REGULAR', 'BOT', 'BRAND_PROMO', 'UNKNOWN',
];

const CLASSIFIER_SYSTEM_PROMPT = `You classify X (Twitter) accounts.

Choose ONE label that best fits the author, based on their handle, display name, bio, and counts.

LABELS:
- SERIOUS:     thoughtful individual, professional, earnest tone
- NEWS:        news organisation, journalist, official press
- PARODY:      parody/satire/fan account (often X's PCF label)
- COMEDY:      comedy creator, meme account, jokes-first content
- INFLUENCER:  high-follower personal brand (>50k) or public figure
- REGULAR:     ordinary individual with modest following
- BOT:         automated/scripted account, repetitive content
- BRAND_PROMO: company/product account, promotional first
- UNKNOWN:     not enough signal

Detection cues:
- PCF label or words "parody" / "fake" / "fan account" / "commentary" in bio → PARODY
- "comedy", "memes", "satire" + creator-style bio → COMEDY
- "Press", "Reporter", "@xyz News", "Official news", verified news org → NEWS
- Large followers, "Founder", public-figure title, content niche → INFLUENCER
- Repetitive promo language, product links only → BRAND_PROMO
- Bot-like handles (random digits + repetitive bio) → BOT

Also detect Marathi creators: bio in Devanagari Marathi, or contains "मराठी", "पुणे", "महाराष्ट्र", or Marathi creator-style phrases.

Return ONLY a single line of JSON, no markdown, no code fences:
{"classification":"<LABEL>","confidence":<0-1>,"is_marathi_creator":<true|false>,"reasoning":"<short reason in 1 sentence>"}`;

export interface ClassifyOptions {
  forceRefresh?: boolean;
  fetchProfileIfMissing?: boolean;
}

/**
 * Classifies an account, with caching.
 *
 * Flow:
 *   1. Look up cached row by handle.
 *   2. If cached and fresh (< classification_ttl_days), return it.
 *   3. Otherwise: optionally fetch profile (bio + counts) via Playwright.
 *   4. Run LLM classifier on (handle, name, bio, counts).
 *   5. Store back into accounts table; return.
 *
 * If GROQ_API_KEY is missing, classification is set to UNKNOWN with low confidence.
 */
export async function classifyAccount(
  handle: string,
  displayName: string | null,
  opts: ClassifyOptions = {},
): Promise<Account> {
  upsertAccountSeen(handle, displayName);
  const ttlDays = parseInt(getSetting('classification_ttl_days', '7'), 10);
  const cached = getAccount(handle);

  if (!opts.forceRefresh && classificationIsFresh(cached, ttlDays)) {
    return cached!;
  }

  // Pull bio + counts unless we already have a recent fetch
  let profile: AuthorProfile | null = null;
  const needFetch = opts.fetchProfileIfMissing !== false &&
    (!cached?.bio_fetched_at || (Date.now() / 1000 - cached.bio_fetched_at) > ttlDays * 86400);

  if (needFetch) {
    profile = await fetchProfile(handle).catch(() => null);
  }

  const bio = profile?.bio ?? cached?.bio ?? null;
  const name = profile?.display_name ?? displayName ?? cached?.display_name ?? null;
  const verified = profile?.verified ?? Boolean(cached?.verified);
  const followerCount = profile?.follower_count ?? cached?.follower_count_seen ?? 0;
  const followingCount = profile?.following_count ?? cached?.following_count_seen ?? 0;
  const pcfLabelled = profile?.is_pcf_labelled ?? false;

  // 1. Heuristic short-circuit (no LLM call needed when signal is strong)
  const heuristic = heuristicClassify({
    handle, name, bio, verified, followerCount, followingCount, pcfLabelled,
  });
  if (heuristic) {
    setAccountClassification(handle, {
      ...heuristic,
      bio,
      displayName: name,
      verified,
      followerCount,
      followingCount,
    });
    return getAccount(handle)!;
  }

  // 2. LLM classify
  const groq = getGroqClient();
  if (!groq) {
    setAccountClassification(handle, {
      classification: 'UNKNOWN',
      confidence: 0.1,
      reasoning: 'GROQ_API_KEY not configured — heuristics only',
      model: 'none',
      bio, displayName: name, verified, followerCount, followingCount,
    });
    return getAccount(handle)!;
  }

  const model = process.env.GROQ_CLASSIFIER_MODEL ?? process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';
  const userPrompt = [
    `Handle: @${handle}`,
    `Display name: ${name ?? '(unknown)'}`,
    `Verified: ${verified ? 'yes' : 'no'}`,
    `Followers: ${followerCount}`,
    `Following: ${followingCount}`,
    `Bio: ${bio ?? '(empty)'}`,
  ].join('\n');

  try {
    const completion = await groq.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 200,
      temperature: 0.1,
      top_p: 0.9,
    });

    const raw = completion.choices[0]?.message?.content?.trim() ?? '';
    const parsed = parseClassifierJson(raw);
    if (!parsed) throw new Error(`unparseable classifier output: ${raw.slice(0, 120)}`);

    const update: ClassificationUpdate = {
      classification: parsed.classification,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
      model,
      isMarathiCreator: parsed.is_marathi_creator,
      bio,
      displayName: name,
      verified,
      followerCount,
      followingCount,
    };
    setAccountClassification(handle, update);
    logger.info('Classified account', { handle, classification: parsed.classification, confidence: parsed.confidence });
    return getAccount(handle)!;
  } catch (err) {
    logger.warn('LLM classification failed; storing UNKNOWN', { handle, err: String(err) });
    setAccountClassification(handle, {
      classification: 'UNKNOWN',
      confidence: 0,
      reasoning: `classifier error: ${String(err).slice(0, 200)}`,
      model,
      bio, displayName: name, verified, followerCount, followingCount,
    });
    return getAccount(handle)!;
  }
}

interface HeuristicInput {
  handle: string;
  name: string | null;
  bio: string | null;
  verified: boolean;
  followerCount: number;
  followingCount: number;
  pcfLabelled: boolean;
}

/**
 * Returns a classification update without an LLM call when signals are very
 * strong (PCF label, very-bot-like handles, obvious news bios).
 */
function heuristicClassify(input: HeuristicInput): Omit<ClassificationUpdate, 'bio' | 'displayName' | 'verified' | 'followerCount' | 'followingCount'> | null {
  const bio = (input.bio ?? '').toLowerCase();
  const name = (input.name ?? '').toLowerCase();
  const allText = `${name} ${bio}`;

  const isMarathi = /[ऀ-ॿ]/.test(input.bio ?? '') ||
    /\b(marathi|punekar|maharashtra|पुणे|महाराष्ट्र|मराठी)\b/i.test(input.bio ?? '');

  if (input.pcfLabelled || /\b(parody|fake account|fan account|commentary account)\b/.test(allText)) {
    return {
      classification: 'PARODY',
      confidence: 0.95,
      reasoning: input.pcfLabelled ? 'X PCF label visible on profile' : 'parody/fan/commentary keyword in bio',
      model: 'heuristic',
      isMarathiCreator: isMarathi,
    };
  }

  if (/\b(news|reporter|journalist|press|correspondent|editor-in-chief|breaking news)\b/.test(allText) &&
      !/\b(parody|spoof|fake|fan account)\b/.test(allText)) {
    return {
      classification: 'NEWS',
      confidence: 0.85,
      reasoning: 'news/reporter/press in bio',
      model: 'heuristic',
      isMarathiCreator: isMarathi,
    };
  }

  // Bot-ish handles: 8+ digits or near-random char distribution
  if (/^[a-z]+\d{6,}$/i.test(input.handle) && input.followerCount < 50 && input.followingCount > input.followerCount * 5) {
    return {
      classification: 'BOT',
      confidence: 0.7,
      reasoning: 'numeric-suffix handle with low followers + high following ratio',
      model: 'heuristic',
      isMarathiCreator: false,
    };
  }

  // Very high follower count + verified → INFLUENCER (only if not news)
  if (input.followerCount >= 100_000 && input.verified) {
    return {
      classification: 'INFLUENCER',
      confidence: 0.7,
      reasoning: 'verified account with 100k+ followers',
      model: 'heuristic',
      isMarathiCreator: isMarathi,
    };
  }

  return null;
}

interface ClassifierJson {
  classification: Classification;
  confidence: number;
  is_marathi_creator: boolean;
  reasoning: string;
}

function parseClassifierJson(raw: string): ClassifierJson | null {
  // Sometimes the model wraps JSON in fences or extra text — extract the first {...} chunk.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    const cls = String(obj.classification ?? '').toUpperCase() as Classification;
    if (!CLASSIFICATION_VALUES.includes(cls)) return null;

    const confidence = Math.min(Math.max(Number(obj.confidence) || 0, 0), 1);
    const reasoning = String(obj.reasoning ?? '').slice(0, 280);
    const isMar = Boolean(obj.is_marathi_creator);

    return { classification: cls, confidence, is_marathi_creator: isMar, reasoning };
  } catch {
    return null;
  }
}
