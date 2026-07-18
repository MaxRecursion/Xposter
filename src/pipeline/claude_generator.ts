import Anthropic from '@anthropic-ai/sdk';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';

const DEFAULT_MODEL = 'claude-opus-4-8';
const execFileAsync = promisify(execFile);

let _client: Anthropic | null = null;
let _cliAvailableCache: boolean | null = null;

function getClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  _client = new Anthropic({ apiKey });
  return _client;
}

export function claudeGeneratorModel(): string {
  return process.env.CLAUDE_GENERATOR_MODEL ?? DEFAULT_MODEL;
}

/** Check once whether the `claude` CLI binary is reachable. Result is cached. */
async function checkCliAvailable(): Promise<boolean> {
  if (_cliAvailableCache !== null) return _cliAvailableCache;
  try {
    await execFileAsync('claude', ['--version'], { timeout: 5_000 });
    _cliAvailableCache = true;
  } catch {
    _cliAvailableCache = false;
  }
  return _cliAvailableCache;
}

/**
 * Generate text using the local `claude -p` CLI, which draws from the user's
 * Pro/Max subscription rather than pay-per-token API credits.
 * The system prompt is prepended to the user message separated by a clear boundary.
 */
async function generateWithClaudeCli(
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  // Combine system + user prompt — the CLI doesn't have a separate --system flag
  // in non-interactive mode, so we inject the system instructions at the top.
  const combinedPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}`;

  const { stdout } = await execFileAsync(
    'claude',
    ['-p', combinedPrompt],
    {
      timeout: 45_000,
      maxBuffer: 512 * 1024,
      env: { ...process.env },
    },
  );

  const text = stdout.trim();
  if (text.length < 5) throw new Error('Claude CLI returned empty response');
  return text;
}

/**
 * Returns true when ANY Claude path is available:
 *   1. CLI binary is present (Pro/Max subscription)
 *   2. API key is configured (paid API credits)
 */
export function isClaudeAvailable(): boolean {
  // Sync check: either path qualifies
  return !!process.env.ANTHROPIC_API_KEY || _cliAvailableCache === true;
}

/**
 * Prime the CLI availability cache so isClaudeAvailable() is accurate
 * before the first generation call. Call this once at startup.
 */
export async function primeClaudeCliCheck(): Promise<void> {
  const available = await checkCliAvailable();
  logger.info('Claude CLI availability check', { available });
}

export async function generateWithClaude(
  systemPrompt: string,
  userPrompt: string,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  // ── 1. Try Claude CLI (Pro/Max subscription, no API credits needed) ──────────
  const cliAvailable = await checkCliAvailable();
  if (cliAvailable) {
    try {
      logger.debug('Trying Claude CLI for generation');
      const text = await generateWithClaudeCli(systemPrompt, userPrompt);
      logger.info('Claude CLI generation succeeded', { chars: text.length });
      return { text, inputTokens: 0, outputTokens: 0 };
    } catch (err) {
      logger.warn('Claude CLI generation failed, trying API', { err: String(err) });
    }
  }

  // ── 2. Try Anthropic API (requires credits) ──────────────────────────────────
  const client = getClient();
  logger.debug('Calling Anthropic messages.create', { model: claudeGeneratorModel() });
  const response = await client.messages.create({
    model: claudeGeneratorModel(),
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('');
  return {
    text,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
