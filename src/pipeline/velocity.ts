/**
 * Velocity targeting — is this tweet still gathering attention, and is there
 * room left for our reply to be seen?
 *
 * Reply reach on X is dominated by *where* and *when*, not wording: a perfect
 * line under a dead tweet reaches nobody. Historically 53.7% of our replies
 * landed on tweets with under 10 likes and only 10.6% went out within 15
 * minutes, so 99.86% were invisible before a word was written.
 *
 * This module turns a candidate's like-rate, age, and reply crowding into a
 * `reachFactor` multiplier. That multiplier weights *ranking* only — it is
 * applied to `ScoredPost.reachScore`, never to the `min_score` gate. On a quiet
 * timeline every candidate has a low like-rate, so folding it into the gate
 * would push the whole pool below threshold and starve the run. Volume stays
 * flat; only the aim changes.
 *
 * The three terms mirror `scoreTrendPost`, which has solved the same problem in
 * production for longer: log-scaled heat, a reply-window plateau, and a
 * crowding penalty. All functions are pure so the weights can be backtested
 * against the real `posts` table.
 */
import { getBooleanSettingFromSchema, getFloatSettingFromSchema, getIntSettingFromSchema } from '../storage/settings.js';

export interface VelocityConfig {
  /** Minutes after posting during which a reply can still ride the wave. */
  strikeWindowMin: number;
  /** Like-rate treated as the boundary between "moving" and "dead". */
  minLikesPerMin: number;
}

/** A later re-sighting of the same tweet, used to measure a real like-rate. */
export interface Observation {
  likes: number;
  /** Unix seconds of the re-sighting. */
  at: number;
}

export interface VelocityRead {
  /** Likes per minute. Measured across two sightings when we have them. */
  lpm: number;
  /** Whether `lpm` is a measured rate or the since-posted proxy. */
  lpmSource: 'observed' | 'proxy';
  ageMinutes: number;
  /** 0–1: reply-window credit for the tweet's age. */
  freshness: number;
  /** 0–1: how hard the tweet is moving, saturating. */
  heat: number;
  /** 0–1: 1 when the thread is empty, 0 once our reply would be buried. */
  crowding: number;
  /** Multiplier applied to the composite score. */
  reachFactor: number;
  inStrikeWindow: boolean;
}

/** Below this age the like-rate is too noisy to trust, so we damp it. */
const MIN_RATE_AGE_MIN = 3;
/** Reach multiplier bounds. The floor keeps a dead tweet rankable, not fatal. */
const REACH_FLOOR = 0.15;
const REACH_CEIL = 1.4;
/** Heat saturates at 10^3.5 ≈ 3.2k likes/hour, matching the trend profile. */
const HEAT_LOG_CAP = 3.5;
/** Shortest gap between two sightings that yields a usable measured rate. */
const MIN_OBSERVATION_MIN = 1;
/** A reply is buried once this many others are ahead of it. */
const CROWDING_FULL = 150;
/** How heat and window trade off inside the multiplier. Must sum to 1. */
const W_HEAT = 0.6;
const W_WINDOW = 0.4;
/** Worst-case crowding penalty. Crowding only ever subtracts. */
const CROWDING_WORST = 0.3;

export function getVelocityConfig(): VelocityConfig {
  return {
    strikeWindowMin: getIntSettingFromSchema('velocity_strike_window_min'),
    minLikesPerMin: getFloatSettingFromSchema('velocity_min_likes_per_min'),
  };
}

export function isVelocityTargetingEnabled(): boolean {
  return getBooleanSettingFromSchema('velocity_targeting_enabled');
}

/**
 * Like-rate since posting. This is a cumulative average, not an instantaneous
 * rate — we only observe a tweet once (`upsertPost` ignores repeat sightings) —
 * but it separates the buckets cleanly: 61% of fresh tweets sit under 0.2 lpm.
 *
 * Ages below `MIN_RATE_AGE_MIN` are floored so a 1-minute-old tweet with a
 * single like does not read as 60 likes/hour.
 */
export function likesPerMinute(likes: number, ageMinutes: number): number {
  if (!Number.isFinite(likes) || likes <= 0) return 0;
  const effectiveAge = Math.max(ageMinutes, MIN_RATE_AGE_MIN);
  if (!Number.isFinite(effectiveAge) || effectiveAge <= 0) return 0;
  return likes / effectiveAge;
}

/**
 * Reply-window credit, 0–1.
 *
 * Deliberately a plateau rather than a decay from zero: a tweet under a couple
 * of minutes old has not proved it will take off at all, so it earns partial
 * credit, not maximum. Full credit runs to the end of the strike window, then
 * tails off — the same shape the trend profile uses, which has been in
 * production far longer than this module.
 */
