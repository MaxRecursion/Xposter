/**
 * AI image generator for the daily lifestyle post.
 *
 * Design constraints, learned the hard way from the free tier's output:
 *
 * 1. The model is small (Pollinations anonymous serves SANA only). It ignores
 *    negations. Telling it "face not visible" produced fully rendered, uncanny
 *    front-facing faces roughly half the time. So facelessness is enforced by
 *    CAMERA GEOMETRY — shot from behind, silhouette, cropped below the chin —
 *    which is a composition instruction it does follow.
 * 2. The same model reliably breaks on: hands doing fine motor work, more than
 *    one person, any readable text, spoked wheels, mirrors. Scenes are written
 *    to avoid putting those in frame at all rather than asking for them to be
 *    rendered well.
 * 3. Continuity across posts comes from the visual identity card (hair,
 *    wardrobe palette, signature accessory, film grade, lens) — not from a
 *    face, which is never shown.
 */
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getSetting } from '../storage/settings.js';
import { getVelocityMap } from '../context/trends.js';
import { isContextEnabled } from '../context/enrich.js';
import { generateWithClaude } from '../pipeline/claude_generator.js';
import { renderIdentity, resolveIdentity } from './identity.js';
import { buildImageProviders } from './providers/index.js';
import { readImageSize } from './dimensions.js';
import { ANCHOR_PROMPT_NOTE, loadAnchors } from './anchors.js';
import { recordImageGeneration } from '../storage/image_budget.js';
import { logEvent } from '../storage/queries.js';
import { getImageWidth, getImageHeight } from '../config.js';

const IMAGES_DIR = path.resolve(process.cwd(), 'data', 'images');

