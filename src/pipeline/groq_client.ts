import Groq from 'groq-sdk';
import { getGroqApiKey } from '../config.js';

let _groq: Groq | null = null;

export function getGroqClient(): Groq {
  if (_groq) return _groq;
  const apiKey = getGroqApiKey();
  if (!apiKey) throw new Error('GROQ_API_KEY is not set');
  _groq = new Groq({ apiKey });
  return _groq;
}

export function getOptionalGroqClient(): Groq | null {
  try {
    return getGroqClient();
  } catch {
    return null;
  }
}

/**
 * Extra params for Groq reasoning models (the `gpt-oss` family).
 *
 * These models emit chain-of-thought into a separate `reasoning` field and put
 * the answer in `content`. At default effort they happily spend the whole
 * `max_tokens` budget thinking and return an EMPTY `content`, which surfaces
 * here as an EmptyReplyError. Our outputs are tweet-sized, so pin effort low.
 */
export function groqReasoningParams(model: string): Record<string, unknown> {
  return /gpt-oss/i.test(model) ? { reasoning_effort: 'low' } : {};
}
