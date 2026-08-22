import { describe, expect, it } from 'vitest';
import {
  applyConversationGravity,
  jaccardTokens,
  pickByGravity,
  scoreConversationGravityHeuristic,
} from '../../src/pipeline/conversation_gravity.js';
import { GravitySkipError } from '../../src/pipeline/errors.js';
import { authorAppearsInLaterArticles } from '../../src/browser/impressions.js';

const PARENT = 'Traffic is terrible near Hinjewadi today, any alternatives?';

describe('conversation gravity heuristic', () => {
  it('scores a specific receipt above an echo', () => {
    const receipt = scoreConversationGravityHeuristic(
      PARENT,
      'Take the Aundh-Baner cut after 7pm — Hinjewadi Phase 1 still dumps onto the flyover. Has that lane actually reopened?',
    );
    const echo = scoreConversationGravityHeuristic(
      PARENT,
      'Traffic is terrible near Hinjewadi today, any alternatives?',
    );
    expect(receipt.score).toBeGreaterThanOrEqual(3);
    expect(echo.score).toBeLessThan(receipt.score);
    expect(echo.reasons.some((r) => /echo/i.test(r))).toBe(true);
  });

  it('penalises agreement-only slop', () => {
    const slop = scoreConversationGravityHeuristic(PARENT, 'So true, I totally understand, great point.');
    expect(slop.score).toBeLessThan(3);
  });

  it('picks the higher-gravity draft', () => {
    const picked = pickByGravity(PARENT, [
      'So true!',
      'Wakad bridge is lighter after 8. Did they actually finish the drain on that stretch?',
    ]);
    expect(picked.text).toMatch(/Wakad/);
    expect(picked.score).toBeGreaterThanOrEqual(3);
  });

  it('fails closed below the min score', async () => {
    await expect(applyConversationGravity({
      parentText: PARENT,
      drafts: ['So true, great point, I totally understand.'],
      minScore: 3,
    })).rejects.toBeInstanceOf(GravitySkipError);
  });

  it('accepts a rewrite that clears the threshold', async () => {
    const result = await applyConversationGravity({
      parentText: PARENT,
      drafts: ['So true!'],
      minScore: 3,
      rewrite: async () =>
        'Aundh road after 7 is the only cut that still moves. Has PMC actually opened the Phase 2 drain?',
    });
    expect(result.score).toBeGreaterThanOrEqual(3);
    expect(result.text).toMatch(/Aundh/);
  });

  it('measures token overlap', () => {
    expect(jaccardTokens('hello world', 'hello world')).toBe(1);
    expect(jaccardTokens('hello world', 'completely different tokens here')).toBeLessThan(0.2);
  });
});

describe('author-engaged detection', () => {
  it('ignores the permalink tweet and matches a later article', () => {
    expect(authorAppearsInLaterArticles([
      { authorHandles: ['us'] },
      { authorHandles: ['movie_user'] },
    ], 'movie_user')).toBe(true);
    expect(authorAppearsInLaterArticles([
      { authorHandles: ['movie_user'] },
    ], 'movie_user')).toBe(false);
    expect(authorAppearsInLaterArticles([
      { authorHandles: ['us'] },
      { authorHandles: ['someone_else'] },
    ], 'movie_user')).toBe(false);
  });
});
