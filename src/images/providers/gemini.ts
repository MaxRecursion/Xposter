/**
 * Google Gemini image generation via the Interactions API.
 *
 * Unlike Pollinations, this accepts reference images. The persona is faceless,
 * so there is no facial identity to preserve — the references are used for
 * wardrobe, hair and colour-grade continuity, which holds the "same camera
 * roll" feel far tighter than a text description can.
 *
 * Takes an aspect ratio + size tier rather than pixel dimensions, so 4:5 is
 * requested directly instead of being approximated by a width/height pair.
 */
import axios, { AxiosError } from 'axios';
import { logger } from '../../utils/logger.js';
import { getGeminiApiKey, getGeminiImageModel, getGeminiImageSize } from '../../config.js';
import type { GenerateRequest, GenerateResult, ImageProvider } from './types.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;

export const DEFAULT_MODEL = 'gemini-3.1-flash-image';
export const DEFAULT_IMAGE_SIZE = '1K';

/**
 * Published per-image prices (USD), used for the monthly budget guard.
 * Keyed by `${model}:${image_size}`. Falls back to the most expensive entry
 * for an unknown model so an unpriced model can never look free.
 */
const PRICE_USD: Record<string, number> = {
  'gemini-3.1-flash-image:512px': 0.045,
  'gemini-3.1-flash-image:1K': 0.067,
  'gemini-3.1-flash-image:2K': 0.101,
  'gemini-3.1-flash-image:4K': 0.151,
  'gemini-3-pro-image:1K': 0.134,
  'gemini-3-pro-image:2K': 0.134,
  'gemini-3-pro-image:4K': 0.24,
  'gemini-3.1-flash-lite-image:1K': 0.0336,
  'gemini-2.5-flash-image:1K': 0.039,
};

const MAX_KNOWN_PRICE = Math.max(...Object.values(PRICE_USD));

/** Aspect ratios the API accepts. Anything else is snapped to the closest. */
const SUPPORTED_RATIOS: Array<[string, number]> = [
  ['1:1', 1], ['3:2', 1.5], ['2:3', 2 / 3], ['3:4', 0.75], ['4:3', 4 / 3],
  ['4:5', 0.8], ['5:4', 1.25], ['9:16', 0.5625], ['16:9', 16 / 9], ['21:9', 21 / 9],
];

export function geminiModel(): string {
  return getGeminiImageModel();
}

export function geminiImageSize(): string {
  return getGeminiImageSize();
}

export function priceFor(model: string, size: string): number {
  return PRICE_USD[`${model}:${size}`] ?? MAX_KNOWN_PRICE;
}

/** Snaps an arbitrary width/height to the nearest ratio the API supports. */
export function nearestAspectRatio(width: number, height: number): string {
  const target = width / height;
  let best = SUPPORTED_RATIOS[0];
  for (const candidate of SUPPORTED_RATIOS) {
    if (Math.abs(candidate[1] - target) < Math.abs(best[1] - target)) best = candidate;
  }
  return best[0];
}

interface InteractionsResponse {
  output_image?: { data?: string; mime_type?: string };
  steps?: Array<{ content?: Array<{ type?: string; data?: string }> }>;
}

/**
 * Pulls the base64 image out of the response.
 *
 * `output_image.data` is the documented location, but the interaction also
 * carries a `steps` log that can hold the same payload. Checking both means a
 * shape change on one path doesn't break generation outright.
 */
export function extractImage(body: InteractionsResponse): string | null {
  const direct = body?.output_image?.data;
  if (typeof direct === 'string' && direct.length > 0) return direct;

  for (const step of body?.steps ?? []) {
    for (const item of step?.content ?? []) {
      if (item?.type === 'image' && typeof item.data === 'string' && item.data.length > 0) {
        return item.data;
      }
    }
  }
  return null;
}

export function geminiProvider(): ImageProvider {
  return {
    name: 'gemini',
    isAvailable: () => !!getGeminiApiKey(),
    costPerImageUsd: () => priceFor(geminiModel(), geminiImageSize()),

    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const apiKey = getGeminiApiKey();
      if (!apiKey) throw new Error('GEMINI_API_KEY not set');

      const model = geminiModel();
      const imageSize = geminiImageSize();
      const aspectRatio = req.aspectRatio ?? nearestAspectRatio(req.width, req.height);

      const input: Array<Record<string, string>> = [{ type: 'text', text: req.prompt }];
      for (const ref of req.referenceImages ?? []) {
        input.push({ type: 'image', mime_type: 'image/jpeg', data: ref.toString('base64') });
      }

      const body = {
        model,
        input,
        response_format: {
          type: 'image',
          mime_type: 'image/jpeg',
          aspect_ratio: aspectRatio,
          image_size: imageSize,
        },
      };

      logger.info('Calling Gemini image API', {
        model, aspectRatio, imageSize, references: req.referenceImages?.length ?? 0,
      });

      let lastErr: unknown;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const response = await axios.post<InteractionsResponse>(ENDPOINT, body, {
            headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
            timeout: TIMEOUT_MS,
          });

          const b64 = extractImage(response.data);
          if (!b64) throw new Error('Gemini returned no image data');

          return {
            buffer: Buffer.from(b64, 'base64'),
            model: `gemini:${model}`,
            costUsd: priceFor(model, imageSize),
          };
        } catch (err) {
          lastErr = err;
          const status = (err as AxiosError)?.response?.status;

          // 4xx other than rate-limit is a request problem — retrying just
          // burns money and time on the same rejection.
          if (status && status >= 400 && status < 500 && status !== 429) {
            const detail = JSON.stringify((err as AxiosError)?.response?.data ?? {}).slice(0, 300);
            throw new Error(`Gemini rejected the request (${status}): ${detail}`);
          }

          logger.warn(`Gemini attempt ${attempt}/${MAX_ATTEMPTS} failed`, {
            status, err: String(err).slice(0, 200),
          });
          if (attempt < MAX_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, 2_000 * attempt));
          }
        }
      }
      throw lastErr;
    },
  };
}