/** Ensure the images directory exists. */
function ensureDir(): void {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

// ── Geometry ──────────────────────────────────────────────────────────────────

/**
 * 4:5 portrait — X's tallest un-cropped feed aspect, so nothing important gets
 * clipped in-timeline.
 *
 * 640x800 = 512,000 px, which sits under Pollinations' ~590k pixel budget, so
 * it is returned at exactly the requested size. Anything larger (768x960 =
 * 737k) comes back silently downscaled, and a server-side resize is itself a
 * quality loss. Both dimensions are multiples of 32 to match the latent grid.
 */
export const DEFAULT_WIDTH = 640;
export const DEFAULT_HEIGHT = 800;

export function imageDimensions(): { width: number; height: number } {
  return {
    width: getImageWidth(),
    height: getImageHeight(),
  };
}

/** Ratio string for providers that take an aspect rather than pixel dimensions. */
export function imageAspectRatio(): string {
  const raw = getSetting('image_aspect', '4:5').trim();
  return /^\d+:\d+$/.test(raw) ? raw : '4:5';
}

// ── Scene catalogue ───────────────────────────────────────────────────────────

/** Camera geometries that make a face physically impossible to render. */
export type Framing =
  | 'back-three-quarter'
  | 'from-behind'
  | 'silhouette'
  | 'crop-below-chin'
  | 'detail-crop'
  | 'no-person';

/** How hands are kept out of trouble. */
export type HandState =
  | 'out-of-frame'
  | 'hidden'
  | 'pockets'
  | 'flat-on-surface'
  | 'large-simple-grip';

export interface Scene {
  id: string;
  description: string;
  framing: Framing;
  handState: HandState;
  velocityTags: string[];          // RAG topic tags that boost this scene
}

const FRAMING_CLAUSES: Record<Framing, string> = {
  'back-three-quarter': 'photographed from behind at a three-quarter angle, head turned away from the camera, face entirely out of view',
  'from-behind': 'photographed directly from behind, only her back and hair visible',
  'silhouette': 'rendered as a dark silhouette against bright window light, features completely lost in shadow',
  'crop-below-chin': 'framed from the shoulders down, the top of the frame cutting off below the chin',
  'detail-crop': 'a tight detail crop with no head in frame at all',
  'no-person': 'a still life with no person in the frame',
};

const HAND_CLAUSES: Record<HandState, string> = {
  'out-of-frame': 'hands out of frame',
  'hidden': 'hands not visible',
  'pockets': 'hands in her jacket pockets',
  'flat-on-surface': 'one hand resting flat on the surface, fingers relaxed and clearly separated',
  'large-simple-grip': 'one hand wrapped around a single thick handle in a simple closed grip',
};

/**
 * Every scene is written to keep faces, crowds, text and fine hand-work out of
 * frame. Scenes that used to violate that (eating street food, an auto
 * rickshaw's spoked wheels, bookshop spines, sticky notes on glass) were the
 * consistent source of malformed output and have been replaced.
 */
const SCENES: Scene[] = [
  { id: 'cafe_window_rain',   description: 'seated at a cafe window streaked with rain, a cup of chai on the table, blurred city street beyond the glass, moody overcast light', framing: 'back-three-quarter', handState: 'flat-on-surface',    velocityTags: ['monsoon', 'weather'] },
  { id: 'metro_door_window',  description: 'standing at the door of an almost empty metro carriage early in the morning, city skyline sliding past the window',                framing: 'silhouette',         handState: 'hidden',             velocityTags: ['metro', 'transit', 'roads'] },
  { id: 'desk_over_shoulder', description: 'at a desk in a warm plant-filled workspace, a dark defocused laptop screen ahead, afternoon light across the wood',                framing: 'back-three-quarter', handState: 'out-of-frame',       velocityTags: ['ai', 'tech', 'startup'] },
  { id: 'night_street_walk',  description: 'walking away down a night street lit by warm shopfront glow, wet tarmac reflecting the lights',                                    framing: 'from-behind',        handState: 'pockets',            velocityTags: ['food', 'culture'] },
  { id: 'taxi_window_night',  description: 'in the back seat of a taxi at night, city lights smearing past the window beside her',                                             framing: 'crop-below-chin',    handState: 'hidden',             velocityTags: ['roads', 'pune-area'] },
  { id: 'rooftop_dusk',       description: 'on a rooftop terrace at dusk facing the skyline, city lights coming on below, warm golden hour haze',                              framing: 'from-behind',        handState: 'out-of-frame',       velocityTags: [] },
  { id: 'plant_shop',         description: 'among tall leafy plants in a small nursery, dense green foliage and terracotta pots, soft diffused daylight',                      framing: 'back-three-quarter', handState: 'out-of-frame',       velocityTags: ['culture'] },
  { id: 'monsoon_umbrella',   description: 'walking away under a large plain umbrella on a wet pavement, puddles catching the streetlights, light rain falling',               framing: 'from-behind',        handState: 'large-simple-grip',  velocityTags: ['monsoon', 'weather'] },
  { id: 'stairwell_light',    description: 'on a concrete stairwell landing with a tall window throwing hard light across the wall',                                           framing: 'silhouette',         handState: 'hidden',             velocityTags: ['ai', 'startup', 'tech'] },
  { id: 'market_morning',     description: 'a canvas tote held at her side, heaped vegetables and marigolds in soft bokeh behind, early morning market light',                 framing: 'detail-crop',        handState: 'large-simple-grip',  velocityTags: [] },
  { id: 'balcony_morning',    description: 'at an apartment balcony railing overlooking low rooftops, a steel tumbler of tea on the ledge, hazy morning sun',                   framing: 'from-behind',        handState: 'flat-on-surface',    velocityTags: ['culture'] },
  { id: 'yoga_window',        description: 'stretching on a mat in front of a floor-to-ceiling window, bare room, early light flooding in',                                    framing: 'silhouette',         handState: 'out-of-frame',       velocityTags: [] },
  // No-person still lifes: the safest thing this model can render, and they
  // still read as the same camera roll.
  { id: 'chai_ledge_detail',  description: 'a small glass of cutting chai on a wet parapet ledge, the edge of an olive cotton sleeve just entering the frame, rain-dark stone', framing: 'no-person',          handState: 'out-of-frame',       velocityTags: ['monsoon', 'weather'] },
  { id: 'wet_shoes_pavement', description: 'looking straight down at worn canvas shoes on wet stone pavement, the hem of an indigo kurta above them, puddle reflections',       framing: 'no-person',          handState: 'out-of-frame',       velocityTags: ['monsoon', 'roads'] },
];

/** Scenes with no person at all — the safe harbour when QA keeps rejecting. */
export const SAFE_SCENE_IDS = ['chai_ledge_detail', 'wet_shoes_pavement'];

export function allScenes(): Scene[] {
  return SCENES;
}

export function getScene(id: string): Scene | undefined {
  return SCENES.find((s) => s.id === id);
}

/** Pick a scene, boosted by RAG velocity if context is enabled. */
export function pickScene(): Scene {
  let velMap: Map<string, number> = new Map();
  if (isContextEnabled()) {
    try { velMap = getVelocityMap(); } catch { /* ignore */ }
  }

  const weighted = SCENES.map<[Scene, number]>((scene) => {
    const boost = scene.velocityTags.reduce((max, tag) => Math.max(max, velMap.get(tag) ?? 1.0), 1.0);
    const velocity = Math.min(3.0, Math.max(0.5, boost));
    return [scene, velocity];
  });

  const total = weighted.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [scene, w] of weighted) {
    r -= w;
    if (r <= 0) return scene;
  }
  return SCENES[SCENES.length - 1];
}

