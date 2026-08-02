/**
 * fal.ai image generation.
 *
 * Chosen over Gemini direct because fal has NO minimum spend and no expiring
 * credits, while hosting `nano-banana-2` — which IS gemini-3.1-flash-image.
 * The ~19% markup ($0.08 vs $0.067) is what buys out of Google's ₹2500 floor.
 * (Kling was evaluated and is worse: $9.80 minimum that expires every 30 days,
 * then $700.)
 *
 * Two decisions shape the code:
 *
 * 1. `sync_mode: true` on the synchronous endpoint. The bytes come back inline
 *    as a data URI, which removes an entire failure class — a second HTTP
 *    request that can fail AFTER fal has already billed.
 * 2. Errors are classified into retry / fatal / billed. A billed call must
 *    never be retried and must always reach the ledger, or the budget guard is
 *    blind to money that was actually spent.
 */
import axios, { AxiosError } from 'axios';
import { logger } from '../../utils/logger.js';
import {
  getFalImageEditModel, getFalImageModel, getFalImageResolution, getFalKey,
} from '../../config.js';
import { stripAnchorNote } from '../anchors.js';
import { sniffMime } from '../mime.js';
import { resolveFalReferences } from './fal_references.js';
import type { GenerateRequest, GenerateResult, ImageProvider } from './types.js';

export { sniffMime };

const RUN_BASE = 'https://fal.run';
const TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;

/**
 * Thrown when a call was charged but produced nothing usable.
 *
 * `generateImage()` duck-types on `billedUsd` so it can record the spend
 * without importing anything provider-specific.
 */
export class FalBilledError extends Error {
  readonly billedUsd: number;
  constructor(message: string, billedUsd: number) {
    super(message);
    this.name = 'FalBilledError';
    this.billedUsd = billedUsd;
  }
}

/**
 * Published per-image prices (USD).
 *
 * A `:*` tier exists for models that take no `resolution` at all — without it,
 * FAL_IMAGE_RESOLUTION=2K plus flux/schnell would charge the ledger the 2K
 * rate for a $0.003 call.
 */
const PRICE_USD: Record<string, number> = {
  'fal-ai/nano-banana-2:0.5K': 0.06,
  'fal-ai/nano-banana-2:1K': 0.08,
  'fal-ai/nano-banana-2:2K': 0.12,
  'fal-ai/nano-banana-2:4K': 0.16,
  'fal-ai/flux-pro/kontext:*': 0.04,
  'fal-ai/bytedance/seedream/v4:*': 0.03,
  'fal-ai/flux/schnell:*': 0.003,
};

const MAX_KNOWN_PRICE = Math.max(...Object.values(PRICE_USD));

/** Models whose `/edit` sibling takes `image_urls` under the same schema. */
const EDIT_CAPABLE = new Set(['fal-ai/nano-banana-2']);

/** Aspect ratios the API accepts. `auto` is excluded — we always want an explicit one. */
const SUPPORTED_RATIOS: Array<[string, number]> = [
  ['21:9', 21 / 9], ['16:9', 16 / 9], ['3:2', 1.5], ['4:3', 4 / 3], ['5:4', 1.25],
  ['1:1', 1], ['4:5', 0.8], ['3:4', 0.75], ['2:3', 2 / 3], ['9:16', 0.5625],
];

// ── Pure helpers (unit-tested without network) ────────────────────────────────

/** Strips a trailing `/edit` so the edit endpoint inherits the base model's price. */
export function baseModelOf(model: string): string {
  return model.replace(/\/edit$/, '');
}

export function priceFor(model: string, resolution: string): number {
  const base = baseModelOf(model);
  return PRICE_USD[`${base}:${resolution}`]
    ?? PRICE_USD[`${base}:*`]
    ?? MAX_KNOWN_PRICE;
}

/**
 * The endpoint to use when reference images are present, or null if this model
 * has no known edit sibling.
 *
 * Returning null rather than guessing `${model}/edit` is deliberate: the
 * pattern is wrong elsewhere on fal (flux-pro/kontext takes a singular
 * `image_url`), and a wrong endpoint is a billed 404-shaped failure.
 */
