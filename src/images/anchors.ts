/**
 * Style anchor images.
 *
 * The persona is faceless, so these are NOT identity references in the usual
 * sense — there is no face to preserve. They pin the things text struggles to
 * hold steady across generations: hair length and texture, the wardrobe
 * palette, the canvas tote, and the film colour grade. Passing two or three
 * good past frames makes the feed read as one person's camera roll far more
 * reliably than any description.
 *
 * Anchors live in data/images/anchors/ (gitignored, like the rest of data/).
 * Seed them with `npm run image:anchor`.
 */
import fs from 'fs';
import path from 'path';
import { getBooleanSetting } from '../storage/settings.js';
import { logger } from '../utils/logger.js';

export const ANCHORS_DIR = path.resolve(process.cwd(), 'data', 'images', 'anchors');

/** More than a few references dilutes the prompt and inflates the request. */
const MAX_ANCHORS = 3;
/** Guard against a stray huge file blowing up the base64 payload. */
const MAX_ANCHOR_BYTES = 4 * 1024 * 1024;

export function ensureAnchorsDir(): void {
  fs.mkdirSync(ANCHORS_DIR, { recursive: true });
}

export function listAnchorPaths(): string[] {
  try {
    return fs.readdirSync(ANCHORS_DIR)
      .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
      .sort()
      .map((f) => path.join(ANCHORS_DIR, f));
  } catch {
    return [];
  }
}

/**
 * Loads up to MAX_ANCHORS style references.
 *
 * Returns an empty array when references are disabled, none exist, or the
 * provider can't use them — generation then falls back to the text-only
 * identity card, which still works.
 */
export function loadAnchors(): Buffer[] {
  if (!getBooleanSetting('image_use_references', true)) return [];

  const paths = listAnchorPaths().slice(0, MAX_ANCHORS);
  const buffers: Buffer[] = [];

  for (const p of paths) {
    try {
      const stat = fs.statSync(p);
      if (stat.size > MAX_ANCHOR_BYTES) {
        logger.warn('Skipping oversized anchor image', { path: p, bytes: stat.size });
        continue;
      }
      buffers.push(fs.readFileSync(p));
    } catch (err) {
      logger.warn('Failed to read anchor image', { path: p, err: String(err).slice(0, 120) });
    }
  }

  return buffers;
}

/** Copies an approved generated image into the anchor set. */
export function promoteToAnchor(sourcePath: string, name?: string): string {
  ensureAnchorsDir();
  const base = name ?? `anchor_${path.basename(sourcePath)}`;
  const dest = path.join(ANCHORS_DIR, base);
  fs.copyFileSync(sourcePath, dest);
  logger.info('Promoted image to style anchor', { dest });
  return dest;
}

/**
 * Prompt fragment telling the model what the references are for.
 *
 * Without this the model tends to reproduce the reference's composition; we
 * want its wardrobe and grade, not its framing.
 */
export const ANCHOR_PROMPT_NOTE =
  'Reference images are provided for STYLE ONLY: match their wardrobe palette, '
  + 'hair length and texture, accessories and film colour grade. '
  + 'Do NOT copy their composition, framing, location or pose — the scene described above is different.';

/**
 * Removes the anchor note from a prompt.
 *
 * `generateImage()` appends the note whenever anchors load, but a provider may
 * end up sending no references — uploads failed, or the model has no edit
 * endpoint. Leaving the note in would describe images the model never receives,
 * which is worse than saying nothing. Idempotent when the note is absent.
 */
export function stripAnchorNote(prompt: string): string {
  return prompt.replace(ANCHOR_PROMPT_NOTE, '').trimEnd();
}
