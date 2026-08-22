import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  allocateReplyTournament,
  angleGuidanceFor,
  TOURNAMENT_ANGLES,
} from '../../src/pipeline/reply_tournament.js';

const TEST_DB_RELATIVE = 'data/test-reply-tournament.db';
const TEST_DB_PATH = path.resolve(process.cwd(), TEST_DB_RELATIVE);

function removeTestDb(): void {
  for (const suffix of ['', '-shm', '-wal']) {
    fs.rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
  }
}

describe('Reply Tournament allocation', () => {
  it('never assigns Tournament at 0% rollout', () => {
    const assignment = allocateReplyTournament({
      blocked: false,
      enabled: true,
      rolloutPct: 0,
      rng: () => 0,
    });
    expect(assignment.strategy).toBe('CONTROL');
  });

  it('always assigns Tournament at 100% rollout', () => {
    const assignment = allocateReplyTournament({
      blocked: false,
      enabled: true,
      rolloutPct: 100,
      rng: () => 0.99,
    });
    expect(assignment.strategy).toBe('TOURNAMENT');
  });

  it('keeps a persisted assignment even when rollout is 0%', () => {
    expect(allocateReplyTournament({
      blocked: false,
      persistedStrategy: 'TOURNAMENT',
      enabled: true,
      rolloutPct: 0,
    }).strategy).toBe('TOURNAMENT');
  });

  it('documents the three angles', () => {
    expect(TOURNAMENT_ANGLES).toEqual(['ONE_LINER', 'SECOND_ORDER', 'SPECIFIC_RECEIPT']);
    expect(angleGuidanceFor('ONE_LINER')).toContain('ONE_LINER');
    expect(angleGuidanceFor('SECOND_ORDER')).toContain('SECOND_ORDER');
    expect(angleGuidanceFor('SPECIFIC_RECEIPT')).toContain('SPECIFIC_RECEIPT');
  });
});

describe('Reply Tournament metadata persistence', () => {
  beforeEach(() => {
    vi.resetModules();
    removeTestDb();
    fs.mkdirSync(path.dirname(TEST_DB_PATH), { recursive: true });
    process.env.DB_PATH_OVERRIDE = TEST_DB_RELATIVE;
  });

  afterEach(() => {
    delete process.env.DB_PATH_OVERRIDE;
    removeTestDb();
  });

  it('stores strategy, angle, critic score, and reasons on the post', async () => {
    const { upsertPost, getPost } = await import('../../src/storage/posts.js');
    const { updatePostTournamentMeta } = await import('../../src/storage/posts.js');
    const post = upsertPost({
      tweet_id: '1723456789012349001',
      author_handle: 'tourney_user',
      author_name: 'Tourney User',
      text: 'Pune Metro frequency improved this week.',
      timestamp: Math.floor(Date.now() / 1000) - 120,
      likes: 4,
      replies: 1,
      retweets: 0,
      tweet_url: 'https://x.com/tourney_user/status/1723456789012349001',
    })!;

    updatePostTournamentMeta(post.id, { strategy: 'TOURNAMENT' });
    updatePostTournamentMeta(post.id, {
      strategy: 'TOURNAMENT',
      angle: 'SPECIFIC_RECEIPT',
      criticScore: 4.2,
      criticReasons: ['specific', 'invites reply'],
    });

    const stored = getPost(post.id)!;
    expect(stored.tournament_strategy).toBe('TOURNAMENT');
    expect(stored.tournament_angle).toBe('SPECIFIC_RECEIPT');
    expect(stored.tournament_critic_score).toBe(4.2);
    expect(stored.tournament_critic_reasons).toContain('specific');
  });
});
