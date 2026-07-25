/**
 * Script detection and safety classification for trending topics.
 *
 * Both gates are pure, deterministic and table-driven on purpose. A trend name
 * is one to three tokens — an LLM has no more signal to work with than a regex
 * does, but it costs 300ms and is non-deterministic. And the cost of a wrong
 * call here is badly asymmetric: a contrarian reply under a trend about a
 * funeral is the single worst thing this bot could post. Deny-by-default and a
 * readable table beat cleverness.
 */
import { detectTopics } from '../context/topics.js';

// ── Script detection ──────────────────────────────────────────────────────────

export type TrendScript = 'latin' | 'devanagari' | 'cjk' | 'arabic' | 'cyrillic' | 'thai' | 'unknown';

const SCRIPT_RANGES: Array<[TrendScript, RegExp]> = [
  ['devanagari', /[ऀ-ॿ]/],
  ['cjk',        /[぀-ヿ㐀-䶿一-鿿가-힯]/],
  ['arabic',     /[؀-ۿݐ-ݿ]/],
  ['cyrillic',   /[Ѐ-ӿ]/],
  ['thai',       /[฀-๿]/],
];

/**
 * Classifies the dominant script of a trend name.
 *
 * `franc` is not used here: it has a 10-character minimum and returns `und` for
 * the short strings trend names actually are.
 */
