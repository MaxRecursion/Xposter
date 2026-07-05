import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('groq-sdk', () => {
  const mockCreate = vi.fn();
  return {
    default: vi.fn().mockImplementation(function GroqMock() {
      return {
        chat: { completions: { create: mockCreate } },
      };
    }),
    __mockCreate: mockCreate,
  };
});

vi.mock('../../src/storage/queries.js', () => ({
  getRecentPosts: () => [],
  logEvent: vi.fn(),
  // agentic_generator (imported by the generator) reads the agentic_generation
  // setting; returning the fallback keeps the agentic path disabled in tests.
  getSetting: (_key: string, fallback: string) => fallback,
}));

vi.mock('../../src/context/enrich.js', () => ({
  isContextEnabled: () => false,
  enrichPrompt: vi.fn(),
}));

vi.mock('../../src/context/neural_memory.js', () => ({
  recallNeuralMemory: () => '',
}));

vi.mock('../../src/pipeline/topic_categories.js', () => ({
  pickTopicAndCategory: () => ({
    topic: 'AI jobs in Pune',
    category: 'pune-tech-economy',
  }),
}));

const validDraft =
  'Pune AI hiring is moving from headcount plans to automation bets. Founders in Hinjewadi need judgment, not just cheaper workflows. Who adapts first?';

const slightlyLongDraft =
  'Pune AI jobs are moving faster than the old hiring playbook. '.repeat(4) +
  'Who is ready for the second-order effects?';

describe('generateOriginalPost', () => {
  beforeEach(() => {
    process.env.GROQ_API_KEY = 'test-key-mock';
    process.env.GROQ_MODEL = 'llama-3.3-70b-versatile';
    process.env.LOG_PROMPTS = 'false';
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('turns an over-280 draft into a sentence-boundary thread', async () => {
    expect(Array.from(slightlyLongDraft).length).toBeGreaterThan(280);
    const { __mockCreate } = await import('groq-sdk') as any;
    __mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: slightlyLongDraft } }],
    });

    const { generateOriginalPost } = await import('../../src/pipeline/original_post_generator.js');
    const result = await generateOriginalPost();

    expect(result.content).toBe(slightlyLongDraft);
    expect(result.parts.length).toBeGreaterThanOrEqual(2);
    expect(result.parts.length).toBeLessThanOrEqual(3);
    expect(result.parts.every((part) => Array.from(part).length <= 280)).toBe(true);
    expect(__mockCreate).toHaveBeenCalledTimes(1);
  });

  it('packs complete sentences greedily into thread parts', async () => {
    const { splitOriginalPostThread } = await import('../../src/pipeline/original_post_generator.js');
    const result = splitOriginalPostThread(slightlyLongDraft);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatch(/[.!?]$/);
    expect(result[1]).toMatch(/[.!?]$/);
  });

  it('compacts even a no-space overlong draft without exceeding 280 characters', async () => {
    const { compactOriginalPostForX } = await import('../../src/pipeline/original_post_generator.js');
    const result = compactOriginalPostForX('a'.repeat(300));

    expect(Array.from(result).length).toBeLessThanOrEqual(280);
    expect(result).toMatch(/[.!?]$/);
  });

  it('adds recent originals to the retry prompt when avoiding duplicates', async () => {
    const { __mockCreate } = await import('groq-sdk') as any;
    __mockCreate.mockResolvedValue({
      choices: [{ message: { content: validDraft } }],
    });

    const { generateOriginalPost } = await import('../../src/pipeline/original_post_generator.js');
    const result = await generateOriginalPost({
      avoidTexts: ['Pune founders keep recycling the same automation take.'],
    });

    const callArgs = __mockCreate.mock.calls[0][0];
    const userMsg = callArgs.messages.find((m: any) => m.role === 'user').content;
    expect(userMsg).toContain('VARIETY REQUIREMENT');
    expect(userMsg).toContain('Pune founders keep recycling the same automation take.');
    expect(result.parts).toEqual([validDraft]);
  });

  it('generates concise quote-tweet commentary from a source post', async () => {
    const { __mockCreate } = await import('groq-sdk') as any;
    __mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'The real shift is not fewer jobs, but a much higher premium on judgment.' } }],
    });

    const { generateQuoteTweetPost } = await import('../../src/pipeline/original_post_generator.js');
    const now = Math.floor(Date.now() / 1000);
    const result = await generateQuoteTweetPost({
      id: 'source-post',
      tweet_id: '1723456789012347001',
      author_handle: 'source_author',
      author_name: 'Source Author',
      text: 'AI automation is changing hiring across Pune startups.',
      language: 'english',
      timestamp: now - 300,
      likes: 50,
      replies: 8,
      retweets: 5,
      tweet_url: 'https://x.com/source_author/status/1723456789012347001',
      status: 'INGESTED',
      score: null,
      score_breakdown: null,
      generated_reply: null,
      final_reply: null,
      posted_tweet_id: null,
      deleted_at: null,
      posting_attempts: 0,
      retry_after: null,
      last_error: null,
      ingested_at: now - 300,
      updated_at: now - 300,
    });

    expect(result.parts).toEqual([result.content]);
    expect(result.content.length).toBeLessThanOrEqual(250);
    expect(result.topic).toContain('quote:');
    const prompt = __mockCreate.mock.calls[0][0].messages.find((m: any) => m.role === 'user').content;
    expect(prompt).toContain('AI automation is changing hiring across Pune startups.');
    expect(prompt).toContain('Do not include the source URL');
  });
});