/** Picks one of the no-person still lifes. Used as the last QA retry. */
export function pickSafeScene(): Scene {
  const safe = SCENES.filter((s) => SAFE_SCENE_IDS.includes(s.id));
  return safe[Math.floor(Math.random() * safe.length)] ?? SCENES[SCENES.length - 1];
}

// ── Prompt builder ────────────────────────────────────────────────────────────

/**
 * Exclusions, phrased as statements of absence rather than negations.
 *
 * A weak text encoder handles "the frame ends below the chin" far better than
 * "no face" — the latter often just summons a face. Kept last so it is not
 * truncated by any provider-side length limit.
 */
const EXCLUSION_CLAUSE = 'The frame excludes her face entirely. '
  + 'Plain surfaces with no signage, lettering or readable text anywhere. '
  + 'She is the only person in the frame. No mirrors, no reflections of her, no bicycles or spoked wheels.';

const QUALITY_CLAUSE = 'candid documentary photograph, authentic and unposed, sharp and correctly proportioned';

export interface BuildPromptOptions {
  /** Overrides the scene's own framing — used by the QA retry ladder. */
  framing?: Framing;
  handState?: HandState;
  /** One sensory sentence from Claude, slotted into the fixed template. */
  detail?: string;
}

/**
 * Assembles the prompt from fixed parts.
 *
 * Identity, framing, hands and exclusions are all code — never model output —
 * so a creative prompt-writer can't quietly reintroduce a face, a crowd or a
 * pair of hands doing something intricate.
 */
export function buildPrompt(scene: Scene, options: BuildPromptOptions = {}): string {
  const identity = resolveIdentity();
  const framing = options.framing ?? scene.framing;
  const handState = options.handState ?? scene.handState;

  const subject = framing === 'no-person'
    ? 'A still life in the style of a personal film photograph'
    : renderIdentity(identity);

  const parts = [
    subject,
    FRAMING_CLAUSES[framing],
    scene.description,
    options.detail?.trim(),
    framing === 'no-person' ? '' : HAND_CLAUSES[handState],
    identity.lens,
    identity.film,
    QUALITY_CLAUSE,
  ].filter((p) => p && p.trim());

  return `${parts.join(', ')}. ${EXCLUSION_CLAUSE}`;
}

const DETAIL_SYSTEM_PROMPT = 'You write a single vivid sensory detail for a photograph. '
  + 'Output one short phrase only — no sentences about people, faces, hands, text, signs or crowds. '
  + 'No explanation, no quotes.';

/**
 * Asks Claude for ONE sensory detail to slot into the fixed template.
 *
 * Deliberately narrow. Letting the model write the whole prompt is how scenes
 * like "eating vada pav" (hands + food + face) got reintroduced and produced
 * the malformed output this rewrite exists to fix.
 */
