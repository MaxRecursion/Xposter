/**
 * Turns local anchor buffers into values fal's `image_urls` will accept.
 *
 * Three modes:
 *
 *   upload  — hash-cached upload to the fal CDN (default). Model APIs need a
 *             public HTTPS URL; the serverless `/data` filesystem API does NOT
 *             provide one, so we use rest.fal.ai storage initiate + PUT.
 *   datauri — inline base64, no upload
 *   off     — send no references at all
 *
 * An `auto` mode that tries one and falls back is deliberately not built: it
 * doubles the failure surface for a question one experiment answers.
 */
import axios from 'axios';
import { getFalKey, getFalReferenceMode, getFalUploadTtlDays } from '../../config.js';
import { hashBuffer, lookupUpload, rememberUpload } from '../../storage/image_uploads.js';
import { logger } from '../../utils/logger.js';
import { extensionForMime, sniffMime } from '../mime.js';

const INITIATE_URL = 'https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3';
const UPLOAD_TIMEOUT_MS = 30_000;
const PROVIDER = 'fal';

export interface InitiateUploadResponse {
  upload_url?: string;
  file_url?: string;
}

/**
 * Pulls the public CDN URL from an initiate-upload response.
 *
 * The documented shape is `{ upload_url, file_url }`. Older/alternate fields
 * are accepted so a response-shape tweak does not silently drop anchors.
 */
export function extractUploadedUrl(body: unknown): string | null {
  const b = body as Record<string, unknown> | null;
  if (!b) return null;
  for (const key of ['file_url', 'access_url', 'url']) {
    const value = b[key];
    if (typeof value === 'string' && value.startsWith('http')) return value;
  }
  const nested = b.data as Record<string, unknown> | undefined;
  if (nested && typeof nested.url === 'string' && nested.url.startsWith('http')) return nested.url;
  return null;
}

export function extractUploadTarget(body: unknown): { uploadUrl: string; fileUrl: string } | null {
  const b = body as InitiateUploadResponse | null;
  if (!b) return null;
  const uploadUrl = typeof b.upload_url === 'string' ? b.upload_url : null;
  const fileUrl = extractUploadedUrl(body);
  if (!uploadUrl || !fileUrl) return null;
  return { uploadUrl, fileUrl };
}

async function uploadOne(buf: Buffer): Promise<string | null> {
  const apiKey = getFalKey();
  if (!apiKey) return null;

  const hash = hashBuffer(buf);
  const ttlDays = getFalUploadTtlDays();

  const cached = lookupUpload(PROVIDER, hash, ttlDays);
  if (cached) {
    if (!cached.startsWith('http')) {
      // Stale cache from an earlier broken /data-filesystem path — force re-upload.
      logger.warn('Ignoring non-HTTP cached fal upload URL', { hash: hash.slice(0, 12) });
    } else {
      return cached;
    }
  }

  const mime = sniffMime(buf);
  const ext = extensionForMime(mime);
  const fileName = `xposter-anchor-${hash.slice(0, 16)}.${ext}`;

  try {
    const initiate = await axios.post<InitiateUploadResponse>(
      INITIATE_URL,
      { file_name: fileName, content_type: mime },
      {
        headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: UPLOAD_TIMEOUT_MS,
      },
    );

    const target = extractUploadTarget(initiate.data);
    if (!target) {
      logger.warn('fal CDN initiate returned no upload/file URL', {
        keys: Object.keys((initiate.data ?? {}) as object).join(','),
      });
      return null;
    }

    await axios.put(target.uploadUrl, buf, {
      headers: { 'Content-Type': mime },
      timeout: UPLOAD_TIMEOUT_MS,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    if (!target.fileUrl.startsWith('http')) {
      logger.warn('fal CDN upload produced a non-HTTP file URL', { fileUrl: target.fileUrl.slice(0, 80) });
      return null;
    }

    rememberUpload(PROVIDER, hash, target.fileUrl, buf.length, mime);
    logger.info('Uploaded style anchor to fal CDN', { bytes: buf.length, fileName });
    return target.fileUrl;
  } catch (err) {
    logger.warn('fal anchor CDN upload failed', { err: String(err).slice(0, 200) });
    return null;
  }
}

/**
 * Resolves anchor buffers to `image_urls` values.
 *
 * Never throws and never returns partial garbage — on total failure it returns
 * an empty array, and the caller generates without references. Anchors are a
 * quality nicety; the identity card in the prompt still carries the persona, so
 * losing them must not cost us the post.
 */
export async function resolveFalReferences(buffers: Buffer[]): Promise<string[]> {
  const mode = getFalReferenceMode();
  if (mode === 'off' || buffers.length === 0) return [];

  if (mode === 'datauri') {
    return buffers.map((buf) => `data:${sniffMime(buf)};base64,${buf.toString('base64')}`);
  }

  const results = await Promise.all(buffers.map((buf) => uploadOne(buf)));
  const urls = results.filter((u): u is string => typeof u === 'string' && u.startsWith('http'));

  if (urls.length < buffers.length) {
    logger.warn('Some style anchors could not be uploaded to fal CDN', {
      uploaded: urls.length, total: buffers.length,
    });
  }
  // All-or-nothing for model quality: a partial set still works, but returning
  // only successful https URLs avoids feeding garbage into image_urls.
  return urls;
}

/** How many of these anchors are already cached — used by the probe. */
export function countCachedAnchors(buffers: Buffer[]): number {
  const ttlDays = getFalUploadTtlDays();
  return buffers.filter((buf) => {
    const url = lookupUpload(PROVIDER, hashBuffer(buf), ttlDays);
    return typeof url === 'string' && url.startsWith('http');
  }).length;
}
