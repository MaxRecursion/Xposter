import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Post } from '../../src/storage/queries.js';

// Mock the groq-sdk module before importing generator
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

vi.mock('../../src/context/neural_memory.js', () => ({
  recallNeuralMemory: () => '',
}));

function makePost(overrides: Partial<Post> = {}): Post {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: 'gen-test-id',
    tweet_id: '99999',
    author_handle: 'punekr',
    author_name: 'Pune Resident',
    text: 'Traffic is terrible near Hinjewadi today, any alternatives?',
    language: 'english',
    timestamp: now - 300,
    likes: 3, replies: 1, retweets: 0,
    tweet_url: 'https://x.com/punekr/status/99999',
    status: 'GENERATING',
    score: 72,
    score_breakdown: null,
    generated_reply: null,
    final_reply: null,
    ingested_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('generateReply', () => {
  beforeEach(() => {
    process.env.GROQ_API_KEY = 'test-key-mock';
    process.env.GROQ_MODEL = 'llama-3.3-70b-versatile';
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('returns the LLM reply text', async () => {
    const { __mockCreate } = await import('groq-sdk') as any;
    __mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Try the Aundh road route, usually lighter traffic.' } }],
    });

    const { generateReply } = await import('../../src/pipeline/generator.js');
    const result = await generateReply(makePost());
    expect(result).toBe('Try the Aundh road route, usually lighter traffic.');
  });

  it('strips surrounding quotes from the reply', async () => {
    const { __mockCreate } = await import('groq-sdk') as any;
    __mockCreate.mockResolvedValue({
      choices: [{ message: { content: '"Try Wakad bridge route instead."' } }],
    });

    const { generateReply } = await import('../../src/pipeline/generator.js');
    const result = await generateReply(makePost());
    expect(result).toBe('Try Wakad bridge route instead.');
  });

  it('asks for satirical Puneri voice without personal insults', async () => {
    const { __mockCreate } = await import('groq-sdk') as any;
    __mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Pune traffic doing its daily stand-up set.' } }],
    });

    const { generateReply } = await import('../../src/pipeline/generator.js');
    await generateReply(makePost());

    const callArgs = __mockCreate.mock.calls[0][0];
    const systemMsg = callArgs.messages.find((m: any) => m.role === 'system').content;
    expect(systemMsg).toContain('sharp, satirical Punekar');
    expect(systemMsg).toContain('Make the SITUATION the joke');
    expect(systemMsg).toContain('ONE-LINE PUNCH');
    expect(systemMsg).toContain('3-4 LINE TAKE');
  });

  it('keeps generated replies within 280 characters', async () => {
    const { __mockCreate } = await import('groq-sdk') as any;
    __mockCreate.mockResolvedValue({
      choices: [{
        message: {
          content:
            'Pune traffic is doing such a committed performance today that even Google Maps must be sitting quietly with cutting chai and rethinking its career choices near Hinjewadi, because this plot twist has gone on too long. Honestly at this point we deserve a writing credit for the chaos.',
        },
      }],
    });

    const { generateReply } = await import('../../src/pipeline/generator.js');
    const result = await generateReply(makePost());
    expect(Array.from(result).length).toBeLessThanOrEqual(280);
  });

  it('throws when API key is missing', async () => {
    delete process.env.GROQ_API_KEY;
    const { generateReply } = await import('../../src/pipeline/generator.js');
    await expect(generateReply(makePost())).rejects.toThrow('GROQ_API_KEY');
  });

  it('throws when Groq returns empty content', async () => {
    const { __mockCreate } = await import('groq-sdk') as any;
    __mockCreate.mockResolvedValue({
      choices: [{ message: { content: '' } }],
    });

    const { generateReply } = await import('../../src/pipeline/generator.js');
    await expect(generateReply(makePost())).rejects.toThrow('empty reply');
  });

  it('always instructs the model to reply in English only', async () => {
    const { __mockCreate } = await import('groq-sdk') as any;
    __mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Pune monsoon hits like clockwork.' } }],
    });

    const { generateReply } = await import('../../src/pipeline/generator.js');
    // Even when the upstream tweet is Marathi, our reply policy is English only.
    const marathiPost = makePost({ language: 'marathi', text: 'पुण्यात आज पाऊस किती होता?' });
    const result = await generateReply(marathiPost);

    const callArgs = __mockCreate.mock.calls[0][0];
    const systemMsg = callArgs.messages.find((m: any) => m.role === 'system').content;
    expect(systemMsg).toContain('sharp, polished English only');
    expect(result).toBe('Pune monsoon hits like clockwork.');
  });

  it('adds recent replies to the retry prompt when avoiding duplicates', async () => {
    const { __mockCreate } = await import('groq-sdk') as any;
    __mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'A genuinely different angle.' } }],
    });

    const { generateReply } = await import('../../src/pipeline/generator.js');
    await generateReply(makePost(), null, {
      avoidTexts: ['Pune traffic has impeccable timing.'],
    });

    const callArgs = __mockCreate.mock.calls[0][0];
    const userMsg = callArgs.messages.find((m: any) => m.role === 'user').content;
    expect(userMsg).toContain('VARIETY REQUIREMENT');
    expect(userMsg).toContain('Pune traffic has impeccable timing.');
  });
});
