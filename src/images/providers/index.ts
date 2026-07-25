/**
 * Ordered image-provider chain, built the same way `buildContextSources()`
 * assembles context sources: a static list filtered by availability, with an
 * env var able to promote one provider to the front.
 *
 * The chain is honest — every entry is a genuinely different backend, so a
 * fallthrough only happens on a real failure. (The previous flux -> turbo
 * "fallback" was two names for the same SANA endpoint.)
 *
 * Paid providers are additionally gated on the monthly budget, so an exhausted
 * budget degrades to the free provider instead of halting image posts.
 */
import { canAffordImage } from '../../storage/image_budget.js';
import { logger } from '../../utils/logger.js';
import { geminiProvider } from './gemini.js';
import { huggingFaceProvider } from './huggingface.js';
import { openAiProvider } from './openai.js';
import { pollinationsProvider } from './pollinations.js';
import type { ImageProvider } from './types.js';

export type { GenerateRequest, GenerateResult, ImageProvider } from './types.js';

/**
 * Preferred order: paid-and-good first, free last.
 *
 * Pollinations sits at the end deliberately — it is the safety net, not the
 * default, once a key is configured.
 */
function allProviders(): ImageProvider[] {
  return [geminiProvider(), openAiProvider(), huggingFaceProvider(), pollinationsProvider()];
}

export function buildImageProviders(): ImageProvider[] {
  const available = allProviders().filter((p) => p.isAvailable());

  const affordable = available.filter((p) => {
    const cost = p.costPerImageUsd();
    if (canAffordImage(cost)) return true;
    logger.warn('Skipping image provider — monthly budget exhausted', {
      provider: p.name, costPerImage: cost,
    });
    return false;
  });

  const preferred = process.env.IMAGE_PROVIDER?.trim();
  if (preferred) {
    const idx = affordable.findIndex((p) => p.name === preferred);
    if (idx > 0) affordable.unshift(...affordable.splice(idx, 1));
    else if (idx === -1) {
      logger.warn('IMAGE_PROVIDER names an unavailable or unaffordable provider — using default order', {
        requested: preferred,
        available: affordable.map((p) => p.name),
      });
    }
  }

  return affordable;
}