export function windowFactor(ageMinutes: number, strikeWindowMin: number): number {
  const window = Math.max(strikeWindowMin, 1);
  if (!Number.isFinite(ageMinutes) || ageMinutes < 0) return 0.4;
  if (ageMinutes < MIN_RATE_AGE_MIN) return 0.4;
  if (ageMinutes <= window) return 1;
  if (ageMinutes <= window * 3) return 0.5;
  if (ageMinutes <= window * 8) return 0.2;
  return 0.05;
}

/**
 * How hard the tweet is moving, 0–1, log-scaled.
 *
 * Log scaling matters: on a linear scale a single runaway tweet dwarfs
 * everything else and the window term stops mattering at all. Rate is measured
 * per hour so the constant lines up with `scoreTrendPost`.
 */
export function heatFactor(lpm: number, minLikesPerMin: number): number {
  if (!Number.isFinite(lpm) || lpm <= 0) return 0;
  const floor = Math.max(minLikesPerMin, 0.01);
  if (lpm < floor) {
    // Below the configured floor, scale down proportionally rather than
    // zeroing — on a quiet timeline every candidate sits here and we still
    // need them ordered relative to each other.
    return (lpm / floor) * (Math.log10(1 + floor * 60) / HEAT_LOG_CAP);
  }
  return Math.min(1, Math.log10(1 + lpm * 60) / HEAT_LOG_CAP);
}

/**
 * Penalty for how buried our reply would be: 1 (nothing ahead of us) down to
 * `CROWDING_WORST` (a pile-on nobody scrolls through).
 *
 * Strictly a penalty, never a bonus. An empty thread under a tweet nobody has
 * liked is not an opportunity — it is a dead tweet — so "no replies yet" must
 * not add credit of its own. Only `heat` and `window` can earn score.
 */
export function crowdingFactor(replies: number): number {
  if (!Number.isFinite(replies) || replies <= 0) return 1;
  const buried = Math.min(replies, CROWDING_FULL) / CROWDING_FULL;
  return 1 - (1 - CROWDING_WORST) * buried;
}

/** Full velocity read for a candidate tweet. */
export function observedLikesPerMinute(
  firstLikes: number,
  firstSeenSec: number,
  obs: Observation | null | undefined,
): number | null {
  if (!obs) return null;
  const gapMinutes = (obs.at - firstSeenSec) / 60;
  if (!Number.isFinite(gapMinutes) || gapMinutes < MIN_OBSERVATION_MIN) return null;
  const gained = obs.likes - firstLikes;
  if (!Number.isFinite(gained) || gained < 0) return null;
  return gained / gapMinutes;
}

export function readVelocity(
  likes: number,
  tweetTimestampSec: number,
  nowSec: number,
  cfg: VelocityConfig,
  replies = 0,
  observation?: { firstSeenSec: number; obs: Observation | null } | null,
): VelocityRead {
  const ageMinutes = Math.max((nowSec - tweetTimestampSec) / 60, 0);

  // A measured rate beats the proxy whenever we have one: a tweet posted three
  // hours ago that is only now catching fire looks dead to `likes / age` and
  // obviously alive across two sightings.
  const measured = observation
    ? observedLikesPerMinute(likes, observation.firstSeenSec, observation.obs)
    : null;
  const lpmSource: 'observed' | 'proxy' = measured === null ? 'proxy' : 'observed';
  const lpm = measured ?? likesPerMinute(likes, ageMinutes);
  const heat = heatFactor(lpm, cfg.minLikesPerMin);
  const window = windowFactor(ageMinutes, cfg.strikeWindowMin);
  const crowding = crowdingFactor(replies);

  // Heat and window earn score; crowding can only take it away.
  const earned = W_HEAT * heat + W_WINDOW * window;
  const combined = earned * crowding;
  const reachFactor = REACH_FLOOR + (REACH_CEIL - REACH_FLOOR) * combined;

  return {
    lpm,
    lpmSource,
    ageMinutes,
    freshness: window,
    heat,
    crowding,
    reachFactor,
    inStrikeWindow:
      ageMinutes >= MIN_RATE_AGE_MIN
      && ageMinutes <= cfg.strikeWindowMin
      && lpm >= cfg.minLikesPerMin,
  };
}

/** Rounds a reach read for storage in the score breakdown. */
export function roundVelocityRead(read: VelocityRead): {
  velocityLpm: number;
  reachFactor: number;
} {
  return {
    velocityLpm: Math.round(read.lpm * 100) / 100,
    reachFactor: Math.round(read.reachFactor * 1000) / 1000,
  };
}
