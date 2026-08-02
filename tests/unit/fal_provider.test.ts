import { describe, expect, it, afterEach } from 'vitest';
import {
  baseModelOf, buildRequestBody, classifyError, decodeDataUri, editModelFor,
  endpointFor, extractDescription, extractImageUrl, nearestFalAspect, priceFor,
  resolveAspect, sniffMime,
} from '../../src/images/providers/fal.js';
import { ANCHOR_PROMPT_NOTE, stripAnchorNote } from '../../src/images/anchors.js';
import { extractUploadTarget, extractUploadedUrl } from '../../src/images/providers/fal_references.js';
import type { GenerateRequest } from '../../src/images/providers/types.js';

function req(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return { prompt: 'a quiet balcony', width: 640, height: 800, seed: 42, ...overrides };
}

const ENV_KEYS = ['FAL_IMAGE_MODEL', 'FAL_IMAGE_RESOLUTION', 'FAL_IMAGE_EDIT_MODEL', 'FAL_REFERENCE_MODE'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('priceFor', () => {
  it('knows the published nano-banana-2 rates by resolution', () => {
    expect(priceFor('fal-ai/nano-banana-2', '0.5K')).toBe(0.06);
    expect(priceFor('fal-ai/nano-banana-2', '1K')).toBe(0.08);
    expect(priceFor('fal-ai/nano-banana-2', '2K')).toBe(0.12);
    expect(priceFor('fal-ai/nano-banana-2', '4K')).toBe(0.16);
  });

  it('charges the edit endpoint at the base model rate', () => {
    expect(priceFor('fal-ai/nano-banana-2/edit', '1K')).toBe(0.08);
  });

  it('uses a flat rate for models that ignore resolution', () => {
    // Without the ':*' tier, FAL_IMAGE_RESOLUTION=2K would bill a $0.003 call
    // at the 2K rate.
    expect(priceFor('fal-ai/flux/schnell', '2K')).toBe(0.003);
    expect(priceFor('fal-ai/flux-pro/kontext', '4K')).toBe(0.04);
  });

  it('charges an unknown model at the highest known rate', () => {
    // Asserted as a literal on purpose: adding a pricier model to the table
    // fails this test and forces a deliberate re-read.
    expect(priceFor('fal-ai/some-future-model', '1K')).toBe(0.16);
    expect(priceFor('fal-ai/nano-banana-2', '8K')).toBe(0.16);
  });
});

describe('buildRequestBody', () => {
  const body = () => buildRequestBody(req(), { resolution: '1K' });

  it('pins the cost levers', () => {
    expect(body().num_images).toBe(1);
    expect(body().enable_web_search).toBe(false);
  });

  it('requests the bytes inline so no billed call can be lost to a failed download', () => {
    expect(body().sync_mode).toBe(true);
  });

  it('requests jpeg because the file is always written as .jpg', () => {
    expect(body().output_format).toBe('jpeg');
  });

  it('maps our portrait geometry to 4:5 and echoes seed + resolution', () => {
    expect(body().aspect_ratio).toBe('4:5');
    expect(body().resolution).toBe('1K');
    expect(body().seed).toBe(42);
  });

  it('omits image_urls entirely when there are no references', () => {
    expect('image_urls' in body()).toBe(false);
  });

  it('includes image_urls when references are supplied', () => {
    const withRefs = buildRequestBody(req(), { resolution: '1K', imageUrls: ['https://a', 'https://b'] });
    expect(withRefs.image_urls).toEqual(['https://a', 'https://b']);
  });

  it('sends no safety_tolerance — the 1-vs-6 polarity is unverified', () => {
    expect('safety_tolerance' in body()).toBe(false);
    expect('thinking_level' in body()).toBe(false);
  });
});

describe('aspect ratio', () => {
  it('maps 640x800 to 4:5', () => {
    expect(nearestFalAspect(640, 800)).toBe('4:5');
  });

  it('maps square and widescreen correctly', () => {
    expect(nearestFalAspect(1024, 1024)).toBe('1:1');
    expect(nearestFalAspect(1920, 1080)).toBe('16:9');
  });

  it('passes a valid requested ratio through', () => {
    expect(resolveAspect('4:5', 1024, 1024)).toBe('4:5');
  });

  it('falls back to the nearest when the request is garbage', () => {
    expect(resolveAspect('wide', 640, 800)).toBe('4:5');
    expect(resolveAspect('0:0', 640, 800)).toBe('4:5');
    expect(resolveAspect(undefined, 640, 800)).toBe('4:5');
  });

  it('never returns "auto"', () => {
    for (const [w, h] of [[1, 9], [9, 1], [640, 800], [3, 2]]) {
      expect(resolveAspect(undefined, w, h)).not.toBe('auto');
    }
  });
});

describe('response parsing', () => {
  it('extracts the image url', () => {
    expect(extractImageUrl({ images: [{ url: 'data:image/jpeg;base64,QUJD' }] })).toBe('data:image/jpeg;base64,QUJD');
  });

  it('returns null when there is no usable url', () => {
    expect(extractImageUrl({})).toBeNull();
    expect(extractImageUrl({ images: [] })).toBeNull();
    expect(extractImageUrl({ images: [{ url: '' }] })).toBeNull();
  });

  it('extracts an optional description', () => {
    expect(extractDescription({ description: 'a balcony' })).toBe('a balcony');
    expect(extractDescription({})).toBeUndefined();
    expect(extractDescription({ description: '' })).toBeUndefined();
  });
});

describe('decodeDataUri', () => {
  it('decodes a base64 data URI', () => {
    const out = decodeDataUri('data:image/jpeg;base64,QUJD');
    expect(out?.buffer.toString()).toBe('ABC');
    expect(out?.contentType).toBe('image/jpeg');
  });

  it('returns null for an https url so the download path is taken', () => {
    expect(decodeDataUri('https://fal.media/files/abc.jpg')).toBeNull();
  });

  it('returns null for malformed or empty data URIs', () => {
    expect(decodeDataUri('data:image/jpeg;base64,')).toBeNull();
    expect(decodeDataUri('not a uri')).toBeNull();
  });
});

describe('editModelFor', () => {
  it('derives the edit sibling for a model known to have one', () => {
    expect(editModelFor('fal-ai/nano-banana-2')).toBe('fal-ai/nano-banana-2/edit');
  });

  it('returns null rather than guessing for other models', () => {
    // A blind `${model}/edit` is wrong on fal — flux-pro/kontext takes a
    // singular `image_url` — and a wrong endpoint is a billed failure.
    expect(editModelFor('fal-ai/flux/schnell')).toBeNull();
    expect(editModelFor('fal-ai/flux-pro/kontext')).toBeNull();
  });

  it('honours an explicit override', () => {
    process.env.FAL_IMAGE_EDIT_MODEL = 'fal-ai/custom/edit';
    expect(editModelFor('fal-ai/flux/schnell')).toBe('fal-ai/custom/edit');
  });
});

describe('baseModelOf / endpointFor', () => {
  it('strips a trailing /edit', () => {
    expect(baseModelOf('fal-ai/nano-banana-2/edit')).toBe('fal-ai/nano-banana-2');
    expect(baseModelOf('fal-ai/nano-banana-2')).toBe('fal-ai/nano-banana-2');
  });

  it('builds the sync endpoint url', () => {
    expect(endpointFor('fal-ai/nano-banana-2/edit')).toBe('https://fal.run/fal-ai/nano-banana-2/edit');
  });
});

describe('classifyError', () => {
  const httpErr = (status: number) => ({ response: { status } });
  const codeErr = (code: string) => ({ code });

  it('retries rate limits and server errors', () => {
    expect(classifyError(httpErr(429))).toBe('retry');
    expect(classifyError(httpErr(500))).toBe('retry');
    expect(classifyError(httpErr(503))).toBe('retry');
  });

  it('treats other 4xx as fatal — retrying just re-rejects', () => {
    expect(classifyError(httpErr(400))).toBe('fatal');
    expect(classifyError(httpErr(401))).toBe('fatal');
    expect(classifyError(httpErr(422))).toBe('fatal');
  });

  it('treats timeouts as billed so one image is never paid for three times', () => {
    expect(classifyError(codeErr('ECONNABORTED'))).toBe('billed');
    expect(classifyError(codeErr('ETIMEDOUT'))).toBe('billed');
  });

  it('retries failures that never reached fal', () => {
    expect(classifyError(codeErr('ENOTFOUND'))).toBe('retry');
    expect(classifyError(codeErr('ECONNREFUSED'))).toBe('retry');
  });
});

describe('sniffMime', () => {
  it('detects png, jpeg and webp from magic bytes', () => {
    expect(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe('image/webp');
  });

  it('defaults to jpeg for unrecognised bytes', () => {
    expect(sniffMime(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBe('image/jpeg');
  });
});

describe('stripAnchorNote', () => {
  it('removes the note so we never describe images the model did not receive', () => {
    const base = 'A quiet balcony at dawn.';
    expect(stripAnchorNote(`${base}\n\n${ANCHOR_PROMPT_NOTE}`)).toBe(base);
  });

  it('is a no-op when the note is absent', () => {
    expect(stripAnchorNote('A quiet balcony at dawn.')).toBe('A quiet balcony at dawn.');
  });
});

describe('extractUploadedUrl', () => {
  it('accepts the plausible response shapes', () => {
    expect(extractUploadedUrl({ file_url: 'https://c' })).toBe('https://c');
    expect(extractUploadedUrl({ access_url: 'https://a' })).toBe('https://a');
    expect(extractUploadedUrl({ url: 'https://b' })).toBe('https://b');
    expect(extractUploadedUrl({ data: { url: 'https://d' } })).toBe('https://d');
  });

  it('rejects non-http values and empty bodies', () => {
    expect(extractUploadedUrl({ url: 'not-a-url' })).toBeNull();
    expect(extractUploadedUrl({})).toBeNull();
    expect(extractUploadedUrl(null)).toBeNull();
    // serverless /data upload returns a bare boolean — not a CDN URL
    expect(extractUploadedUrl(true)).toBeNull();
  });
});

describe('extractUploadTarget', () => {
  it('requires both upload_url and a public file_url from CDN initiate', () => {
    expect(extractUploadTarget({
      upload_url: 'https://v3-uploads.fal.media/put',
      file_url: 'https://v3.fal.media/files/abc/anchor.jpg',
    })).toEqual({
      uploadUrl: 'https://v3-uploads.fal.media/put',
      fileUrl: 'https://v3.fal.media/files/abc/anchor.jpg',
    });
  });

  it('rejects incomplete initiate responses', () => {
    expect(extractUploadTarget({ upload_url: 'https://x' })).toBeNull();
    expect(extractUploadTarget({ file_url: 'https://x' })).toBeNull();
    expect(extractUploadTarget(true)).toBeNull();
  });
});
