import { describe, expect, it, afterEach } from 'vitest';
import {
  extractImage, geminiImageSize, geminiModel, nearestAspectRatio, priceFor,
} from '../../src/images/providers/gemini.js';

describe('extractImage', () => {
  it('reads the documented output_image.data path', () => {
    expect(extractImage({ output_image: { data: 'QUJD', mime_type: 'image/jpeg' } })).toBe('QUJD');
  });

  it('falls back to the steps log when output_image is absent', () => {
    // Belt and braces: the interaction also carries a steps array that can hold
    // the payload, so a shape change on one path doesn't break generation.
    const body = { steps: [{ content: [{ type: 'text' }, { type: 'image', data: 'WFla' }] }] };
    expect(extractImage(body)).toBe('WFla');
  });

  it('prefers output_image when both are present', () => {
    const body = {
      output_image: { data: 'PRIMARY' },
      steps: [{ content: [{ type: 'image', data: 'SECONDARY' }] }],
    };
    expect(extractImage(body)).toBe('PRIMARY');
  });

  it('returns null when there is no image anywhere', () => {
    expect(extractImage({})).toBeNull();
    expect(extractImage({ steps: [] })).toBeNull();
    expect(extractImage({ steps: [{ content: [{ type: 'text' }] }] })).toBeNull();
    expect(extractImage({ output_image: { data: '' } })).toBeNull();
  });
});

describe('nearestAspectRatio', () => {
  it('maps our 640x800 portrait to 4:5 exactly', () => {
    expect(nearestAspectRatio(640, 800)).toBe('4:5');
  });

  it('maps a square to 1:1', () => {
    expect(nearestAspectRatio(1024, 1024)).toBe('1:1');
  });

  it('snaps an unsupported ratio to the closest supported one', () => {
    expect(nearestAspectRatio(1000, 1250)).toBe('4:5');
    expect(nearestAspectRatio(1920, 1080)).toBe('16:9');
  });
});

describe('priceFor', () => {
  it('knows the published per-image prices', () => {
    expect(priceFor('gemini-3.1-flash-image', '1K')).toBe(0.067);
    expect(priceFor('gemini-3-pro-image', '1K')).toBe(0.134);
    expect(priceFor('gemini-3.1-flash-image', '4K')).toBe(0.151);
  });

  it('charges the most expensive known rate for an unknown model', () => {
    // An unpriced model must never look free, or it slips past the budget guard.
    expect(priceFor('some-future-model', '1K')).toBe(0.24);
    expect(priceFor('gemini-3.1-flash-image', '8K')).toBe(0.24);
  });
});

describe('model/size resolution', () => {
  const orig = { m: process.env.GEMINI_IMAGE_MODEL, s: process.env.GEMINI_IMAGE_SIZE };
  afterEach(() => {
    if (orig.m === undefined) delete process.env.GEMINI_IMAGE_MODEL; else process.env.GEMINI_IMAGE_MODEL = orig.m;
    if (orig.s === undefined) delete process.env.GEMINI_IMAGE_SIZE; else process.env.GEMINI_IMAGE_SIZE = orig.s;
  });

  it('defaults to flash-image at 1K — the cheapest tier that supports references', () => {
    delete process.env.GEMINI_IMAGE_MODEL;
    delete process.env.GEMINI_IMAGE_SIZE;
    expect(geminiModel()).toBe('gemini-3.1-flash-image');
    expect(geminiImageSize()).toBe('1K');
  });

  it('honours env overrides', () => {
    process.env.GEMINI_IMAGE_MODEL = 'gemini-3-pro-image';
    process.env.GEMINI_IMAGE_SIZE = '2K';
    expect(geminiModel()).toBe('gemini-3-pro-image');
    expect(priceFor(geminiModel(), geminiImageSize())).toBe(0.134);
  });

  it('ignores an empty override', () => {
    process.env.GEMINI_IMAGE_MODEL = '   ';
    expect(geminiModel()).toBe('gemini-3.1-flash-image');
  });
});
