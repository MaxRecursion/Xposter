/**
 * Ordered image-provider chain, built the same way `buildContextSources()`
 * assembles context sources: a static list filtered by availability, with an
 * env var able to promote one provider to the front.
 *
 * The chain is honest — every entry is a genuinely different backend, so a
 * fallthrough only happens on a real failure. (The previous flux -> turbo
 * "fallback" was two names for the same SANA endpoint.)
 */
import { logger } from '../../utils/logger.js';
import { huggingFaceProvider } from './huggingface.js';
import { openAiProvider } from './openai.js';
import { pollinationsProvider } from './pollinations.js';
import type { ImageProvider } from './types.js';

export type { GenerateRequest, GenerateResult, ImageProvider } from './types.js';

export function buildImageProviders(): ImageProvider[] {
  const all = [pollinationsProvider(), huggingFaceProvider(), openAiProvider()];
  const available = all.filter((p) => p.isAvailable());

  const preferred = process.env.IMAGE_PROVIDER?.trim();
  if (preferred) {
    const idx = available.findIndex((p) => p.name === preferred);
    if (idx > 0) available.unshift(...available.splice(idx, 1));
    else if (idx === -1) {
      logger.warn('IMAGE_PROVIDER names an unavailable provider — using default order', {
        requested: preferred,
        available: available.map((p) => p.name),
      });
    }
  }

  return available;
}
