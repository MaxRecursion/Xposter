/**
 * AI image generator — calls OpenAI DALL-E 3 (or any compatible API) to produce
 * lifestyle portrait images, saves to disk, and returns the local file path.
 */
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getVelocityMap } from '../context/trends.js';
import { isContextEnabled } from '../context/enrich.js';
import { generateWithClaude } from '../pipeline/claude_generator.js';

const IMAGES_DIR = path.resolve(process.cwd(), 'data', 'images');

/** Ensure the images directory exists. */
function ensureDir(): void {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

// ── Scene catalogue ───────────────────────────────────────────────────────────

export interface Scene {
  id: string;
  description: string;
  velocityTags: string[];          // RAG topic tags that boost this scene
}

const SCENES: Scene[] = [
  { id: 'cafe_rain',        description: 'sitting by a rain-streaked cafe window with a cup of chai, city street visible outside, moody natural light', velocityTags: ['monsoon', 'weather'] },
  { id: 'metro_commute',    description: 'standing near the door of a metro train, city skyline blurring past the window, wearing earphones', velocityTags: ['metro', 'transit', 'roads'] },
  { id: 'coworking',        description: 'working on a laptop at a modern coworking space, plants and warm lighting, focused expression', velocityTags: ['ai', 'tech', 'startup'] },
  { id: 'street_food',      description: 'eating vada pav from a street stall at night, city lights in the background, casual street style', velocityTags: ['food', 'culture'] },
  { id: 'auto_rickshaw',    description: 'sitting in the back of a moving auto rickshaw, wind in hair, evening city traffic outside', velocityTags: ['roads', 'pune-area'] },
  { id: 'rooftop_evening',  description: 'sitting on a rooftop terrace at dusk, city lights coming on below, warm golden hour light', velocityTags: [] },
  { id: 'bookstore',        description: 'browsing books in a cosy independent bookstore, soft warm lighting, casual outfit', velocityTags: ['culture'] },
  { id: 'monsoon_walk',     description: 'walking with an umbrella on a wet pavement, puddles reflecting street lights, light rain', velocityTags: ['monsoon', 'weather'] },
  { id: 'startup_office',   description: 'in a bright modern startup office, sticky notes on glass wall behind, casual conversation gesture', velocityTags: ['ai', 'startup', 'tech'] },
  { id: 'farmers_market',   description: 'at an outdoor weekend market browsing vegetables and flowers, morning light, cloth bag in hand', velocityTags: [] },
  { id: 'reading_balcony',  description: 'reading a book on an apartment balcony overlooking the city, morning tea beside her', velocityTags: ['culture'] },
  { id: 'gym_morning',      description: 'stretching on a yoga mat near a floor-to-ceiling window, early morning light, city view', velocityTags: [] },
];

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

// ── Prompt builder ────────────────────────────────────────────────────────────

const DEFAULT_CHARACTER =
  'A young Indian woman in her mid-20s, dark wavy hair, warm brown skin, ' +
  'candid lifestyle photography style, natural light, film grain, urban Pune aesthetic, ' +
  'authentic slice-of-life moment';

// Pick a random mystery pose so face is never clearly visible
const MYSTERY_POSES = [
  'face turned away looking into the distance',
  'hair falling across face obscuring features',
  'wearing a dupatta or scarf partially covering face',
  'shot from behind, looking over shoulder',
  'face tilted down, partially hidden by hair',
  'wearing sunglasses, face partially in shadow',
  'looking away from camera at something off-frame',
  'silhouette against bright window, face in shadow',
  'hair blowing across face in the wind',
  'face buried in a book or cup, only profile visible',
];

export function buildPrompt(scene: Scene, characterOverride?: string): string {
  const character = characterOverride ?? process.env.IMAGE_CHARACTER_PROMPT ?? DEFAULT_CHARACTER;
  const pose = MYSTERY_POSES[Math.floor(Math.random() * MYSTERY_POSES.length)];
  return `${character}, ${pose}, ${scene.description}. High quality, photorealistic, no text, no watermark, face not clearly visible, mysterious and atmospheric.`;
}

/**
 * Ask Claude to write a creative, context-aware image prompt for the given scene.
 * Falls back to the static template if Claude is unavailable or fails.
 */
export async function buildPromptWithClaude(scene: Scene): Promise<string> {
  // Gather top trending tags to give Claude topical context
  let trendingContext = '';
  if (isContextEnabled()) {
    try {
      const velMap = getVelocityMap();
      const top = [...velMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([tag]) => tag);
      if (top.length) trendingContext = `Trending topics in Pune today: ${top.join(', ')}.`;
    } catch { /* ignore */ }
  }

  const systemPrompt =
    'You write concise image generation prompts for photorealistic AI art. ' +
    'Every prompt must keep the subject\'s face hidden or obscured — this is non-negotiable. ' +
    'Output only the prompt text, nothing else.';

  const userPrompt = [
    'Write a single image generation prompt (under 280 characters) for a candid lifestyle photo.',
    '',
    `Subject: A young Indian woman in her mid-20s, dark wavy hair, warm brown skin, urban Pune aesthetic, film grain, natural light.`,
    `Scene: ${scene.description}`,
    trendingContext,
    '',
    'Hard rules:',
    '- Face must NOT be visible: looking away, hair across face, sunglasses, shot from behind, silhouette, scarf, or face in shadow.',
    '- Photorealistic, candid, no text, no watermark.',
    '- Do NOT include any character name or model reference.',
    '- Output the prompt only — no explanation, no quotes.',
  ].filter(Boolean).join('\n');

  try {
    const result = await generateWithClaude(systemPrompt, userPrompt);
    const text = result.text.trim();
    if (text.length > 20) {
      logger.info('Claude image prompt generated', { scene: scene.id, chars: text.length });
      return text;
    }
  } catch (err) {
    logger.warn('Claude image prompt generation failed, using template', { scene: scene.id, err: String(err).slice(0, 200) });
  }
  // Fallback to static template
  return buildPrompt(scene);
}

// ── Image generation ──────────────────────────────────────────────────────────

export interface GeneratedImage {
  filePath: string;
  scene: Scene;
  prompt: string;
  model: string;
  revisedPrompt?: string;
}

/**
 * Generate an image using the best available provider:
 *   1. Pollinations.ai (flux)  — free, no API key (default)
 *   2. Pollinations.ai (turbo) — free fallback if flux is overloaded
 *   3. Hugging Face FLUX.1-schnell — free fallback if HF_API_KEY is set
 *   4. DALL-E 3                — if IMAGE_PROVIDER=openai (higher quality, ~$0.04/img)
 *
 * Set IMAGE_PROVIDER=openai in .env to force DALL-E 3.
 */
export async function generateImage(sceneOverride?: Scene): Promise<GeneratedImage> {
  const scene = sceneOverride ?? pickScene();
  // Use Claude to write a creative prompt; falls back to static template if unavailable.
  const prompt = await buildPromptWithClaude(scene);

  const provider = process.env.IMAGE_PROVIDER ?? (process.env.OPENAI_API_KEY ? 'openai' : 'pollinations');
  logger.info('Generating image', { scene: scene.id, provider });

  if (provider === 'openai') {
    return generateWithOpenAI(scene, prompt);
  }

  try {
    return await generateWithPollinations(scene, prompt, 'flux');
  } catch (fluxErr) {
    logger.warn('Pollinations flux exhausted, falling back to turbo', { scene: scene.id, err: String(fluxErr) });
    try {
      return await generateWithPollinations(scene, prompt, 'turbo');
    } catch (turboErr) {
      logger.warn('Pollinations turbo exhausted', { scene: scene.id, err: String(turboErr) });
      if (process.env.HF_API_KEY) {
        return generateWithHuggingFace(scene, prompt);
      }
      throw turboErr;
    }
  }
}

/** Free: Pollinations.ai — no API key required. Retries 3x before giving up. */
async function generateWithPollinations(
  scene: Scene,
  prompt: string,
  model: 'flux' | 'turbo',
): Promise<GeneratedImage> {
  const seed = Math.floor(Math.random() * 1_000_000);
  const encodedPrompt = encodeURIComponent(prompt);
  const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&model=${model}&seed=${seed}&nologo=true&nofeed=true`;

  logger.info('Calling Pollinations.ai', { scene: scene.id, seed, model });

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const imgResponse = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 90_000,
        headers: { 'User-Agent': 'Xposter/1.0' },
      });

      ensureDir();
      const fileName = `image_${scene.id}_${Date.now()}.jpg`;
      const filePath = path.join(IMAGES_DIR, fileName);
      fs.writeFileSync(filePath, imgResponse.data);

      logger.info('Image saved (Pollinations)', { filePath, scene: scene.id, model, attempt });
      return { filePath, scene, prompt, model: `${model}-pollinations` };
    } catch (err) {
      lastErr = err;
      logger.warn(`Pollinations ${model} attempt ${attempt}/3 failed`, { err: String(err) });
      if (attempt < 3) await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  throw lastErr;
}

/** Free (last resort): Hugging Face Inference API, FLUX.1-schnell. Requires HF_API_KEY. */
async function generateWithHuggingFace(scene: Scene, prompt: string): Promise<GeneratedImage> {
  const apiKey = process.env.HF_API_KEY;
  if (!apiKey) throw new Error('HF_API_KEY not set');

  logger.info('Calling Hugging Face Inference API', { scene: scene.id });

  const response = await axios.post(
    'https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell',
    { inputs: prompt },
    {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      responseType: 'arraybuffer',
      timeout: 90_000,
    },
  );

  ensureDir();
  const fileName = `image_${scene.id}_${Date.now()}.jpg`;
  const filePath = path.join(IMAGES_DIR, fileName);
  fs.writeFileSync(filePath, response.data);

  logger.info('Image saved (Hugging Face)', { filePath, scene: scene.id });
  return { filePath, scene, prompt, model: 'flux-schnell-hf' };
}

/** Paid: DALL-E 3 via OpenAI API (~$0.04–0.08/image). */
async function generateWithOpenAI(scene: Scene, prompt: string): Promise<GeneratedImage> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const response = await axios.post(
    'https://api.openai.com/v1/images/generations',
    { model: 'dall-e-3', prompt, n: 1, size: '1024x1024', response_format: 'url', quality: 'standard' },
    { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 60_000 },
  );

  const imageUrl: string = response.data?.data?.[0]?.url;
  const revisedPrompt: string | undefined = response.data?.data?.[0]?.revised_prompt;
  if (!imageUrl) throw new Error('DALL-E 3 returned no image URL');

  ensureDir();
  const fileName = `image_${scene.id}_${Date.now()}.png`;
  const filePath = path.join(IMAGES_DIR, fileName);

  const imgResponse = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30_000 });
  fs.writeFileSync(filePath, imgResponse.data);

  logger.info('Image saved (DALL-E 3)', { filePath, scene: scene.id });
  return { filePath, scene, prompt, model: 'dall-e-3', revisedPrompt };
}
