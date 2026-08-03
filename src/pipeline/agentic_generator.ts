import { z } from 'zod';
import { getSetting, logEvent, type Stance } from '../storage/queries.js';
import { isClaudeCliFound } from '../agent/client.js';
import { claudeGeneratorModel } from './claude_generator.js';
import { charLength, cleanModelText } from './text_constraints.js';
import { logger } from '../utils/logger.js';
import { getAnthropicApiKey, getAgenticGeneratorModel, getAgenticGenMaxTurns } from '../config.js';

/**
 * Agentic content generation on the Claude Agent SDK.
 *
 * Instead of one prompt-in/text-out call, the model runs a small tool loop:
 * it can search the local news index, run a live X search, and read pages,
 * then must deliver the final text through a submit tool whose validator
 * rejects rule-breaking drafts — so revision happens inside the loop instead
 * of failing after the fact.
 *
 * Auth mirrors the maintainer agent: the SDK uses ANTHROPIC_API_KEY when set,
 * otherwise the local `claude` CLI login. Gated by the `agentic_generation`
 * dashboard setting (default off); single-shot Claude/Groq remains the
 * fallback whenever this path is disabled or fails.
 */

const MAX_REPLY_CHARS = 280;
const DEVANAGARI_RE = /[ऀ-ॿ]/;
const MAX_RESEARCH_TOOL_CALLS = 3;

import { findBannedPhrase } from './human_likeness.js';

export type ValidationResult = { ok: true; text: string } | { ok: false; reason: string };

export interface AgenticGenerationTask {
  kind: 'reply' | 'post';
  /** Post id for event-log correlation; omitted for original posts. */
  postId?: string;
  systemPrompt: string;
  userPrompt: string;
  validate: (raw: string) => ValidationResult;
}

export function isAgenticGenerationEnabled(): boolean {
  if (getSetting('agentic_generation', 'false') !== 'true') return false;
  // The SDK authenticates with ANTHROPIC_API_KEY when set, otherwise with the
  // local Claude Code CLI login — one of the two must be present.
  if (getAnthropicApiKey()) return true;
  return isClaudeCliFound();
}

export function getAgenticModel(): string {
  return getAgenticGeneratorModel();
}

/**
 * Attempts per agentic generation. Everything runs on Opus 5, so there is no
 * second model to step down to — the retry is what absorbs a transient failure
 * (rate limit, API blip).
 */
export const AGENTIC_MAX_ATTEMPTS = 2;

export function getAgenticMaxTurns(): number {
  return getAgenticGenMaxTurns();
}

