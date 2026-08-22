/**
 * Groq model preflight + Claude CLI auth circuit breaker.
 *
 * Groq: list account-available models and record whether GROQ_MODEL is usable.
 * Claude: one known "not logged in" / OAuth failure trips a process-lifetime
 * breaker so every later candidate skips CLI/agentic delay and goes to Groq.
 */
import { getGroqApiKey, getGroqModel } from '../config.js';
import { logger } from '../utils/logger.js';
import { getOptionalGroqClient } from './groq_client.js';

export interface GroqHealthSnapshot {
  configured: boolean;
  configured_model: string;
  available: boolean | null;
  available_models: string[];
  checked_at: number | null;
  error: string | null;
}

const GROQ_PROBE_MS = 15 * 60_000;

let _groqHealth: GroqHealthSnapshot = emptyGroqHealth();
let _probeTimer: NodeJS.Timeout | null = null;
let _probeRunning = false;

let _claudeCliAuthBlocked = false;
let _claudeCliAuthReason: string | null = null;

const CLAUDE_AUTH_RE = /not logged in|please run [`'"]?claude|oauth|re-?auth|unauthori[sz]ed|authentication[_ ]error|\b401\b|login required/i;

export function emptyGroqHealth(): GroqHealthSnapshot {
  const key = getGroqApiKey();
  return {
    configured: Boolean(key) && key !== 'replace_me_with_groq_api_key',
    configured_model: getGroqModel(),
    available: null,
    available_models: [],
    checked_at: null,
    error: key ? null : 'GROQ_API_KEY is not set',
  };
}

export function getGroqHealth(): GroqHealthSnapshot {
  return { ..._groqHealth };
}

export function parseGroqModelIds(payload: unknown): string[] {
  if (!payload) return [];
  if (Array.isArray(payload)) {
    const ids: string[] = [];
    for (const row of payload) {
      if (typeof row === 'string') ids.push(row);
      else if (row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string') {
        ids.push((row as { id: string }).id);
      }
    }
    return ids;
  }
  if (typeof payload === 'object' && 'data' in payload) {
    return parseGroqModelIds((payload as { data: unknown }).data);
  }
  return [];
}

export function groqModelIsListed(configured: string, ids: string[]): boolean {
  const want = configured.trim().toLowerCase();
  if (!want) return false;
  return ids.some((id) => id.trim().toLowerCase() === want);
}

export async function probeGroqHealth(): Promise<GroqHealthSnapshot> {
  const snapshot = emptyGroqHealth();
  if (!snapshot.configured) {
    _groqHealth = snapshot;
    return snapshot;
  }

  const client = getOptionalGroqClient();
  if (!client) {
    snapshot.error = 'GROQ_API_KEY is not set';
    snapshot.available = false;
    snapshot.checked_at = Math.floor(Date.now() / 1000);
    _groqHealth = snapshot;
    return snapshot;
  }

  try {
    const listed = await client.models.list();
    const ids = parseGroqModelIds(listed);
    snapshot.available_models = ids;
    snapshot.available = groqModelIsListed(snapshot.configured_model, ids);
    snapshot.error = snapshot.available
      ? null
      : `configured model ${snapshot.configured_model} is not in the account model list`;
    snapshot.checked_at = Math.floor(Date.now() / 1000);
    logger.info('Groq model preflight', {
      model: snapshot.configured_model,
      available: snapshot.available,
      listed: ids.length,
    });
  } catch (err) {
    snapshot.available = false;
    snapshot.error = String(err).slice(0, 400);
    snapshot.checked_at = Math.floor(Date.now() / 1000);
    logger.warn('Groq model preflight failed', { err: snapshot.error });
  }

  _groqHealth = snapshot;
  return snapshot;
}

export function startGroqHealthProbe(): void {
  if (_probeTimer) return;
  void runProbeSafe();
  _probeTimer = setInterval(() => { void runProbeSafe(); }, GROQ_PROBE_MS);
}

export function stopGroqHealthProbe(): void {
  if (_probeTimer) {
    clearInterval(_probeTimer);
    _probeTimer = null;
  }
}

async function runProbeSafe(): Promise<void> {
  if (_probeRunning) return;
  _probeRunning = true;
  try {
    await probeGroqHealth();
  } finally {
    _probeRunning = false;
  }
}

export function isClaudeAuthFailureMessage(text: string): boolean {
  return CLAUDE_AUTH_RE.test(text);
}

export function isClaudeAuthFailure(err: unknown): boolean {
  return isClaudeAuthFailureMessage(String(err));
}

/** Trip the process-lifetime CLI auth breaker. Returns true when newly tripped. */
export function noteClaudeAuthFailure(err: unknown): boolean {
  if (!isClaudeAuthFailure(err)) return false;
  const reason = String(err).slice(0, 300);
  const first = !_claudeCliAuthBlocked;
  _claudeCliAuthBlocked = true;
  _claudeCliAuthReason = reason;
  if (first) {
    logger.warn('Claude CLI auth circuit open — skipping CLI/agentic until process restart', { reason });
  }
  return first;
}

export function isClaudeCliAuthBlocked(): boolean {
  return _claudeCliAuthBlocked;
}

export function getClaudeAuthBlockReason(): string | null {
  return _claudeCliAuthReason;
}

export function resetClaudeAuthCircuit(): void {
  _claudeCliAuthBlocked = false;
  _claudeCliAuthReason = null;
}

export function resetGroqHealthForTests(snapshot?: GroqHealthSnapshot): void {
  _groqHealth = snapshot ?? emptyGroqHealth();
}

export function getProviderDiagnostics(): {
  groq: GroqHealthSnapshot;
  claude_cli_auth_blocked: boolean;
  claude_cli_auth_reason: string | null;
} {
  return {
    groq: getGroqHealth(),
    claude_cli_auth_blocked: _claudeCliAuthBlocked,
    claude_cli_auth_reason: _claudeCliAuthReason,
  };
}
