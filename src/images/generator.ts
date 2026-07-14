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
  'expressive eyes, candid lifestyle photography style, natural light, ' +
  'film grain, urban Pune aesthetic, authentic slice-of-life moment';

export function buildPrompt(scene: Scene, characterOverride?: string): string {
  const character = characterOverride ?? process.env.IMAGE_CHARACTER_PROMPT ?? DEFAULT_CHARACTER;
  return `${character}, ${scene.description}. High quality, photorealistic, no text, no watermark.`;
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
 *   1. Pollinations.ai  — free, no API key, Flux model (default)
 *   2. DALL-E 3         — if OPENAI_API_KEY is set (higher quality, ~$0.04/img)
 *
 * Set IMAGE_PROVIDER=openai in .env to force DALL-E 3.
 */
export async function generateImage(sceneOverride?: Scene): Promise<GeneratedImage> {
  const scene = sceneOverride ?? pickScene();
  const prompt = buildPrompt(scene);

  const provider = process.env.IMAGE_PROVIDER ?? (process.env.OPENAI_API_KEY ? 'openai' : 'pollinations');
  logger.info('Generating image', { scene: scene.id, provider });

  if (provider === 'openai') {
    return generateWithOpenAI(scene, prompt);
  }
  return generateWithPollinations(scene, prompt);
}

/** Free: Pollinations.ai — no API key required, uses Flux model. */
async function generateWithPollinations(scene: Scene, prompt: string): Promise<GeneratedImage> {
  const seed = Math.floor(Math.random() * 1_000_000);
  const encodedPrompt = encodeURIComponent(prompt);
  const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&model=flux&seed=${seed}&nologo=true&enhance=true`;

  logger.info('Calling Pollinations.ai', { scene: scene.id, seed });

  const imgResponse = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 90_000, // Pollinations can be slow on first request
    headers: { 'User-Agent': 'Xposter/1.0' },
  });

  ensureDir();
  const fileName = `image_${scene.id}_${Date.now()}.jpg`;
  const filePath = path.join(IMAGES_DIR, fileName);
  fs.writeFileSync(filePath, imgResponse.data);

  logger.info('Image saved (Pollinations)', { filePath, scene: scene.id });
  return { filePath, scene, prompt, model: 'flux-pollinations' };
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
