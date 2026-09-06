/**
 * LLM-as-judge eval loop.
 *
 * Runs independently of the reply pipeline's own generation-time gates
 * (min_score, human-likeness, conversation gravity) — this scores what
 * actually shipped, after the fact, using a cheap model that had no part in
 * writing the reply. It's a health check on the pipeline's own quality bar,
 * not a posting gate.
 */
import { getOptionalGroqClient, groqReasoningParams } from '../pipeline/groq_client.js';
import { getGroqJudgeModel } from '../config.js';
import { logger } from '../utils/logger.js';
import { logEvent } from '../storage/queries.js';
import { getPost } from '../storage/posts.js';
import type { Post } from '../storage/posts.js';
import {
  getUnjudgedInteractions, updateJudgeScore, type Interaction,
} from '../storage/interactions.js';

export const JUDGE_PASS_THRESHOLD = 65;
const MAX_PER_RUN = 10;

export interface JudgeResult {
  score: number;
  reasoning: string;
  passed: boolean;
}

const JUDGE_SYSTEM_PROMPT = `You are a strict quality judge for X (Twitter) replies posted by an automated account. You did not write this reply — you are auditing it.

Score the REPLY against the ORIGINAL TWEET it responded to, out of 100 total, across four dimensions:
- Relevance (0-40): Does the reply directly engage with something specific the original tweet actually said? A reply that could sit under any tweet on the same general topic scores low here, even if it's well-written.
- Insight (0-30): Does the reply add a genuine observation, fact, or angle — not just agreement, restatement, or a generic reaction?
- Tone (0-20): Does it read like a real, opinionated person — not corporate, not hedging, not AI-slop ("great point!", "I totally understand", generic empathy)?
- Brevity (0-10): Is it tight and purposeful rather than padded or rambling?

Return ONLY a single line of JSON, no markdown, no code fences:
{"score":<0-100 integer>,"reasoning":"<one or two sentence justification citing the dimensions above>"}`;

/**
 * Scores one posted reply. Never throws — a judge failure (no API key,
 * malformed model output, network error) degrades to a 0/failed result so
 * the caller can still record that this interaction was looked at.
 */
export async function evaluateReply(
  interaction: Interaction,
  sourcePost: Post | null,
): Promise<JudgeResult> {
  const groq = getOptionalGroqClient();
  if (!groq) {
    return { score: 0, reasoning: 'GROQ_API_KEY not configured — judge skipped', passed: false };
  }

  const model = getGroqJudgeModel();
  const userPrompt = [
    `ORIGINAL TWEET (by @${sourcePost?.author_handle ?? 'unknown'}):`,
    sourcePost?.text ?? '(original tweet unavailable)',
    '',
    'OUR REPLY:',
    interaction.our_reply_text,
  ].join('\n');

  try {
    const completion = await groq.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: JUDGE_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_completion_tokens: 500,
      temperature: 0.1,
      top_p: 0.9,
      ...groqReasoningParams(model),
    } as any);

    const raw = completion.choices[0]?.message?.content?.trim() ?? '';
    const parsed = parseJudgeJson(raw);
    if (!parsed) throw new Error(`unparseable judge output: ${raw.slice(0, 120)}`);

    // The pass/fail line is computed here, not trusted from the model's own
    // output — the prompt only asks it for score + reasoning.
    return {
      score: parsed.score,
      reasoning: parsed.reasoning,
      passed: parsed.score >= JUDGE_PASS_THRESHOLD,
    };
  } catch (err) {
    logger.warn('LLM judge evaluation failed', { interactionId: interaction.id, err: String(err) });
    return { score: 0, reasoning: `judge error: ${String(err).slice(0, 200)}`, passed: false };
  }
}

function parseJudgeJson(raw: string): { score: number; reasoning: string } | null {
  // Sometimes the model wraps JSON in fences or extra text — extract the first {...} chunk.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    const score = Math.round(Number(obj.score));
    if (!Number.isFinite(score)) return null;
    return {
      score: Math.min(Math.max(score, 0), 100),
      reasoning: String(obj.reasoning ?? '').slice(0, 500),
    };
  } catch {
    return null;
  }
}

let _running = false;

/**
 * Evaluates up to MAX_PER_RUN unjudged, metric-synced interactions and
 * persists each score. Single-flight guarded like the other periodic sync
 * jobs — a slow Groq response shouldn't let two runs overlap.
 */
export async function runJudgeEval(): Promise<{ evaluated: number; passed: number }> {
  if (_running) return { evaluated: 0, passed: 0 };

  const due = getUnjudgedInteractions(MAX_PER_RUN);
  if (due.length === 0) return { evaluated: 0, passed: 0 };

  _running = true;
  logger.info('Judge eval starting', { due: due.length });
  logEvent('JUDGE_EVAL_START', `${due.length} interactions`);

  let evaluated = 0;
  let passed = 0;
  try {
    for (const interaction of due) {
      const sourcePost = getPost(interaction.post_id);
      const result = await evaluateReply(interaction, sourcePost);
      updateJudgeScore(interaction.id, result);
      evaluated++;
      if (result.passed) passed++;
      logEvent(
        'JUDGE_EVAL_SCORED',
        `score=${result.score} passed=${result.passed} reason="${result.reasoning.slice(0, 140)}"`,
        interaction.post_id,
      );
    }
    logEvent('JUDGE_EVAL_COMPLETE', `evaluated=${evaluated} passed=${passed}`);
    logger.info('Judge eval complete', { evaluated, passed });
    return { evaluated, passed };
  } finally {
    _running = false;
  }
}