export async function buildDetailWithClaude(scene: Scene): Promise<string> {
  let trendingContext = '';
  if (isContextEnabled()) {
    try {
      const velMap = getVelocityMap();
      const top = [...velMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([tag]) => tag);
      if (top.length) trendingContext = `Today's mood in the city: ${top.join(', ')}.`;
    } catch { /* ignore */ }
  }

  const userPrompt = [
    'Photograph being composed:',
    scene.description,
    trendingContext,
    '',
    'Add ONE short phrase (under 120 characters) describing a single atmospheric detail —',
    'weather, light quality, a texture, a colour, a sound implied by the scene.',
    '',
    'Rules:',
    '- Do NOT mention faces, people, hands, expressions, text, signs, logos or crowds.',
    '- Do NOT describe the camera, the lens, or the film.',
    '- Output the phrase only.',
  ].filter(Boolean).join('\n');

  try {
    const result = await generateWithClaude(DETAIL_SYSTEM_PROMPT, userPrompt);
    const text = result.text.trim().replace(/^["']|["']$/g, '');
    if (text.length > 5 && text.length <= 160 && !/\b(face|hand|person|people|text|sign)\b/i.test(text)) {
      logger.info('Image detail generated', { scene: scene.id, detail: text });
      return text;
    }
    logger.info('Image detail rejected by guard, using template only', { scene: scene.id, chars: text.length });
  } catch (err) {
    logger.warn('Image detail generation failed, using template only', { scene: scene.id, err: String(err).slice(0, 200) });
  }
  return '';
}

// ── Image generation ──────────────────────────────────────────────────────────

export interface GeneratedImage {
  filePath: string;
  scene: Scene;
  prompt: string;
  model: string;
  seed: number;
  width: number;
  height: number;
  revisedPrompt?: string;
}

export interface GenerateImageOptions extends BuildPromptOptions {
  /** Explicit seed. Omit for a fresh roll. */
  seed?: number;
}

/**
 * Generates one image, walking the provider chain until one succeeds.
 *
 * The chain is only entered on a genuine failure — every provider in it is a
 * different backend, unlike the previous flux/turbo pair which were two names
 * for the same endpoint.
 */
export async function generateImage(
  sceneOverride?: Scene,
  options: GenerateImageOptions = {},
): Promise<GeneratedImage> {
  const scene = sceneOverride ?? pickScene();
  const detail = options.detail ?? await buildDetailWithClaude(scene);
  const basePrompt = buildPrompt(scene, { ...options, detail });
  const { width, height } = imageDimensions();
  const aspectRatio = imageAspectRatio();
  const seed = options.seed ?? Math.floor(Math.random() * 1_000_000);

  const providers = buildImageProviders();
  if (providers.length === 0) throw new Error('No image providers available');

  // Style anchors pin wardrobe, hair and colour grade across posts. The note
  // is appended per-provider only when that backend will actually receive refs
  // — otherwise it describes images the model never sees.
  const referenceImages = loadAnchors();

  logger.info('Generating image', {
    scene: scene.id,
    framing: options.framing ?? scene.framing,
    seed,
    references: referenceImages.length,
    providers: providers.map((p) => p.name),
  });

  let lastErr: unknown;
  for (const provider of providers) {
    try {
      const useRefs = Boolean(provider.supportsReferences) && referenceImages.length > 0;
      const prompt = useRefs ? `${basePrompt}\n\n${ANCHOR_PROMPT_NOTE}` : basePrompt;
      const result = await provider.generate({
        prompt, width, height, seed, aspectRatio,
        referenceImages: useRefs ? referenceImages : undefined,
      });

      // Record spend before anything else can throw, so the budget guard never
      // undercounts a call that actually billed.
      recordImageGeneration(provider.name, result.model, result.costUsd ?? 0);

      ensureDir();
      const fileName = `image_${scene.id}_${seed}_${Date.now()}.jpg`;
      const filePath = path.join(IMAGES_DIR, fileName);
      fs.writeFileSync(filePath, result.buffer);

      const size = readImageSize(result.buffer);
      logger.info('Image saved', {
        filePath, scene: scene.id, provider: provider.name,
        size: size ? `${size.width}x${size.height}` : 'unknown',
      });

      return {
        filePath,
        scene,
        prompt,
        model: result.model,
        seed,
        width: size?.width ?? width,
        height: size?.height ?? height,
        revisedPrompt: result.revisedPrompt,
      };
    } catch (err) {
      lastErr = err;

      // A call that was charged but produced nothing usable must still reach
      // the ledger. Otherwise a repeated safety refusal is an invisible spend
      // loop the budget guard never sees. Duck-typed so this file stays free of
      // provider-specific imports.
      const billedUsd = (err as { billedUsd?: number })?.billedUsd;
      if (typeof billedUsd === 'number' && billedUsd > 0) {
        recordImageGeneration(provider.name, `${provider.name}:billed-no-image`, billedUsd);
      }

      logger.warn('Image provider failed, trying next in chain', {
        provider: provider.name,
        err: String(err).slice(0, 200),
      });

      // A paid provider dropping to a free one silently degrades image quality
      // for as long as the cause persists — make it visible.
      if (provider.costPerImageUsd() > 0) {
        logEvent('IMAGE_PROVIDER_FALLBACK', `${provider.name} failed: ${String(err).slice(0, 160)}`);
      }
    }
  }

  throw lastErr ?? new Error('All image providers failed');
}