export function detectScript(name: string): TrendScript {
  // Strip the things every trend name has, so they don't count as "latin".
  const stripped = name
    .replace(/^#/, '')
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
    .replace(/[0-9\s\p{P}\p{S}]/gu, '');

  if (!stripped) return 'unknown';

  for (const [script, re] of SCRIPT_RANGES) {
    if (re.test(stripped)) return script;
  }
  if (/[A-Za-z]/.test(stripped)) return 'latin';
  return 'unknown';
}

/**
 * Whether a trend is usable at all.
 *
 * Latin-only, for BOTH locations. The persona replies in polished English and
 * `assertEnglishOnly` throws on Devanagari, so a non-Latin trend can only ever
 * produce a rejected draft. Latin-script Indian trends ("#INDvAUS", "Bengaluru")
 * are exactly the India slice we want and pass fine.
 *
 * Note this does NOT prove the trend is English — Turkish and Spanish trends
 * are Latin too. Those are caught one level down by `filterTrendPost` on the
 * actual tweets, and then benched via `recordEnglishYield`.
 */
export function isUsableScript(name: string): boolean {
  return detectScript(name) === 'latin';
}

// ── Safety classification ─────────────────────────────────────────────────────

export type TrendSafetyClass = 'UNCLASSIFIED' | 'SAFE_FOR_CONTRARIAN' | 'STRAIGHT_ONLY' | 'SKIP';

export interface TrendSafety {
  class: TrendSafetyClass;
  reason: string;
}

/**
 * Don't reply at all. Tragedy, disaster, violence — no reply we could write
 * adds anything, and an engagement-farming bot in these threads is ghoulish.
 */
const SKIP_PATTERNS: Array<[string, RegExp]> = [
  ['death',    /\b(rip|r\.i\.p|died|dies|dead|death|passed away|passes away|demise|funeral|obituary|condolence\w*|mourn\w*|martyr\w*|tribute|laid to rest)\b/i],
  ['disaster', /\b(earthquake|tsunami|cyclone|hurricane|typhoon|flood(s|ing)?|landslide|wildfire|blast|explosion|derail\w*|plane crash|crash(ed)?|stampede|collapse[ds]?|evacuat\w*)\b/i],
  ['violence', /\b(murder\w*|killed|killing|shoot(ing|out)|shot dead|stabb\w*|rape[ds]?|assault\w*|kidnap\w*|abduct\w*|terror\w*|attack(ed|s)?|bomb(ing|ed)?|riot(s|ing)?|lynch\w*|massacre|genocide|hostage)\b/i],
  ['selfharm', /\b(suicide|self ?harm|took (his|her|their) own life)\b/i],
  ['missing',  /\b(missing person|amber alert|manhunt)\b/i],
];

/**
 * Reply straight, never contrarian. A contrarian take on someone's health, or
 * on religion, caste or party politics, is not "engagement" — it's a fight the
 * account cannot win and shouldn't pick.
 */
const STRAIGHT_ONLY_PATTERNS: Array<[string, RegExp]> = [
  ['health',   /\b(hospital\w*|cancer|tumou?r|surgery|icu|critical condition|diagnos\w*|illness|disease|outbreak|epidemic|pandemic|virus|vaccine|covid|health)\b/i],
  ['safety',   /\b(rescue|emergency|missing|alert|warning|evacuat\w*|casualt\w*|injur\w*|ambulance)\b/i],
  // Indian religious honorifics matter as much as the institution names: a
  // trend is far more likely to read "Sant Rampal Ji Maharaj" than "Hindu".
  ['religion', /\b(hindu\w*|muslim\w*|islam\w*|christian\w*|sikh\w*|jain\w*|buddhis\w*|temple|mosque|masjid|church|gurudwara|ramadan|ramzan|eid|diwali|christmas|navratri|navratra|namaz|puja|pooja|jayanti|bhagwan|allah|jesus|quran|bible|gita|dharma|conversion|sant|swami|maharaj|guru\w*|baba|bapu|acharya|shankaracharya|ashram|satsang|bhakt\w*|devotee\w*|katha|yatra|kumbh|mandir|dargah|prophet|blasphem\w*)\b/i],
  ['caste',    /\b(dalit|brahmin|bahujan|obc|sc ?st|scheduled caste|scheduled tribe|reservation|quota|caste|manuvad\w*|ambedkar\w*)\b/i],
  ['military', /\b(army|navy|air force|soldier|jawan|troops|border|loc|ceasefire|war|military|defence|defense|regiment)\b/i],
  // National-level politics that the app's Pune-centric `politics` topic rule
  // does not cover, plus civil unrest.
  ['politics', /\b(modi|amit shah|rahul gandhi|priyanka gandhi|kejriwal|yogi|adityanath|mamata|stalin|nitish|tejashwi|naidu|jagan|kharge|owaisi|dharmendra pradhan|nirmala|jaishankar|rajnath|piyush goyal|aap|bjd|trs|brs|dmk|aiadmk|ysrcp|tmc|jdu|rjd|sp|bsp)\b/i],
  ['politics', /\b(minister|ministry|parliament|lok ?sabha|rajya ?sabha|vidhan ?sabha|manifesto|constituency|by ?poll|byelection|by-election|opposition|ruling party|cabinet|governor|president|prime minister|sarkar|viksit)\b/i],
  ['unrest',   /\b(protest\w*|andolan|bandh|morcha|dharna|agitation|strike|boycott|rally|march|hartal|curfew|lathi ?charge)\b/i],
];

/** Political-party and figure detection reuses the app's existing topic rules. */
function isPolitical(text: string): boolean {
  return detectTopics(text).includes('politics');
}

function isCrime(text: string): boolean {
  return detectTopics(text).includes('crime');
}

/**
 * Expands a trend name into something the word-boundary patterns can match.
 *
 * Trends arrive as concatenated hashtags — "#CMSamratForViksitBihar" — where
 * `\bCM\b` and `\bminister\b` never fire because there are no word boundaries
 * inside. Splitting on case transitions restores them. Handles the
 * acronym-then-word case too, so "CMSamrat" becomes "CM Samrat" rather than
 * "C M Samrat".
 */
export function expandTrendText(text: string): string {
  return (text ?? '')
    .replace(/[#_]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Classifies a trend name — or a candidate tweet's own text.
 *
 * Called at BOTH levels on purpose. A trend can be perfectly safe ("#Formula1")
 * and still surface a tweet announcing a driver's death, so the tweet text gets
 * the same treatment before we choose a stance.
 */
export function classifyTrendSafety(text: string): TrendSafety {
  const normalized = expandTrendText(text);
  if (!normalized) return { class: 'STRAIGHT_ONLY', reason: 'empty' };

  for (const [label, re] of SKIP_PATTERNS) {
    if (re.test(normalized)) return { class: 'SKIP', reason: label };
  }

  for (const [label, re] of STRAIGHT_ONLY_PATTERNS) {
    if (re.test(normalized)) return { class: 'STRAIGHT_ONLY', reason: label };
  }

  if (isCrime(normalized)) return { class: 'SKIP', reason: 'crime' };
  if (isPolitical(normalized)) return { class: 'STRAIGHT_ONLY', reason: 'politics' };

  return { class: 'SAFE_FOR_CONTRARIAN', reason: 'no sensitive markers' };
}

/**
 * Combines the trend's class with the candidate tweet's own class, taking
 * whichever is more restrictive.
 */
export function combineSafety(trend: TrendSafetyClass, post: TrendSafetyClass): TrendSafetyClass {
  const rank: Record<TrendSafetyClass, number> = {
    SKIP: 3, STRAIGHT_ONLY: 2, UNCLASSIFIED: 1, SAFE_FOR_CONTRARIAN: 0,
  };
  // UNCLASSIFIED must never be treated as permission — resolve it to
  // STRAIGHT_ONLY so an unclassified trend can't slip a contrarian take out.
  const worst = rank[trend] >= rank[post] ? trend : post;
  return worst === 'UNCLASSIFIED' ? 'STRAIGHT_ONLY' : worst;
}
