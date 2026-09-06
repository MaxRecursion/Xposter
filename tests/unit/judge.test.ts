import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Interaction } from '../../src/storage/interactions.js';
import type { Post } from '../../src/storage/posts.js';

vi.mock('groq-sdk', () => {
  const mockCreate = vi.fn();
  return {
    default: vi.fn().mockImplementation(function GroqMock() {
      return { chat: { completions: { create: mockCreate } } };
    }),
    __mockCreate: mockCreate,
  };
});

vi.mock('../../src/storage/queries.js', () => ({
  logEvent: vi.fn(),
}));

function makeInteraction(overrides: Partial<Interaction> = {}): Interaction {
  return {
    id: 1,
    post_id: 'post-1',
    account_handle: 'punekr',
    our_reply_text: 'Baner drainage doing its annual disappearing act.',
    our_tweet_id: '111',
    our_tweet_url: 'https://x.com/us/status/111',
    posted_at: Math.floor(Date.now() / 1000),
    likes_received: 5,
    replies_received: 1,
    retweets_received: 0,
    impressions: 200,
    last_metric_check: Math.floor(Date.now() / 1000),
    success_score: 6,
    author_engaged: 0,
    content_structure: 'standard',
    notes: null,
    judge_score: null,
    judge_reasoning: null,
    judge_evaluated_at: null,
    ...overrides,
  };
}

function makePost(overrides: Partial<Post> = {}): Post {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: 'post-1',
    tweet_id: '99999',
    author_handle: 'punekr',
    author_name: 'Pune Resident',
    text: 'Heavy rain in Pune again, Baner roads are completely waterlogged this evening.',
    language: 'english',
    timestamp: now - 300,
    likes: 4, replies: 1, retweets: 0,
    tweet_url: 'https://x.com/punekr/status/99999',
    status: 'POSTED',
    score: 72, score_breakdown: null,
    generated_reply: null, final_reply: null,
    posted_tweet_id: null, source: 'TIMELINE', stance: null, trend_key: null,
    engagement_mode: null, deleted_at: null, posting_attempts: 0, retry_after: null,
    last_error: null, tournament_strategy: null, tournament_angle: null,
    tournament_critic_score: null, tournament_critic_reasons: null,
    obs_likes: null, obs_replies: null, obs_at: null,
    ingested_at: now, updated_at: now,
    ...overrides,
  };
}

describe('evaluateReply', () => {
  beforeEach(() => {
    process.env.GROQ_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.GROQ_API_KEY;
    delete process.env.GROQ_JUDGE_MODEL;
  });

  it('marks a high score as passed', async () => {
    const { __mockCreate } = await import('groq-sdk') as { __mockCreate: ReturnType<typeof vi.fn> };
    __mockCreate.mockResolvedValue({
      choices: [{ message: { content: '{"score": 82, "reasoning": "Direct, specific, engages with the flooding claim."}' } }],
    });

    const { evaluateReply } = await import('../../src/eval/judge.js');
    const result = await evaluateReply(makeInteraction(), makePost());

    expect(result.score).toBe(82);
    expect(result.passed).toBe(true);
    expect(result.reasoning).toContain('specific');
  });

  it('marks a low score as failed, using the score threshold rather than trusting the model', async () => {
    const { __mockCreate } = await import('groq-sdk') as { __mockCreate: ReturnType<typeof vi.fn> };
    __mockCreate.mockResolvedValue({
      choices: [{ message: { content: '{"score": 40, "reasoning": "Generic agreement, no new detail."}' } }],
    });

    const { evaluateReply } = await import('../../src/eval/judge.js');
    const result = await evaluateReply(makeInteraction(), makePost());

    expect(result.score).toBe(40);
    expect(result.passed).toBe(false);
  });

  it('treats a boundary score of exactly 65 as passed', async () => {
    const { __mockCreate } = await import('groq-sdk') as { __mockCreate: ReturnType<typeof vi.fn> };
    __mockCreate.mockResolvedValue({
      choices: [{ message: { content: '{"score": 65, "reasoning": "Adequate but unremarkable."}' } }],
    });

    const { evaluateReply } = await import('../../src/eval/judge.js');
    const result = await evaluateReply(makeInteraction(), makePost());

    expect(result.passed).toBe(true);
  });

  it('degrades to a failed 0 score on unparseable model output, without throwing', async () => {
    const { __mockCreate } = await import('groq-sdk') as { __mockCreate: ReturnType<typeof vi.fn> };
    __mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Sorry, I cannot score this.' } }],
    });

    const { evaluateReply } = await import('../../src/eval/judge.js');
    const result = await evaluateReply(makeInteraction(), makePost());

    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
  });

  it('skips scoring when no Groq API key is configured', async () => {
    delete process.env.GROQ_API_KEY;
    const { evaluateReply } = await import('../../src/eval/judge.js');
    const result = await evaluateReply(makeInteraction(), makePost());

    expect(result.passed).toBe(false);
    expect(result.reasoning).toContain('GROQ_API_KEY');
  });

  it('handles a missing source post without crashing', async () => {
    const { __mockCreate } = await import('groq-sdk') as { __mockCreate: ReturnType<typeof vi.fn> };
    __mockCreate.mockResolvedValue({
      choices: [{ message: { content: '{"score": 55, "reasoning": "Cannot verify relevance without the source tweet."}' } }],
    });

    const { evaluateReply } = await import('../../src/eval/judge.js');
    const result = await evaluateReply(makeInteraction(), null);

    expect(result.score).toBe(55);
    const userMsg = __mockCreate.mock.calls[0][0].messages.find((m: any) => m.role === 'user').content;
    expect(userMsg).toContain('original tweet unavailable');
  });
});