export function editModelFor(model: string): string | null {
  const override = getFalImageEditModel();
  if (override) return override;
  const base = baseModelOf(model);
  return EDIT_CAPABLE.has(base) ? `${base}/edit` : null;
}

export function nearestFalAspect(width: number, height: number): string {
  const target = width / height;
  let best = SUPPORTED_RATIOS[0];
  for (const candidate of SUPPORTED_RATIOS) {
    if (Math.abs(candidate[1] - target) < Math.abs(best[1] - target)) best = candidate;
  }
  return best[0];
}

/** Passes a valid requested ratio through; otherwise derives one from pixels. */
export function resolveAspect(requested: string | undefined, width: number, height: number): string {
  if (requested && SUPPORTED_RATIOS.some(([name]) => name === requested)) return requested;
  return nearestFalAspect(width, height);
}

export function endpointFor(model: string): string {
  return `${RUN_BASE}/${model}`;
}

export interface FalBodyOptions {
  resolution: string;
  imageUrls?: string[];
}

/**
 * Builds the request body.
 *
 * Every field here is a cost lever, which is why they're all pinned and tested:
 * `num_images` above 1 multiplies the bill, and `enable_web_search` adds
 * $0.015 per call.
 *
 * Deliberately NOT sent: `safety_tolerance` (the 1-vs-6 polarity is unverified
 * — guessing wrong either loosens safety or causes billed refusals),
 * `limit_generations` and `thinking_level` (semantics unclear), and
 * `system_prompt` (the prompt is already fully assembled by buildPrompt()).
 */
export function buildRequestBody(req: GenerateRequest, opts: FalBodyOptions): Record<string, unknown> {
  const imageUrls = opts.imageUrls ?? [];
  return {
    prompt: req.prompt,
    num_images: 1,
    aspect_ratio: resolveAspect(req.aspectRatio, req.width, req.height),
    resolution: opts.resolution,
    // generator.ts always writes .jpg, and Playwright's setInputFiles() derives
    // the MIME type from the extension — PNG bytes under a .jpg name would risk
    // the upload to X failing.
    output_format: 'jpeg',
    // Returns the image inline as a data URI, so there is no second request
    // that could fail after fal has billed.
    sync_mode: true,
    enable_web_search: false,
    seed: req.seed,
    ...(imageUrls.length > 0 ? { image_urls: imageUrls } : {}),
  };
}

interface FalResponse {
  images?: Array<{ url?: string; content_type?: string; width?: number; height?: number }>;
  description?: string;
}

export function extractImageUrl(body: FalResponse): string | null {
  const url = body?.images?.[0]?.url;
  return typeof url === 'string' && url.length > 0 ? url : null;
}

export function extractDescription(body: FalResponse): string | undefined {
  return typeof body?.description === 'string' && body.description ? body.description : undefined;
}

export function decodeDataUri(url: string): { buffer: Buffer; contentType: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (!match) return null;
  try {
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length === 0) return null;
    return { buffer, contentType: match[1] };
  } catch {
    return null;
  }
}

export type ErrorClass = 'retry' | 'fatal' | 'billed';

/**
 * Classifies a failure so a billed call is never retried.
 *
 * Timeouts are treated as billed: the request reached the model, so retrying
 * could bill three times for one image. Over-counting a timeout costs a
 * degraded-to-free day; under-counting costs real money on a prepaid balance.
 */
