import { describe, expect, it } from 'vitest';
import { classifyPostingError, PostingError } from '../../src/pipeline/errors.js';

describe('classifyPostingError', () => {
  it('treats compose and timeout failures as transient', () => {
    expect(classifyPostingError(new Error('Compose box not found after clicking reply')).transient)
      .toBe(true);
    expect(classifyPostingError(new Error('page.goto: Timeout 30000ms exceeded')).transient)
      .toBe(true);
  });

  it('treats a deleted source tweet as permanent', () => {
    const failure = classifyPostingError(new Error('This post is unavailable because it was deleted'));
    expect(failure).toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
      transient: false,
    });
  });

  it('preserves typed posting failures', () => {
    const original = new PostingError('submit missing', 'SUBMIT_NOT_FOUND', true);
    expect(classifyPostingError(original)).toBe(original);
  });
});
