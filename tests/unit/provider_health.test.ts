import { afterEach, describe, expect, it } from 'vitest';
import {
  groqModelIsListed,
  isClaudeAuthFailureMessage,
  isClaudeCliAuthBlocked,
  noteClaudeAuthFailure,
  parseGroqModelIds,
  resetClaudeAuthCircuit,
} from '../../src/pipeline/provider_health.js';

describe('Groq model health parsing', () => {
  it('reads ids from an OpenAI-style models list payload', () => {
    expect(parseGroqModelIds({
      data: [
        { id: 'openai/gpt-oss-120b' },
        { id: 'llama-3.3-70b-versatile' },
      ],
    })).toEqual(['openai/gpt-oss-120b', 'llama-3.3-70b-versatile']);
  });

  it('accepts a bare array of ids', () => {
    expect(parseGroqModelIds(['openai/gpt-oss-120b'])).toEqual(['openai/gpt-oss-120b']);
  });

  it('matches the configured model case-insensitively', () => {
    expect(groqModelIsListed('OpenAI/GPT-OSS-120B', ['openai/gpt-oss-120b'])).toBe(true);
    expect(groqModelIsListed('missing-model', ['openai/gpt-oss-120b'])).toBe(false);
  });
});

describe('Claude CLI auth circuit breaker', () => {
  afterEach(() => {
    resetClaudeAuthCircuit();
  });

  it('trips once on a known auth failure and stays open', () => {
    expect(noteClaudeAuthFailure('Error: not logged in')).toBe(true);
    expect(isClaudeCliAuthBlocked()).toBe(true);
    expect(noteClaudeAuthFailure('please run claude login')).toBe(false);
    expect(isClaudeAuthFailureMessage('OAuth token expired')).toBe(true);
    expect(isClaudeAuthFailureMessage('rate limit exceeded')).toBe(false);
  });
});
