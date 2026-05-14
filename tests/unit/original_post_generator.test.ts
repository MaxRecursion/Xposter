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

  it('retries when the first original post draft is over 280 characters', async () => {
    expect(Array.from(slightlyLongDraft).length).toBeGreaterThan(280);
    const { __mockCreate } = await import('groq-sdk') as any;
    __mockCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: slightlyLongDraft } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: validDraft } }] });

    const { generateOriginalPost } = await import('../../src/pipeline/original_post_generator.js');
    const result = await generateOriginalPost();

    expect(result.content).toBe(validDraft);
    expect(__mockCreate).toHaveBeenCalledTimes(2);
    const retryPrompt = __mockCreate.mock.calls[1][0].messages.find((m: any) => m.role === 'user').content;
    expect(retryPrompt).toContain('Previous draft failed quality check: too long');
    expect(retryPrompt).toContain('280 characters or fewer');
  });

  it('compacts a still-too-long repaired draft instead of failing the run', async () => {
    const { __mockCreate } = await import('groq-sdk') as any;
    __mockCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: slightlyLongDraft } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: slightlyLongDraft } }] });

    const { generateOriginalPost } = await import('../../src/pipeline/original_post_generator.js');
    const result = await generateOriginalPost();

    expect(Array.from(result.content).length).toBeLessThanOrEqual(280);
    expect(result.content).toMatch(/[.!?]$/);
  });

  it('compacts even a no-space overlong draft without exceeding 280 characters', async () => {
    const { compactOriginalPostForX } = await import('../../src/pipeline/original_post_generator.js');
    const result = compactOriginalPostForX('a'.repeat(300));

    expect(Array.from(result).length).toBeLessThanOrEqual(280);
    expect(result).toMatch(/[.!?]$/);
  });
});