export function classifyError(err: unknown): ErrorClass {
  const e = err as AxiosError & { code?: string };
  const status = e?.response?.status;

  if (status !== undefined) {
    if (status === 429 || status >= 500) return 'retry';
    if (status >= 400) return 'fatal';
  }

  if (e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT') return 'billed';
  if (e?.code === 'ENOTFOUND' || e?.code === 'ECONNREFUSED' || e?.code === 'EAI_AGAIN') return 'retry';

  return 'retry';
}

// ── Provider ──────────────────────────────────────────────────────────────────

export interface FalProviderDeps {
  /** Resolves anchor buffers to values usable in `image_urls`. Injected for testability. */
  resolveReferences?: (buffers: Buffer[]) => Promise<string[]>;
}

export function falProvider(deps: FalProviderDeps = {}): ImageProvider {
  return {
    name: 'fal',
    isAvailable: () => !!getFalKey(),
    costPerImageUsd: () => priceFor(getFalImageModel(), getFalImageResolution()),
    supportsReferences: true,

    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const apiKey = getFalKey();
      if (!apiKey) throw new Error('FAL_KEY not set');

      const resolution = getFalImageResolution();
      const baseModel = getFalImageModel();

      // Resolve references first — the endpoint choice depends on whether we
      // actually ended up with any.
      let imageUrls: string[] = [];
      if (req.referenceImages?.length) {
        const resolver = deps.resolveReferences ?? resolveFalReferences;
        try {
          imageUrls = await resolver(req.referenceImages);
        } catch (err) {
          logger.warn('Reference resolution failed — generating without style anchors', {
            err: String(err).slice(0, 200),
          });
        }
      }

      let model = baseModel;
      if (imageUrls.length > 0) {
        const editModel = editModelFor(baseModel);
        if (editModel) {
          model = editModel;
        } else {
          logger.warn('Model has no known edit endpoint — dropping style references', { model: baseModel });
          imageUrls = [];
        }
      }

      // If no references are going out, the anchor note in the prompt would be
      // describing images the model never receives.
      const prompt = imageUrls.length > 0 ? req.prompt : stripAnchorNote(req.prompt);
      const price = priceFor(model, resolution);
      const body = buildRequestBody({ ...req, prompt }, { resolution, imageUrls });

      logger.info('Calling fal.ai', {
        model, resolution, aspectRatio: body.aspect_ratio, references: imageUrls.length,
      });

      let lastErr: unknown;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const response = await axios.post<FalResponse>(endpointFor(model), body, {
            headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
            timeout: TIMEOUT_MS,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
          });

          // Past this point fal has billed. Any failure is a FalBilledError so
          // the spend still reaches the ledger, and is thrown OUT of the retry
          // loop so we never pay twice for the same image.
          const url = extractImageUrl(response.data);
          if (!url) throw new FalBilledError('fal returned no image', price);

          const buffer = await downloadImage(url, price);
          return {
            buffer,
            model: `fal:${model}`,
            costUsd: price,
            revisedPrompt: extractDescription(response.data),
          };
        } catch (err) {
          if (err instanceof FalBilledError) throw err;
          lastErr = err;

          const kind = classifyError(err);
          const status = (err as AxiosError)?.response?.status;

          if (kind === 'fatal') {
            const detail = JSON.stringify((err as AxiosError)?.response?.data ?? {}).slice(0, 300);
            throw new Error(`fal rejected the request (${status}): ${detail}`);
          }
          if (kind === 'billed') {
            throw new FalBilledError(`fal call timed out after billing: ${String(err).slice(0, 160)}`, price);
          }

          logger.warn(`fal attempt ${attempt}/${MAX_ATTEMPTS} failed`, {
            status, err: String(err).slice(0, 200),
          });
          if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 2_000 * attempt));
        }
      }
      throw lastErr;
    },
  };
}

/**
 * Fetches the generated image.
 *
 * Under `sync_mode` this is a local base64 decode. The https branch is a
 * fallback in case sync_mode is ever ignored — and a failure there is billed,
 * because fal has already charged for the generation.
 */
async function downloadImage(url: string, price: number): Promise<Buffer> {
  const inline = decodeDataUri(url);
  if (inline) return inline.buffer;

  try {
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 60_000 });
    return Buffer.from(response.data);
  } catch (err) {
    throw new FalBilledError(`fal image download failed: ${String(err).slice(0, 160)}`, price);
  }
}
