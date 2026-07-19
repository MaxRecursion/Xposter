import Anthropic from '@anthropic-ai/sdk';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';

const DEFAULT_MODEL = 'claude-fable-5';
const CLI_MODEL_FALLBACK_CHAIN = ['fable', 'opus'];
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

  // ANTHROPIC_API_KEY takes precedence over the claude.ai login inside the CLI,
  // which would bill the API account instead of the Pro/Max subscription.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  // Try each model in the fallback chain (fable → opus) until one succeeds.
  // This lets us use the newest model and automatically step down when rate-limited.
  let lastErr: unknown;
  for (const model of CLI_MODEL_FALLBACK_CHAIN) {
    try {
      const pending = execFileAsync(
        'claude',
        ['-p', combinedPrompt, '--model', model],
        {
          timeout: 45_000,
          maxBuffer: 512 * 1024,
          env,
        },
      );
      // The CLI waits 3s for piped stdin unless it is closed up front.
      pending.child.stdin?.end();
      const { stdout } = await pending;

      const text = stdout.trim();
      if (text.length < 5) throw new Error(`Claude CLI (${model}) returned empty response`);
      logger.info('Claude CLI generation succeeded', { model, chars: text.length });
      return text;
    } catch (err) {
      const e = err as { code?: number | string; signal?: string; stdout?: string; stderr?: string };
      logger.warn(`Claude CLI model=${model} failed, trying next in chain`, {
        code: e.code, signal: e.signal,
        stdout: (e.stdout ?? '').trim().slice(0, 200),
        stderr: (e.stderr ?? '').trim().slice(-200),
      });
      lastErr = err;
    }
  }
  throw lastErr;
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
      logger.debug('Trying Claude CLI for generation (fable → opus chain)');
      const text = await generateWithClaudeCli(systemPrompt, userPrompt);
      return { text, inputTokens: 0, outputTokens: 0 };
    } catch (err) {
      logger.warn('Claude CLI chain exhausted (fable + opus both failed), trying API', { err: String(err) });
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
