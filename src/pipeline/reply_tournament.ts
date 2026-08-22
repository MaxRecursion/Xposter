/**
 * Reply Tournament — 20% controlled rollout of three distinct reply angles.
 *
 * Conversation Gravity remains the single critic. Tournament only changes
 * how drafts are prompted (one-liner / second-order / receipt), then Gravity
 * picks the winner.
 */
import {
  getBooleanSettingFromSchema,
  getIntSettingFromSchema,
} from '../storage/settings.js';
import { isBlockedForBait } from './engagement_bait.js';

export type TournamentStrategy = 'TOURNAMENT' | 'CONTROL';
export type TournamentAngle = 'ONE_LINER' | 'SECOND_ORDER' | 'SPECIFIC_RECEIPT';

export const TOURNAMENT_ANGLES: TournamentAngle[] = [
  'ONE_LINER',
  'SECOND_ORDER',
  'SPECIFIC_RECEIPT',
];

export interface TournamentAssignment {
  strategy: TournamentStrategy;
  reason: string;
}

export function isReplyTournamentEnabled(): boolean {
  return getBooleanSettingFromSchema('reply_tournament_enabled');
}

export function getReplyTournamentRolloutPct(): number {
  return getIntSettingFromSchema('reply_tournament_rollout_pct');
}

export function allocateReplyTournament(opts: {
  blocked: boolean;
  persistedStrategy?: string | null;
  enabled?: boolean;
  rolloutPct?: number;
  rng?: () => number;
}): TournamentAssignment {
  const persisted = normalizeStrategy(opts.persistedStrategy);
  if (persisted) {
    return { strategy: persisted, reason: 'persisted assignment' };
  }
  if (opts.blocked) {
    return { strategy: 'CONTROL', reason: 'blocked by safety' };
  }
  const enabled = opts.enabled ?? isReplyTournamentEnabled();
  if (!enabled) {
    return { strategy: 'CONTROL', reason: 'tournament disabled' };
  }
  const pct = Math.min(100, Math.max(0, opts.rolloutPct ?? getReplyTournamentRolloutPct()));
  if (pct <= 0) {
    return { strategy: 'CONTROL', reason: 'rollout 0%' };
  }
  if (pct >= 100) {
    return { strategy: 'TOURNAMENT', reason: 'rollout 100%' };
  }
  const roll = (opts.rng ?? Math.random)();
  if (roll < pct / 100) {
    return { strategy: 'TOURNAMENT', reason: `rollout ${pct}% hit` };
  }
  return { strategy: 'CONTROL', reason: `rollout ${pct}% miss` };
}

export function tournamentSensitive(text: string): boolean {
  return isBlockedForBait(text);
}

export function angleGuidanceFor(angle: TournamentAngle): string {
  switch (angle) {
    case 'ONE_LINER':
      return `TOURNAMENT ANGLE: ONE_LINER.
Write a single tight, quotable observation under 140 characters.
No setup, no question pile-on, no preamble. One concrete image or contradiction.`;
    case 'SECOND_ORDER':
      return `TOURNAMENT ANGLE: SECOND_ORDER.
Name a downstream consequence or the unexamined cost of the tweet's claim.
Respectful, specific, never a personal attack. One implication the parent missed.`;
    case 'SPECIFIC_RECEIPT':
      return `TOURNAMENT ANGLE: SPECIFIC_RECEIPT.
Lead with one checkable lived detail (place, number, named system) the parent did not already give, then one implication.
Never invent a statistic.`;
  }
}

function normalizeStrategy(value: string | null | undefined): TournamentStrategy | null {
  if (value === 'TOURNAMENT' || value === 'CONTROL') return value;
  return null;
}
