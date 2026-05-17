import {
  getQueryFn, getAgentModel, getMaxTurnsPerRun, assertAgentReady,
} from './client.js';
import { buildCanUseTool } from './policy.js';
import { getOrCreateChannel } from './sse.js';
import { setAgentRunStatus, updateAgentRun } from './store.js';
import { logEvent } from '../storage/queries.js';
import { logger } from '../utils/logger.js';
import type { AgentRunMode } from './types.js';

/**
 * Consumes the `query()` async generator from `@anthropic-ai/claude-agent-sdk`,
 * persists progress, streams to the SSE channel, and aggregates usage stats.
 *
 * SDK message shapes are not exhaustively typed here — the SDK is evolving;
 * we extract a small set of fields defensively and treat anything missing
 * as benign.
 */

const INVESTIGATOR_ALLOWED = ['Read', 'Grep', 'Glob', 'Bash'];
const IMPLEMENTER_ALLOWED = ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'];
const IMPLEMENTER_DISALLOWED = ['NotebookEdit'];
const INVESTIGATOR_DISALLOWED = ['Edit', 'Write', 'NotebookEdit'];

export interface RunAgentResult {
  ok: boolean;
  finalText: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  turnCount: number;
  error?: string;
}

export async function runAgent(opts: {
  runId: string;
  mode: AgentRunMode;
  cwd: string;
  prompt: string;
  systemPrompt: string;
}): Promise<RunAgentResult> {
  const { runId, mode, cwd, prompt, systemPrompt } = opts;
  assertAgentReady();

  const model = getAgentModel();
  const maxTurns = getMaxTurnsPerRun(mode);
  const allowedTools = mode === 'investigator' ? INVESTIGATOR_ALLOWED : IMPLEMENTER_ALLOWED;
  const disallowedTools = mode === 'investigator' ? INVESTIGATOR_DISALLOWED : IMPLEMENTER_DISALLOWED;
  const permissionMode = mode === 'investigator' ? 'plan' : 'acceptEdits';

  const channel = getOrCreateChannel(runId);
  const broadcast = (kind: Parameters<typeof channel.broadcast>[0]['kind'], text: string) => {
    channel.broadcast({ ts: Math.floor(Date.now() / 1000), kind, text });
  };

  broadcast('status', `Run starting — mode=${mode} model=${model} cwd=${cwd}`);
  setAgentRunStatus(runId, 'RUNNING');
  updateAgentRun(runId, { model });
  logEvent('AGENT_RUN_START', `mode=${mode} run=${runId} cwd=${cwd}`);

  const canUseTool = buildCanUseTool(mode, { cwd });

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let turnCount = 0;
  let finalText = '';

  let queryFn;
  try {
    queryFn = await getQueryFn();
  } catch (err) {
    const msg = String(err);
    broadcast('status', `SDK load failed: ${msg}`);
    setAgentRunStatus(runId, 'FAILED', { error: msg });
    logEvent('AGENT_RUN_ERROR', `sdk_load: ${msg}`);
    return { ok: false, finalText: '', inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, turnCount, error: msg };
  }

  try {
    const stream = queryFn({
      prompt,
      options: {
        cwd,
        model,
        maxTurns,
        permissionMode,
        allowedTools,
        disallowedTools,
        canUseTool,
        customSystemPrompt: systemPrompt,
        // Avoid emitting partial-message deltas (we don't render them);
        // keeps SDK output volume sane.
        includePartialMessages: false,
      },
    });

    for await (const msg of stream as AsyncIterable<Record<string, unknown>>) {
      const type = (msg as { type?: string }).type;

      // Best-effort extraction across SDK message variants
      if (type === 'assistant') {
        const content = (msg as { message?: { content?: Array<Record<string, unknown>> } }).message?.content ?? [];
        for (const block of content) {
          const btype = (block as { type?: string }).type;
          if (btype === 'text') {
            const text = String((block as { text?: string }).text ?? '');
            if (text.trim()) {
              finalText += (finalText ? '\n' : '') + text;
              broadcast('assistant_text', text.length > 800 ? text.slice(0, 800) + '…' : text);
            }
          } else if (btype === 'tool_use') {
            const name = String((block as { name?: string }).name ?? '?');
            const input = (block as { input?: unknown }).input;
            const summary = summarizeToolInput(name, input);
            broadcast('tool_use', `${name} ${summary}`);
          }
        }
      } else if (type === 'user') {
        // tool_result blocks come back inside user messages
        const content = (msg as { message?: { content?: Array<Record<string, unknown>> } }).message?.content ?? [];
        for (const block of content) {
          if ((block as { type?: string }).type === 'tool_result') {
            const isError = (block as { is_error?: boolean }).is_error === true;
            const text = String((block as { content?: unknown }).content ?? '').slice(0, 400);
            broadcast(isError ? 'tool_denied' : 'tool_result', text);
          }
        }
      } else if (type === 'result') {
        const usage = (msg as { usage?: Record<string, number> }).usage;
        if (usage) {
          inputTokens += usage.input_tokens ?? 0;
          outputTokens += usage.output_tokens ?? 0;
          cacheReadTokens += usage.cache_read_input_tokens ?? 0;
          cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
        }
        turnCount = (msg as { num_turns?: number }).num_turns ?? turnCount;
        const subtype = (msg as { subtype?: string }).subtype ?? 'end';
        broadcast('status', `result subtype=${subtype} turns=${turnCount}`);
      }
    }

    updateAgentRun(runId, {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens,
      cache_creation_tokens: cacheCreationTokens,
      turn_count: turnCount,
    });

    setAgentRunStatus(runId, 'SUCCESS', { summary: finalText.slice(0, 4000) });
    logEvent('AGENT_RUN_COMPLETE', `run=${runId} turns=${turnCount} tok_in=${inputTokens} tok_out=${outputTokens}`);
    channel.close();
    return { ok: true, finalText, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, turnCount };
  } catch (err) {
    const msg = String(err);
    logger.error('Agent run threw', { runId, err: msg });
    setAgentRunStatus(runId, 'FAILED', { error: msg, summary: finalText.slice(0, 4000) });
    logEvent('AGENT_RUN_ERROR', `run=${runId} err=${msg}`);
    channel.broadcast({ ts: Math.floor(Date.now() / 1000), kind: 'status', text: `error: ${msg.slice(0, 200)}` });
    channel.close();
    return { ok: false, finalText, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, turnCount, error: msg };
  }
}

function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  if (name === 'Bash')       return String(i.command ?? '').slice(0, 200);
  if (name === 'Read')       return String(i.file_path ?? '').slice(0, 200);
  if (name === 'Edit')       return String(i.file_path ?? '').slice(0, 200);
  if (name === 'Write')      return String(i.file_path ?? '').slice(0, 200);
  if (name === 'Grep')       return String(i.pattern ?? '').slice(0, 200);
  if (name === 'Glob')       return String(i.pattern ?? '').slice(0, 200);
  return JSON.stringify(i).slice(0, 200);
}