function normalizeForComparison(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Openers that signal agreement. Only checked when the reply is supposed to be
 * contrarian — catching it here lets the agent self-correct inside its own
 * loop instead of shipping an agreeable reply that was meant to push back.
 */
const AGREEMENT_OPENERS = /^(exactly|agreed|so true|this,?$|this!|100%|facts|couldn'?t agree|absolutely|yes,? this)/i;

export interface ReplyValidatorOptions {
  stance?: Stance | null;
}

export function makeReplyValidator(
  avoidTexts: string[] = [],
  opts: ReplyValidatorOptions = {},
): (raw: string) => ValidationResult {
  const avoid = new Set(avoidTexts.map(normalizeForComparison));
  return (raw: string): ValidationResult => {
    const text = cleanModelText(raw);
    const n = charLength(text);
    if (n < 10) return { ok: false, reason: `too short (${n} chars) — write a fuller reply` };
    if (n > MAX_REPLY_CHARS) {
      return { ok: false, reason: `too long (${n} chars) — the hard limit is ${MAX_REPLY_CHARS} characters including newlines` };
    }
    if (DEVANAGARI_RE.test(text)) {
      return { ok: false, reason: 'contains Devanagari script — write the reply in English only' };
    }
    const hashtags = text.match(/#[\p{L}\p{N}_]+/gu) ?? [];
    if (hashtags.length > 1) {
      return { ok: false, reason: `uses ${hashtags.length} hashtags — the limit is one (zero preferred)` };
    }
    const banned = findBannedPhrase(text);
    if (banned) return { ok: false, reason: `contains the banned AI-slop phrase "${banned}" — rewrite without it` };
    if (avoid.size > 0 && avoid.has(normalizeForComparison(text))) {
      return { ok: false, reason: 'nearly identical to a recent reply — take a genuinely different angle' };
    }
    if (opts.stance === 'CONTRARIAN' && AGREEMENT_OPENERS.test(text.trim())) {
      return { ok: false, reason: 'opens by agreeing, but this reply is meant to push back — lead with the counterpoint' };
    }
    return { ok: true, text };
  };
}

// ── SDK loading ───────────────────────────────────────────────────────────────

interface SdkToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

type SdkToolDef = unknown;

interface AgentSdk {
  query: (input: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<Record<string, unknown>>;
  tool: (
    name: string,
    description: string,
    schema: Record<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (args: any, extra: unknown) => Promise<SdkToolResult>,
  ) => SdkToolDef;
  createSdkMcpServer: (opts: { name: string; version?: string; tools: SdkToolDef[] }) => unknown;
}

let _sdk: AgentSdk | null = null;

async function getSdk(): Promise<AgentSdk> {
  if (_sdk) return _sdk;
  const mod = await import('@anthropic-ai/claude-agent-sdk') as Partial<AgentSdk>;
  if (typeof mod.query !== 'function' || typeof mod.tool !== 'function' || typeof mod.createSdkMcpServer !== 'function') {
    throw new Error('@anthropic-ai/claude-agent-sdk does not export query/tool/createSdkMcpServer — run `npm install` first.');
  }
  _sdk = { query: mod.query, tool: mod.tool, createSdkMcpServer: mod.createSdkMcpServer };
  return _sdk;
}

function toolText(text: string, isError = false): SdkToolResult {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

// ── Research tools ────────────────────────────────────────────────────────────

/**
 * Builds the research toolset. Sources are imported lazily so a missing or
 * misconfigured subsystem degrades to "tool absent" instead of failing the run.
 */
async function buildResearchTools(sdk: AgentSdk): Promise<{ defs: SdkToolDef[]; names: string[] }> {
  const defs: SdkToolDef[] = [];
  const names: string[] = [];

  // search_news — needs the vector context store (CONTEXT_ENABLED + VOYAGE_API_KEY)
  try {
    const enrich = await import('../context/enrich.js');
    const retriever = typeof enrich.getRetriever === 'function' ? enrich.getRetriever() : null;
    if (retriever) {
      names.push('search_news');
      defs.push(sdk.tool(
        'search_news',
        'Semantic search over a local index of recent news and discussion (RSS headlines, Reddit, X). Use a short topical query, e.g. "Pune metro line 3 delay". Call this when a recent fact, number, or event would sharpen the text.',
        {
          query: z.string().describe('Short topical search query'),
          max_results: z.number().int().min(1).max(8).optional().describe('Max items to return (default 5)'),
        },
        async (args: { query: string; max_results?: number }) => {
          try {
            const items = await retriever.retrieve({ text: args.query, k: args.max_results ?? 5 });
            if (items.length === 0) return toolText('No matching items in the index. Try a broader query or a different tool.');
            const now = Date.now() / 1000;
            const lines = items.map((it, i) => {
              const ageH = it.publishedAt ? Math.max(0, Math.round((now - it.publishedAt) / 3600)) : null;
              const age = ageH == null ? 'recent' : ageH < 1 ? '<1h ago' : `${ageH}h ago`;
              const head = it.title ? `${it.title} — ` : '';
              return `${i + 1}. [${it.source.replace(/^rss:/, '')}, ${age}] ${head}${it.body.slice(0, 300)}`;
            });
            return toolText(lines.join('\n'));
          } catch (err) {
            return toolText(`search_news failed: ${String(err).slice(0, 200)}`, true);
          }
        },
      ));
    }
  } catch (err) {
    logger.warn('search_news tool unavailable', { err: String(err) });
  }

  // No search_twitter tool: it was backed by a local twitter-cli that has been
  // broken since it was added (HTTP 404 on every search), so the agent only
  // ever burned a research call on it. Live X search runs through the
  // Playwright session instead — see searchTweets in src/browser/ingestion.ts.

  // read_url — fetch one page as markdown via Jina Reader
  try {
    const { jinaSource } = await import('../context/sources/jina.js');
    names.push('read_url');
    defs.push(sdk.tool(
      'read_url',
      'Fetch one public web page as markdown (via Jina Reader). Call this when a search result points at a page whose details you need.',
      { url: z.string().describe('Absolute http(s) URL') },
      async (args: { url: string }) => {
        if (!/^https?:\/\//i.test(args.url)) return toolText('Invalid URL — must start with http:// or https://', true);
        const source = jinaSource({ name: 'agentic-read', urls: [args.url], intervalMinutes: 0, credibility: 0.5 });
        const result = await source.fetch();
        const item = result.items[0];
        if (!item) return toolText('Could not fetch that URL.', true);
        return toolText(`${item.title ?? ''}\n\n${item.body.slice(0, 1800)}`.trim());
      },
    ));
  } catch (err) {
    logger.warn('read_url tool unavailable', { err: String(err) });
  }

  return { defs, names };
}

// ── Agent loop ────────────────────────────────────────────────────────────────

function agentInstructions(kind: 'reply' | 'post', submitTool: string, researchTools: string[], maxTurns: number): string {
  const what = kind === 'reply' ? 'reply' : 'tweet';
  const research = researchTools.length > 0
    ? [
      `1. RESEARCH (optional — at most ${MAX_RESEARCH_TOOL_CALLS} tool calls): if one concrete fact, number, or fresh event would make the ${what} sharper, look it up first:`,
      researchTools.includes('search_news') ? '   - search_news: recent news/discussion from the local index.' : '',
      researchTools.includes('read_url') ? '   - read_url: fetch one specific page when you need its details.' : '',
      `   Skip research entirely when the ${what} is pure wit or banter and needs no facts.`,
    ].filter(Boolean).join('\n')
    : '1. RESEARCH: no research tools are available in this run — work from the material provided above.';

  return [
    '====================================================================',
    'AGENT WORKFLOW — you are running as an agent with tools. Work in this order:',
    '',
    research,
    `2. DRAFT AND SELF-CRITIQUE (silently): compose 2-3 candidate ${what}s, check each against EVERY rule above — format, tone, anti-slop, hard limits, language — and pick the strongest.`,
    `3. SUBMIT: call ${submitTool} with exactly the final ${what} text. If it returns REJECTED, fix the stated problem and submit again.`,
    '',
    'NON-NEGOTIABLE:',
    `- The ONLY way to deliver the ${what} is the ${submitTool} tool. Plain text outside that tool call is discarded.`,
    '- Never invent facts, numbers, or events. Anything specific must come from the material above or a tool result.',
    '- Research must not flatten the voice: you are still the persona described above, not a news anchor.',
    `- Budget: at most ${maxTurns} turns total; keep research tight.`,
  ].join('\n');
}

export async function runGenerationAgent(task: AgenticGenerationTask, modelOverride?: string): Promise<string> {
  const sdk = await getSdk();
  const model = modelOverride ?? getAgenticModel();
  const maxTurns = getAgenticMaxTurns();
  const submitToolName = task.kind === 'reply' ? 'submit_reply' : 'submit_post';

  let submitted: string | null = null;
  let rejections = 0;

  const { defs, names } = await buildResearchTools(sdk);
  const submitDef = sdk.tool(
    submitToolName,
    task.kind === 'reply'
      ? 'Submit the final reply text. This is the only way to deliver your reply. Returns ACCEPTED, or REJECTED with the reason to fix.'
      : 'Submit the final tweet (or a 2-3 tweet thread as continuous prose). This is the only way to deliver your post. Returns ACCEPTED, or REJECTED with the reason to fix.',
    { text: z.string().describe('The final text, exactly as it should appear on X') },
    async (args: { text: string }) => {
      // Lock after the first accepted submission so a stray second call can't
      // overwrite a good draft with a worse one.
      if (submitted !== null) {
        return toolText('ALREADY ACCEPTED. Your text is recorded — stop and end your turn.');
      }
      const verdict = task.validate(args.text);
      if (!verdict.ok) {
        rejections += 1;
        return toolText(`REJECTED: ${verdict.reason}`, true);
      }
      submitted = verdict.text;
      return toolText('ACCEPTED. The text has been recorded — your work is done; do not submit again.');
    },
  );

  const server = sdk.createSdkMcpServer({ name: 'xposter', version: '1.0.0', tools: [...defs, submitDef] });
  const allToolNames = [...names, submitToolName].map((n) => `mcp__xposter__${n}`);

  const canUseTool = async (toolName: string): Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string }> => {
    if (toolName.startsWith('mcp__xposter__')) return { behavior: 'allow' };
    return { behavior: 'deny', message: `${toolName} is not available during content generation.` };
  };

  const label = task.postId ? `postId=${task.postId}` : `kind=${task.kind}`;
  logEvent('AGENTIC_GENERATION_START', `model=${model} maxTurns=${maxTurns} tools=${names.join(',') || 'none'} ${label}`, task.postId);
  logger.info('Agentic generation starting', { kind: task.kind, model, maxTurns, tools: names, postId: task.postId });

  let turnCount = 0;
  let costUsd = 0;

  // ANTHROPIC_API_KEY would take precedence over the claude.ai login inside the
  // SDK's CLI subprocess and bill the API account instead of the subscription.
  // Only strip it when a local CLI (and thus a possible login) exists.
  const env: Record<string, string | undefined> = { ...process.env };
  if (isClaudeCliFound()) delete env.ANTHROPIC_API_KEY;

  const stream = sdk.query({
    prompt: task.userPrompt,
    options: {
      cwd: process.cwd(),
      env,
      model,
      maxTurns,
      permissionMode: 'default',
      allowedTools: allToolNames,
      disallowedTools: ['Bash', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'],
      canUseTool,
      systemPrompt: `${task.systemPrompt}\n\n${agentInstructions(task.kind, submitToolName, names, maxTurns)}`,
      mcpServers: { xposter: server },
      includePartialMessages: false,
    },
  });

  try {
    for await (const msg of stream) {
      if ((msg as { type?: string }).type === 'result') {
        turnCount = (msg as { num_turns?: number }).num_turns ?? turnCount;
        costUsd = (msg as { total_cost_usd?: number }).total_cost_usd ?? costUsd;
      }
    }
  } catch (err) {
    logEvent('AGENTIC_GENERATION_FAILED', `error: ${String(err).slice(0, 300)} ${label}`, task.postId);
    throw err;
  }

  if (!submitted) {
    logEvent('AGENTIC_GENERATION_FAILED', `no accepted submission (turns=${turnCount} rejections=${rejections}) ${label}`, task.postId);
    throw new Error(`Agentic generation produced no accepted ${task.kind} (turns=${turnCount}, rejections=${rejections})`);
  }

  logEvent(
    'AGENTIC_GENERATION_SUCCESS',
    `turns=${turnCount} rejections=${rejections} cost=$${costUsd.toFixed(4)} chars=${charLength(submitted)} ${label}`,
    task.postId,
  );
  logger.info('Agentic generation succeeded', {
    kind: task.kind, turns: turnCount, rejections, costUsd, chars: charLength(submitted), postId: task.postId,
  });
  return submitted;
}

export async function generateReplyAgentic(opts: {
  postId: string;
  systemPrompt: string;
  userPrompt: string;
  avoidTexts?: string[];
  stance?: Stance | null;
}): Promise<string> {
  const task = {
    kind: 'reply' as const,
    postId: opts.postId,
    systemPrompt: opts.systemPrompt,
    userPrompt: opts.userPrompt,
    validate: makeReplyValidator(opts.avoidTexts ?? [], { stance: opts.stance ?? null }),
  };
  // Retry on the same model; AGENTIC_GENERATOR_MODEL still overrides it.
  const model = getAgenticModel();
  let lastErr: unknown;
  for (let attempt = 1; attempt <= AGENTIC_MAX_ATTEMPTS; attempt++) {
    try {
      return await runGenerationAgent(task, model);
    } catch (err) {
      logger.warn(`Agentic generation attempt ${attempt}/${AGENTIC_MAX_ATTEMPTS} failed (model=${model})`, { err: String(err).slice(0, 200) });
      lastErr = err;
    }
  }
  throw lastErr;
}
