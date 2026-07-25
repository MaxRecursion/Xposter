/**
 * Visual identity card for the image persona.
 *
 * The persona is deliberately faceless — no image ever shows recognisable
 * facial features. That means continuity has to come from everything else:
 * the same hair, the same wardrobe palette, the same signature objects, and
 * the same film grade and lens language in every frame. Done consistently,
 * the feed reads as one person's camera roll without a face ever appearing.
 *
 * Accessories are chosen to sit at the wrist or in the hand — earrings and
 * necklaces need a face or neck in frame, and fine jewellery detail is exactly
 * what a small model renders badly.
 */
import { getSetting } from '../storage/settings.js';
import { logger } from '../utils/logger.js';

export interface VisualIdentity {
  hair: string;
  wardrobe: string;
  accessory: string;
  film: string;
  lens: string;
}

export const DEFAULT_IDENTITY: VisualIdentity = {
  hair: 'long dark wavy hair past the shoulder blades, slightly frizzy in the humidity',
  wardrobe: 'muted earth palette of olive, rust, oatmeal and faded indigo, oversized cotton and handloom textures',
  accessory: 'a thin oxidised silver band on the wrist and a worn rust canvas tote',
  film: 'Kodak Portra 400 colour grade, warm shadows, slightly lifted blacks, fine grain',
  lens: '35mm lens at f/2, shallow depth of field, natural available light, handheld',
};

/**
 * Resolution order: DB setting (JSON) > IMAGE_CHARACTER_PROMPT env > built-in.
 *
 * `IMAGE_CHARACTER_PROMPT` replaces the whole card with one free-text string;
 * it previously existed but was only read by the static template, so the
 * Claude-written prompt ignored it entirely.
 */
export function resolveIdentity(): VisualIdentity {
  const raw = getSetting('image_identity_json', '');
  if (raw && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as Partial<VisualIdentity>;
      return { ...DEFAULT_IDENTITY, ...parsed };
    } catch (err) {
      logger.warn('image_identity_json is not valid JSON — using defaults', { err: String(err).slice(0, 120) });
    }
  }

  const envOverride = process.env.IMAGE_CHARACTER_PROMPT?.trim();
  if (envOverride) {
    return { ...DEFAULT_IDENTITY, hair: envOverride, wardrobe: '', accessory: '' };
  }

  return DEFAULT_IDENTITY;
}

/** Renders the card into the subject clause of an image prompt. */
export function renderIdentity(identity: VisualIdentity): string {
  return [
    'A young Indian woman in her mid-20s',
    identity.hair,
    identity.wardrobe,
    identity.accessory,
  ].filter((part) => part && part.trim()).join(', ');
}

/** Short hint passed to the caption writer so captions can't contradict the frame. */
export function identityCaptionHint(identity: VisualIdentity): string {
  return identity.accessory;
}
