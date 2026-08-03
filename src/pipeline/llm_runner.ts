import { logEvent } from '../storage/queries.js';
import { logger } from '../utils/logger.js';
import { getGroqModel } from '../config.js';
import { getGroqClient } from './groq_client.js';
import { isClaudeAvailable, claudeGeneratorModel, generateWithClaude } from './claude_generator.js';
import {
  AGENTIC_MAX_ATTEMPTS,
  getAgenticModel,
  isAgenticGenerationEnabled,
  runGenerationAgent,
  type AgenticGenerationTask,
} from './agentic_generator.js';
import { EmptyReplyError } from './errors.js';

export interface GroqCallOptions {
  maxTokens?: number;
  maxCompletionTokens?: number;
  temperature?: number;
  topP?: number;
}

export interface GenerateTextOptions {
  taskName: string;
  systemPrompt: string;
  userPrompt: string;
  postId?: string;
  minChars?: number;
  groq: GroqCallOptions;
  /** When agentic generation is enabled, run this task before Claude/Groq. */
  agenticTask?: AgenticGenerationTask;
  /** Custom agentic runner (e.g. reply-specific validator wiring). */
  agenticRunner?: () => Promise<string>;
  logContext?: Record<string, unknown>;
}

/**
 * Unified provider ladder: agentic (opt-in) → Claude → Groq.
 * Callers own prompt construction and post-processing (clean, length, language).
 */
export async function generateText(opts: GenerateTextOptions): Promise<string> {
  const minChars = opts.minChars ?? 10;
  const logCtx = { task: opts.taskName, ...opts.logContext, ...(opts.postId ? { postId: opts.postId } : {}) };
  let text = '';

  if (isAgenticGenerationEnabled()) {
    if (opts.agenticRunner) {
      try {
        text = (await opts.agenticRunner()).trim();
      } catch (err) {
        logger.warn('Agentic generation failed; falling back to single-shot', { ...logCtx, err: String(err) });
      }
    } else if (opts.agenticTask) {
      const agModel = getAgenticModel();
      for (let attempt = 1; attempt <= AGENTIC_MAX_ATTEMPTS; attempt++) {
        try {
          text = (await runGenerationAgent(opts.agenticTask, agModel)).trim();
          break;
        } catch (err) {
          logger.warn(`Agentic attempt ${attempt}/${AGENTIC_MAX_ATTEMPTS} failed`, {
            ...logCtx, err: String(err).slice(0, 200),
          });
        }
      }
      if (!text) {
        logger.warn('Agentic generation exhausted; falling back to single-shot', logCtx);
      }
    }
  }

  if (!text && isClaudeAvailable()) {
    const claudeModel = claudeGeneratorModel();
    const suffix = opts.postId ? ` postId=${opts.postId}` : '';
    logEvent('CLAUDE_GENERATION_START', `model=${claudeModel} fn=${opts.taskName}${suffix}`, opts.postId);
    logger.info('Trying Claude', { model: claudeModel, ...logCtx });
    try {
      const result = await generateWithClaude(opts.systemPrompt, opts.userPrompt);
      const candidate = result.text.trim();
      if (candidate.length >= minChars) {
        logEvent(
          'CLAUDE_GENERATION_SUCCESS',
          `model=${claudeModel} in=${result.inputTokens} out=${result.outputTokens} chars=${candidate.length} fn=${opts.taskName}`,
          opts.postId,
        );
        logger.info('Claude generation succeeded', {
          model: claudeModel,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          chars: candidate.length,
          ...logCtx,
        });
        text = candidate;
      } else {
        logEvent(
          'CLAUDE_GENERATION_FAILED',
          `response too short (${candidate.length} chars) — triggering Groq fallback fn=${opts.taskName}`,
          opts.postId,
        );
        logger.warn('Claude returned short/empty text, falling back to Groq', { ...logCtx, textLen: candidate.length });
      }
    } catch (err) {
      logEvent('CLAUDE_GENERATION_FAILED', `error: ${String(err)} — triggering Groq fallback fn=${opts.taskName}`, opts.postId);
      logger.warn('Claude threw; falling back to Groq', { ...logCtx, err: String(err) });
    }
  }

  if (!text) {
    const groqModel = getGroqModel();
    const client = getGroqClient();
    logEvent('GROQ_FALLBACK_START', `model=${groqModel} fn=${opts.taskName}`, opts.postId);
    logger.info('Calling Groq', { model: groqModel, ...logCtx });
    try {
      const completion = await client.chat.completions.create({
        model: groqModel,
        messages: [
          { role: 'system', content: opts.systemPrompt },
          { role: 'user', content: opts.userPrompt },
        ],
        temperature: opts.groq.temperature ?? 0.8,
        top_p: opts.groq.topP ?? 0.95,
        ...(opts.groq.maxCompletionTokens != null
          ? { max_completion_tokens: opts.groq.maxCompletionTokens }
          : { max_tokens: opts.groq.maxTokens ?? 400 }),
      });
      text = (completion.choices[0]?.message?.content ?? '').trim();
      logEvent('GROQ_FALLBACK_SUCCESS', `model=${groqModel} chars=${text.length} fn=${opts.taskName}`, opts.postId);
      logger.info('Groq generation succeeded', { chars: text.length, ...logCtx });
    } catch (err) {
      logEvent('GROQ_FALLBACK_FAILED', `error: ${String(err)} fn=${opts.taskName}`, opts.postId);
      throw err;
    }
  }

  if (!text || text.length < minChars) throw new EmptyReplyError();
  return text;
}
