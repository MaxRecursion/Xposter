/**
 * Vision quality gate for generated images.
 *
 * Runs the local `claude -p` CLI with the Read tool enabled so it can open the
 * file and judge it. This bills the Pro/Max subscription rather than API
 * credits (same trick as claude_generator.ts), which makes the gate free — and
 * free matters, because it runs on every generation attempt.
 *
 * Groq is not an option here: this account's Groq model list has no vision
 * models at all.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getClaudePath, isClaudeCliFound } from '../agent/client.js';
import { getBooleanSetting } from '../storage/settings.js';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

// Longer than the 45s used for text generation: the model has to Read and
// decode a ~600KB image before it can answer.
const TIMEOUT_MS = 120_000;
const MODEL_CHAIN = ['fable', 'opus'];

export interface ImageVerdict {
  faceVisible: boolean;
  malformedAnatomy: boolean;
  looksAiGenerated: boolean;
  textArtifacts: boolean;
  notes: string;
  /** 0-100. Used to pick the least-bad candidate when every attempt is rejected. */
  score: number;
}

function buildPrompt(absPath: string): string {
  return [
    `Look at the image at ${absPath} using the Read tool, then judge it.`,
    '',
    'This is meant to pass as a real photo taken by a real person on their phone or film camera.',
    'It is deliberately faceless — the subject\'s face must never be identifiable.',
    '',
    'Judge these four things:',
    '- faceVisible: true if ANY recognisable facial features are visible — eyes, nose, mouth or jawline —',
    '  INCLUDING a profile view or a partially turned face. Only false if the face is genuinely absent:',
    '  shot from behind, a full silhouette with no features, cropped out of frame, or no person at all.',
    '- malformedAnatomy: true if hands, fingers, limbs or body proportions are distorted, merged, or',
    '  have the wrong count. Look closely at any visible hand.',
    '- textArtifacts: true if there is any garbled, nonsensical or melted lettering — signage, labels,',
    '  screens, book spines, packaging.',
    '- looksAiGenerated: true if it has the overall plastic, over-smoothed, uncanny quality of AI output.',
    '',
    'Reply with ONLY a JSON object, no prose and no code fence:',
    '{"faceVisible":bool,"malformedAnatomy":bool,"textArtifacts":bool,"looksAiGenerated":bool,"notes":"<max 15 words>"}',
  ].join('\n');
}

/**
 * Judges a generated image.
 *
 * Returns null when the gate cannot run (CLI missing, disabled, or the model
 * failed) — callers treat null as "no opinion" and proceed. Failing open is
 * deliberate: failing closed would silently stop all image posts the day the
 * CLI moves or the subscription lapses.
 */
export async function judgeImage(absPath: string): Promise<ImageVerdict | null> {
  if (!getBooleanSetting('image_qa_enabled', true)) return null;

  if (!isClaudeCliFound()) {
    logger.warn('Image QA skipped — Claude CLI not found');
    return null;
  }
  const bin = getClaudePath() ?? 'claude';

  // Force the subscription path rather than pay-per-token API credits.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  const prompt = buildPrompt(absPath);
  const preferred = process.env.IMAGE_QA_MODEL?.trim();
  const chain = preferred ? [preferred, ...MODEL_CHAIN.filter((m) => m !== preferred)] : MODEL_CHAIN;

  for (const model of chain) {
    try {
      const pending = execFileAsync(
        bin,
        ['-p', prompt, '--model', model, '--allowedTools', 'Read'],
        { timeout: TIMEOUT_MS, maxBuffer: 512 * 1024, env },
      );
      // The CLI blocks ~3s waiting on piped stdin unless it is closed up front.
      pending.child.stdin?.end();
      const { stdout } = await pending;

      const verdict = parseVerdict(stdout);
      if (verdict) {
        logger.info('Image QA verdict', { model, ...verdict });
        return verdict;
      }
      logger.warn('Image QA returned unparseable output', { model, raw: stdout.trim().slice(0, 200) });
    } catch (err) {
      const e = err as { code?: number | string; stderr?: string };
      logger.warn(`Image QA model=${model} failed, trying next`, {
        code: e.code,
        stderr: (e.stderr ?? '').trim().slice(-200),
      });
    }
  }

  logger.warn('Image QA chain exhausted — proceeding without a verdict');
  return null;
}

/** Extracts the JSON object from CLI output that may be fenced or prose-wrapped. */
export function parseVerdict(raw: string): ImageVerdict | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const faceVisible = parsed.faceVisible === true;
    const malformedAnatomy = parsed.malformedAnatomy === true;
    const textArtifacts = parsed.textArtifacts === true;
    const looksAiGenerated = parsed.looksAiGenerated === true;

    return {
      faceVisible,
      malformedAnatomy,
      textArtifacts,
      looksAiGenerated,
      notes: typeof parsed.notes === 'string' ? parsed.notes.slice(0, 200) : '',
      score: scoreVerdict({ faceVisible, malformedAnatomy, textArtifacts, looksAiGenerated }),
    };
  } catch {
    return null;
  }
}

function scoreVerdict(v: {
  faceVisible: boolean;
  malformedAnatomy: boolean;
  textArtifacts: boolean;
  looksAiGenerated: boolean;
}): number {
  return 100
    - (v.faceVisible ? 40 : 0)
    - (v.malformedAnatomy ? 30 : 0)
    - (v.textArtifacts ? 20 : 0)
    - (v.looksAiGenerated ? 15 : 0);
}

/**
 * Hard reject criteria.
 *
 * `looksAiGenerated` is deliberately NOT a hard reject — a small model trips it
 * often enough that rejecting on it would burn the whole attempt budget every
 * evening. It stays a soft signal via `score`, used to pick the least-bad
 * candidate.
 */
export function isRejected(verdict: ImageVerdict): boolean {
  return verdict.faceVisible || verdict.malformedAnatomy || verdict.textArtifacts;
}

/** Human-readable reason a verdict was rejected, for logs and last_error. */
export function rejectionReason(verdict: ImageVerdict): string {
  const reasons: string[] = [];
  if (verdict.faceVisible) reasons.push('face visible');
  if (verdict.malformedAnatomy) reasons.push('malformed anatomy');
  if (verdict.textArtifacts) reasons.push('text artifacts');
  return reasons.join(', ') || 'none';
}
