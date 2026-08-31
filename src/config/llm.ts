import { parseIntValue } from './parse.js';

const DEFAULT_CLAUDE_GENERATOR_MODEL = 'claude-opus-5';
const DEFAULT_AGENTIC_GEN_MAX_TURNS = 12;
const DEFAULT_IMAGE_QA_MODEL = 'opus';

export function getImageQaModel(): string {
  return process.env.IMAGE_QA_MODEL?.trim() || DEFAULT_IMAGE_QA_MODEL;
}

export function getClaudeGeneratorModel(): string {
  return process.env.CLAUDE_GENERATOR_MODEL?.trim() || DEFAULT_CLAUDE_GENERATOR_MODEL;
}

export function getGroqApiKey(): string | null {
  return process.env.GROQ_API_KEY?.trim() || null;
}

export function getGroqModel(): string {
  return process.env.GROQ_MODEL?.trim() || 'openai/gpt-oss-120b';
}

export function getAnthropicApiKey(): string | null {
  return process.env.ANTHROPIC_API_KEY?.trim() || null;
}

export function getAgenticGeneratorModel(): string {
  return process.env.AGENTIC_GENERATOR_MODEL?.trim() || DEFAULT_CLAUDE_GENERATOR_MODEL;
}

export function getAgenticGenMaxTurns(): number {
  return parseIntValue(process.env.AGENTIC_GEN_MAX_TURNS, DEFAULT_AGENTIC_GEN_MAX_TURNS, 1);
}

/**
 * Wall-clock ceiling for one agentic generation.
 *
 * Turn count bounds the conversation, not the time: a research loop with web
 * tools legitimately runs many minutes, and a wedged CLI subprocess produces no
 * turns at all and would otherwise wait forever while holding the scheduler's
 * single-flight guard. Generous by design — this is a hang breaker, not a
 * latency target.
 */
export function getAgenticTimeoutMs(): number {
  return parseIntValue(process.env.AGENTIC_TIMEOUT_MS, 15 * 60_000, 30_000);
}

/** Wall-clock ceiling for a single-shot Claude or Groq completion. */
export function getLlmTimeoutMs(): number {
  return parseIntValue(process.env.LLM_TIMEOUT_MS, 3 * 60_000, 10_000);
}

export function getGroqClassifierModel(): string {
  return process.env.GROQ_CLASSIFIER_MODEL?.trim() || getGroqModel();
}

export function getOpenAiApiKey(): string | null {
  return process.env.OPENAI_API_KEY?.trim() || null;
}
