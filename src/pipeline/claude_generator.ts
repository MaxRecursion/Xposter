import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger.js';

const DEFAULT_MODEL = 'claude-opus-4-8';

let _client: Anthropic | null = null;

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

export function isClaudeAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export async function generateWithClaude(
  systemPrompt: string,
  userPrompt: string,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
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
