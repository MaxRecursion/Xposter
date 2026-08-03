import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('groq-sdk', () => {
  const mockCreate = vi.fn();
  return {
    default: vi.fn().mockImplementation(function GroqMock() {
      return { chat: { completions: { create: mockCreate } } };
    }),
    __mockCreate: mockCreate,
  };
});

vi.mock('../../src/pipeline/agentic_generator.js', () => ({
  isAgenticGenerationEnabled: () => false,
  AGENTIC_MAX_ATTEMPTS: 2,
  getAgenticModel: () => 'agent-model',
  runGenerationAgent: vi.fn(),
}));

vi.mock('../../src/pipeline/claude_generator.js', () => ({
  isClaudeAvailable: () => false,
  claudeGeneratorModel: () => 'claude-test',
  generateWithClaude: vi.fn(),
}));

vi.mock('../../src/storage/queries.js', () => ({
  logEvent: vi.fn(),
}));

describe('generateText', () => {
  beforeEach(() => {
    process.env.GROQ_API_KEY = 'test-key';
    process.env.GROQ_MODEL = 'llama-test';
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('returns Groq text when agentic and Claude are disabled', async () => {
    const { __mockCreate } = await import('groq-sdk') as { __mockCreate: ReturnType<typeof vi.fn> };
    __mockCreate.mockResolvedValue({
      choices: [{ message: { content: '  Groq reply text here  ' } }],
    });

    const { generateText } = await import('../../src/pipeline/llm_runner.js');
    const result = await generateText({
      taskName: 'test_task',
      systemPrompt: 'system',
      userPrompt: 'user',
      groq: { maxTokens: 100 },
    });

    expect(result).toBe('Groq reply text here');
    expect(__mockCreate).toHaveBeenCalledOnce();
  });

  it('throws EmptyReplyError when all providers return short text', async () => {
    const { __mockCreate } = await import('groq-sdk') as { __mockCreate: ReturnType<typeof vi.fn> };
    __mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'hi' } }],
    });

    const { generateText } = await import('../../src/pipeline/llm_runner.js');
    const { EmptyReplyError } = await import('../../src/pipeline/errors.js');

    await expect(generateText({
      taskName: 'test_task',
      systemPrompt: 'system',
      userPrompt: 'user',
      minChars: 10,
      groq: { maxTokens: 100 },
    })).rejects.toBeInstanceOf(EmptyReplyError);
  });
});
