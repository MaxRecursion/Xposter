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

  it('asks for gentle Puneri wit without personal insults', async () => {
    const { __mockCreate } = await import('groq-sdk') as any;
    __mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Pune traffic doing its daily stand-up set.' } }],
    });

    const { generateReply } = await import('../../src/pipeline/generator.js');
    await generateReply(makePost());

    const callArgs = __mockCreate.mock.calls[0][0];
    const systemMsg = callArgs.messages.find((m: any) => m.role === 'system').content;
    expect(systemMsg).toContain('gentle Puneri wit');
    expect(systemMsg).toContain('Make the situation the joke, not the person');
  });

  it('keeps generated replies within 200 characters', async () => {
    const { __mockCreate } = await import('groq-sdk') as any;
    __mockCreate.mockResolvedValue({
      choices: [{
        message: {
          content:
            'Pune traffic is doing such a committed performance today that even Google Maps must be sitting quietly with cutting chai and rethinking its career choices near Hinjewadi, because this plot twist has gone on too long.',
        },
      }],
    });

    const { generateReply } = await import('../../src/pipeline/generator.js');
    const result = await generateReply(makePost());
    expect(Array.from(result).length).toBeLessThanOrEqual(200);
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

  it('includes Marathi language instruction for Marathi posts', async () => {
    const { __mockCreate } = await import('groq-sdk') as any;
    __mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'पाऊस खूप आहे आज!' } }],
    });

    const { generateReply } = await import('../../src/pipeline/generator.js');
    const marathiPost = makePost({ language: 'marathi', text: 'पुण्यात आज पाऊस किती होता?' });
    const result = await generateReply(marathiPost);

    // Verify the prompt contained Marathi language signal
    const callArgs = __mockCreate.mock.calls[0][0];
    const userMsg = callArgs.messages.find((m: any) => m.role === 'user').content;
    expect(userMsg).toContain('Marathi');
    expect(result).toBe('पाऊस खूप आहे आज!');
  });
});
