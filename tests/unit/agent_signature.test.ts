import { describe, it, expect } from 'vitest';
import { errorSignature, normalizeDetail } from '../../src/agent/signature.js';

describe('errorSignature', () => {
  it('collapses UUIDs to a stable form', () => {
    const a = errorSignature(
      'POST_ERROR',
      'Reply post failed for id=11111111-2222-3333-4444-555555555555',
    );
    const b = errorSignature(
      'POST_ERROR',
      'Reply post failed for id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    );
    expect(a).toBe(b);
  });

  it('collapses timestamps + numeric ids', () => {
    const a = errorSignature(
      'CANDIDATE_ERROR',
      'tweet_id=1234567890123456 at 2026-05-17T08:00:00Z failed',
    );
    const b = errorSignature(
      'CANDIDATE_ERROR',
      'tweet_id=9876543210987654 at 2026-05-18T09:30:42Z failed',
    );
    expect(a).toBe(b);
  });

  it('collapses absolute paths from /Users and /home', () => {
    const a = errorSignature('PIPELINE_ERROR', 'Error in /Users/alice/proj/src/foo.ts');
    const b = errorSignature('PIPELINE_ERROR', 'Error in /home/bob/proj/src/foo.ts');
    expect(a).toBe(b);
  });

  it('treats structurally different errors as distinct', () => {
    const a = errorSignature('PIPELINE_ERROR', 'browser timed out on x.com');
    const b = errorSignature('PIPELINE_ERROR', 'Groq API returned empty completion');
    expect(a).not.toBe(b);
  });

  it('different event names always produce different signatures', () => {
    const detail = 'some detail';
    expect(errorSignature('POST_ERROR', detail)).not.toBe(errorSignature('NOTIFICATION_FAILED', detail));
  });

  it('handles null detail without crashing', () => {
    expect(() => errorSignature('PIPELINE_ERROR', null)).not.toThrow();
    expect(errorSignature('PIPELINE_ERROR', null)).toBe(errorSignature('PIPELINE_ERROR', undefined));
  });

  it('normalizes long quoted strings', () => {
    // Use a non-hex character so the hex-pattern regex doesn't pre-empt the quote rule.
    const long = 'z'.repeat(120);
    const norm = normalizeDetail(`error: "${long}"`);
    expect(norm).toContain('…');
    expect(norm.length).toBeLessThan(120);
  });

  it('returns short hex of stable length', () => {
    const sig = errorSignature('PIPELINE_ERROR', 'something');
    expect(sig).toMatch(/^[0-9a-f]{16}$/);
  });
});
