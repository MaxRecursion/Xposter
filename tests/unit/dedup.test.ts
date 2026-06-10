import { describe, expect, it, vi } from 'vitest';
import { generateDistinct } from '../../src/pipeline/dedup.js';

describe('generateDistinct', () => {
  it('regenerates once after a duplicate and returns the fresh draft', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce('Pune traffic has impeccable timing.')
      .mockResolvedValueOnce('Baner rush hour is applying for permanent residency.');
    const onDuplicate = vi.fn();

    const result = await generateDistinct({
      existingTexts: ['Pune traffic has impeccable timing.'],
      generate,
      getText: (value) => value,
      onDuplicate,
    });

    expect(result).toEqual({
      value: 'Baner rush hour is applying for permanent residency.',
      attempts: 2,
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(onDuplicate).toHaveBeenCalledTimes(1);
  });

  it('returns null when both drafts duplicate recent content', async () => {
    const generate = vi.fn().mockResolvedValue('PMC drainage is an annual group project.');

    const result = await generateDistinct({
      existingTexts: ['PMC drainage is an annual group project.'],
      generate,
      getText: (value) => value,
    });

    expect(result).toEqual({ value: null, attempts: 2 });
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
