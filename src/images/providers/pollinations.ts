/**
 * Pollinations.ai — free, no API key, no registration.
 *
 * Model note: the anonymous tier serves ONLY `sana`. Asking for `flux` or
 * `turbo` returns a SANA image anyway (verified via EXIF `manufacturer=sana`;
 * flux and turbo responses were byte-identical), so this provider names the
 * model it actually gets rather than pretending to a chain that never existed.
 * The identity-preserving models (`kontext`, `nanobanana`) are gated behind
 * enter.pollinations.ai and return HTTP 500 here.
 */
import axios from 'axios';
import { logger } from '../../utils/logger.js';
import { readImageSize } from '../dimensions.js';
import type { GenerateRequest, GenerateResult, ImageProvider } from './types.js';

const MODEL = 'sana';
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;
const TIMEOUT_MS = 90_000;

export function pollinationsProvider(): ImageProvider {
  return {
    name: 'pollinations',
    // Free and keyless — always available, and always affordable.
    isAvailable: () => true,
    costPerImageUsd: () => 0,
    supportsReferences: false,

    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(req.prompt)}`
        + `?width=${req.width}&height=${req.height}&model=${MODEL}&seed=${req.seed}`
        // `enhance` runs an LLM prompt-rewriter that would undo the carefully
        // phrased framing and exclusion clauses we depend on.
        + '&nologo=true&nofeed=true&enhance=false';

      logger.info('Calling Pollinations.ai', { model: MODEL, seed: req.seed, w: req.width, h: req.height });

      let lastErr: unknown;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: TIMEOUT_MS,
            headers: { 'User-Agent': 'Xposter/1.0' },
          });

          const buffer = Buffer.from(response.data);
          assertRequestedSize(buffer, req);
          return { buffer, model: `pollinations:${MODEL}` };
        } catch (err) {
          lastErr = err;
          logger.warn(`Pollinations attempt ${attempt}/${MAX_ATTEMPTS} failed`, { err: String(err).slice(0, 200) });
          // Retry with the SAME seed: a network failure is not a reason to
          // reroll the composition. Rerolling is the QA gate's job.
          if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
      }
      throw lastErr;
    },
  };
}

/**
 * Pollinations resizes anything above roughly a 590k-pixel budget while still
 * returning 200 OK. Our geometry sits under that, so a mismatch here means the
 * budget moved and the prompt geometry needs revisiting.
 */
function assertRequestedSize(buffer: Buffer, req: GenerateRequest): void {
  const size = readImageSize(buffer);
  if (!size) {
    logger.warn('Could not decode image dimensions from Pollinations response', { bytes: buffer.length });
    return;
  }
  if (size.width !== req.width || size.height !== req.height) {
    logger.warn('Pollinations returned a different size than requested — pixel budget may have changed', {
      requested: `${req.width}x${req.height}`,
      received: `${size.width}x${size.height}`,
    });
  }
}
