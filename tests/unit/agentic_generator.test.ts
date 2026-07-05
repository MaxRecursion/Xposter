import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const queryMock = vi.fn();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (input: unknown) => queryMock(input),
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) =>
    ({ name, description, inputSchema, handler }),
  createSdkMcpServer: (opts: { name: string; tools: unknown[] }) =>
    ({ type: 'sdk', name: opts.name, tools: opts.tools }),
}));

const getSettingMock = vi.fn((_key: string, fallback: string) => fallback);

vi.mock('../../src/storage/queries.js', () => ({
  getSetting: (key: string, fallback: string) => getSettingMock(key, fallback),
  logEvent: vi.fn(),
}));

const cliFoundMock = vi.fn(() => true);

vi.mock('../../src/agent/client.js', () => ({
  isClaudeCliFound: () => cliFoundMock(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

interface MockToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }>;
}

interface CapturedQueryInput {
  prompt: string;
  options: {
    mcpServers: { xposter: { tools: MockToolDef[] } };
    allowedTools: string[];
    disallowedTools: string[];
    systemPrompt: string;
    permissionMode: string;
    maxTurns: number;
    model: string;
    canUseTool: (toolName: string, input: Record<string, unknown>, o: unknown) => Promise<
      { behavior: 'allow' } | { behavior: 'deny'; message: string }
    >;
  };
}

function findSubmitTool(input: CapturedQueryInput): MockToolDef {
  const tool = input.options.mcpServers.xposter.tools.find((t) => t.name.startsWith('submit_'));
  if (!tool) throw new Error('submit tool not registered');
  return tool;
}

/** Configures the query mock to submit the given texts in order, then finish. */
function primeAgentRun(texts: string[]) {
  queryMock.mockImplementation((input: CapturedQueryInput) => {
    return (async function* () {
      const submit = findSubmitTool(input);
      for (const text of texts) {
        await submit.handler({ text }, {});
      }
      yield { type: 'assistant', message: { content: [] } };
      yield {
        type: 'result', subtype: 'success', num_turns: 2, total_cost_usd: 0.0123,
        usage: { input_tokens: 500, output_tokens: 80 },
      };
    })();
  });
}

const VALID_REPLY = 'PMC fixes one pothole and holds a press conference. FC Road has twelve more waiting for their moment.';

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.AGENTIC_GENERATOR_MODEL;
  delete process.env.AGENTIC_GEN_MAX_TURNS;
  delete process.env.CLAUDE_GENERATOR_MODEL;
  delete process.env.CONTEXT_ENABLED;
  getSettingMock.mockImplementation((_key: string, fallback: string) => fallback);
  cliFoundMock.mockImplementation(() => true);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('isAgenticGenerationEnabled', () => {
  it('is off by default (setting fallback is false)', async () => {
    const { isAgenticGenerationEnabled } = await import('../../src/pipeline/agentic_generator.js');
    expect(isAgenticGenerationEnabled()).toBe(false);
  });

  it('is on when the setting is true and the claude CLI is present', async () => {
    getSettingMock.mockImplementation((key: string, fallback: string) =>
      key === 'agentic_generation' ? 'true' : fallback);
    const { isAgenticGenerationEnabled } = await import('../../src/pipeline/agentic_generator.js');
    expect(isAgenticGenerationEnabled()).toBe(true);
  });

  it('is on when the setting is true and only ANTHROPIC_API_KEY is present', async () => {
    getSettingMock.mockImplementation((key: string, fallback: string) =>
      key === 'agentic_generation' ? 'true' : fallback);
    cliFoundMock.mockImplementation(() => false);
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const { isAgenticGenerationEnabled } = await import('../../src/pipeline/agentic_generator.js');
    expect(isAgenticGenerationEnabled()).toBe(true);
  });

  it('is off when the setting is true but no auth exists', async () => {
    getSettingMock.mockImplementation((key: string, fallback: string) =>
      key === 'agentic_generation' ? 'true' : fallback);
    cliFoundMock.mockImplementation(() => false);
    const { isAgenticGenerationEnabled } = await import('../../src/pipeline/agentic_generator.js');
    expect(isAgenticGenerationEnabled()).toBe(false);
  });
});

describe('makeReplyValidator', () => {
  it('accepts a good reply and strips surrounding quotes', async () => {
    const { makeReplyValidator } = await import('../../src/pipeline/agentic_generator.js');
    const validate = makeReplyValidator();
    const result = validate(`"${VALID_REPLY}"`);
    expect(result).toEqual({ ok: true, text: VALID_REPLY });
  });

  it('rejects too-short and too-long texts', async () => {
    const { makeReplyValidator } = await import('../../src/pipeline/agentic_generator.js');
    const validate = makeReplyValidator();
    expect(validate('short')).toMatchObject({ ok: false, reason: expect.stringContaining('too short') });
    expect(validate('x'.repeat(300))).toMatchObject({ ok: false, reason: expect.stringContaining('too long') });
  });

  it('rejects Devanagari, multi-hashtag, and AI-slop texts', async () => {
    const { makeReplyValidator } = await import('../../src/pipeline/agentic_generator.js');
    const validate = makeReplyValidator();
    expect(validate('पुणे traffic is something else this monsoon season')).toMatchObject({
      ok: false, reason: expect.stringContaining('Devanagari'),
    });
    expect(validate('Pune rains hit different this year #pune #monsoon')).toMatchObject({
      ok: false, reason: expect.stringContaining('hashtags'),
    });
    expect(validate('Great point, the metro timeline really did slip again this quarter')).toMatchObject({
      ok: false, reason: expect.stringContaining('AI-slop'),
    });
  });

  it('rejects near-duplicates of avoid texts', async () => {
    const { makeReplyValidator } = await import('../../src/pipeline/agentic_generator.js');
    const validate = makeReplyValidator([VALID_REPLY]);
    expect(validate(VALID_REPLY.toUpperCase())).toMatchObject({
      ok: false, reason: expect.stringContaining('different angle'),
    });
  });
});

describe('runGenerationAgent', () => {
  it('returns the submitted text on a clean run', async () => {
    primeAgentRun([VALID_REPLY]);
    const { generateReplyAgentic } = await import('../../src/pipeline/agentic_generator.js');
    const text = await generateReplyAgentic({
      postId: 'p1', systemPrompt: 'PERSONA', userPrompt: 'Tweet: hello', avoidTexts: [],
    });
    expect(text).toBe(VALID_REPLY);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid submission with a reason, then accepts the fix', async () => {
    const rejectionResults: Array<{ text: string; isError?: boolean }> = [];
    queryMock.mockImplementation((input: CapturedQueryInput) => {
      return (async function* () {
        const submit = findSubmitTool(input);
        const first = await submit.handler({ text: 'x'.repeat(400) }, {});
        rejectionResults.push({ text: first.content[0].text, isError: first.isError });
        const second = await submit.handler({ text: VALID_REPLY }, {});
        rejectionResults.push({ text: second.content[0].text, isError: second.isError });
        yield { type: 'result', subtype: 'success', num_turns: 3, total_cost_usd: 0.02, usage: {} };
      })();
    });

    const { generateReplyAgentic } = await import('../../src/pipeline/agentic_generator.js');
    const text = await generateReplyAgentic({ postId: 'p2', systemPrompt: 'P', userPrompt: 'U' });

    expect(text).toBe(VALID_REPLY);
    expect(rejectionResults[0].isError).toBe(true);
    expect(rejectionResults[0].text).toContain('REJECTED');
    expect(rejectionResults[0].text).toContain('too long');
    expect(rejectionResults[1].isError).toBeUndefined();
    expect(rejectionResults[1].text).toContain('ACCEPTED');
  });

  it('throws when the agent never submits', async () => {
    queryMock.mockImplementation(() => (async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'here is my reply: hi' }] } };
      yield { type: 'result', subtype: 'success', num_turns: 12, total_cost_usd: 0.05, usage: {} };
    })());

    const { generateReplyAgentic } = await import('../../src/pipeline/agentic_generator.js');
    await expect(
      generateReplyAgentic({ postId: 'p3', systemPrompt: 'P', userPrompt: 'U' }),
    ).rejects.toThrow(/no accepted reply/);
  });

  it('configures the SDK loop safely: MCP-only tools, deny-by-default, agent instructions', async () => {
    primeAgentRun([VALID_REPLY]);
    const { generateReplyAgentic } = await import('../../src/pipeline/agentic_generator.js');
    await generateReplyAgentic({ postId: 'p4', systemPrompt: 'PERSONA BLOCK', userPrompt: 'U' });

    const input = queryMock.mock.calls[0][0] as CapturedQueryInput;
    expect(input.options.permissionMode).toBe('default');
    expect(input.options.maxTurns).toBe(12);
    expect(input.options.allowedTools.length).toBeGreaterThan(0);
    expect(input.options.allowedTools.every((t) => t.startsWith('mcp__xposter__'))).toBe(true);
    expect(input.options.allowedTools).toContain('mcp__xposter__submit_reply');
    expect(input.options.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write', 'WebFetch']));
    expect(input.options.systemPrompt).toContain('PERSONA BLOCK');
    expect(input.options.systemPrompt).toContain('AGENT WORKFLOW');
    expect(input.options.systemPrompt).toContain('submit_reply');

    await expect(input.options.canUseTool('mcp__xposter__submit_reply', {}, {})).resolves.toEqual({ behavior: 'allow' });
    await expect(input.options.canUseTool('Bash', {}, {})).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('honors AGENTIC_GEN_MAX_TURNS and AGENTIC_GENERATOR_MODEL overrides', async () => {
    process.env.AGENTIC_GEN_MAX_TURNS = '5';
    process.env.AGENTIC_GENERATOR_MODEL = 'claude-sonnet-5';
    primeAgentRun([VALID_REPLY]);
    const { generateReplyAgentic } = await import('../../src/pipeline/agentic_generator.js');
    await generateReplyAgentic({ postId: 'p5', systemPrompt: 'P', userPrompt: 'U' });

    const input = queryMock.mock.calls[0][0] as CapturedQueryInput;
    expect(input.options.maxTurns).toBe(5);
    expect(input.options.model).toBe('claude-sonnet-5');
  });

  it('validates original posts through the caller-supplied quality gate', async () => {
    const attempts: Array<{ isError?: boolean }> = [];
    queryMock.mockImplementation((input: CapturedQueryInput) => {
      return (async function* () {
        const submit = findSubmitTool(input);
        // no sentence-ending punctuation → rejected by qualityCheck
        const bad = await submit.handler({ text: 'pune tech scene is changing fast and nobody is ready for it' }, {});
        attempts.push({ isError: bad.isError });
        const good = await submit.handler({
          text: 'Pune added three GCCs this quarter while campus placements shrank. The jobs debate is about quality now, not count. What does that mean for freshers?',
        }, {});
        attempts.push({ isError: good.isError });
        yield { type: 'result', subtype: 'success', num_turns: 2, total_cost_usd: 0.01, usage: {} };
      })();
    });

    const { runGenerationAgent } = await import('../../src/pipeline/agentic_generator.js');
    const { cleanModelText, charLength } = await import('../../src/pipeline/text_constraints.js');

    const text = await runGenerationAgent({
      kind: 'post',
      systemPrompt: 'P',
      userPrompt: 'U',
      validate: (raw) => {
        const t = cleanModelText(raw);
        if (charLength(t) === 0) return { ok: false, reason: 'empty text' };
        if (!/[.!?]/.test(t)) return { ok: false, reason: 'no sentence-ending punctuation found' };
        return { ok: true, text: t };
      },
    });

    expect(attempts[0].isError).toBe(true);
    expect(attempts[1].isError).toBeUndefined();
    expect(text).toContain('GCCs');
    // submit tool for posts is named submit_post
    const input = queryMock.mock.calls[0][0] as CapturedQueryInput;
    expect(input.options.allowedTools).toContain('mcp__xposter__submit_post');
  });
});
